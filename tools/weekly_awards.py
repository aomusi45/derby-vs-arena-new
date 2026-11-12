#!/usr/bin/env python3
"""Permanent, idempotent Monday-Sunday JST ranking and weekly representative.

Receipts are create-only and updated atomically with per-horse prize counters.
Rankings use Firestore, never the 24h GitHub replay retention. Winning horses
are archived permanently; no private Firebase UID or horseKey is published.
"""
from __future__ import annotations
import hashlib
import math
import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen
import registered_horses

ROOT=Path(__file__).resolve().parents[1]
PROJECT=registered_horses.PROJECT_ID
BASE=f'projects/{PROJECT}/databases/(default)/documents'
API='https://firestore.googleapis.com/v1/'
JST=timezone(timedelta(hours=9))
SLOT_MS=900_000
COMPLETE_DELAY_MS=30_000


def week_start(dt):
    local=dt.astimezone(JST)
    return (local.date()-timedelta(days=local.weekday())).isoformat()


def make_id(row):
    public=row.get('rankingId')
    if isinstance(public,str) and len(public)==34 and public[:2] in ('p_','c_') and all(c in '0123456789abcdef' for c in public[2:]):
        return public
    # Legacy 24-hour records have no per-horse IDs; preserve their public owner
    # when available, and never mix player and COM with an identical name.
    name=row['name']
    owner=row.get('ownerName','') or ''
    src='legacy-player|'+owner+'|'+name if owner else 'com|'+name
    if not owner: src='com|'+name
    prefix='p_' if owner else 'c_'
    return prefix+hashlib.sha256(src.encode()).hexdigest()[:32]


def as_value(v):
    if isinstance(v,str):return {'stringValue':v}
    if isinstance(v,bool):return {'booleanValue':v}
    if isinstance(v,int) and not isinstance(v,bool):return {'integerValue':str(v)}
    if isinstance(v,float) and math.isfinite(v):return {'doubleValue':v}
    if isinstance(v,dict):return {'mapValue':{'fields':{k:as_value(x) for k,x in v.items()}}}
    raise ValueError('invalid firestore value')


def fields(d):return {k:as_value(v) for k,v in d.items()}


def request(token,url,body=None):
    data=json.dumps(body,ensure_ascii=False,separators=(',',':')).encode() if body is not None else None
    headers={'Authorization':'Bearer '+token,'Accept':'application/json'}
    if data is not None:headers['Content-Type']='application/json'
    req=Request(API+url,data=data,headers=headers,method='POST' if data is not None else 'GET')
    with urlopen(req,timeout=35) as resp:return json.load(resp)


def doc_get(token,path):
    try:return request(token,quote(BASE+'/'+path,safe='/()'))
    except HTTPError as e:
        if e.code==404:return None
        raise


def list_docs(token,path):
    out=[];page=None
    while True:
        qs={'pageSize':'500'}
        if page:qs['pageToken']=page
        data=request(token,quote(BASE+'/'+path,safe='/()')+'?'+urlencode(qs))
        out.extend(data.get('documents',[]))
        page=data.get('nextPageToken')
        if not page:break
        if len(out)>10000:raise RuntimeError('年間記録が読み取り上限を超えました')
    return out


def commit(token,writes):
    if len(writes)>500:raise ValueError('too many writes')
    return request(token,f'projects/{PROJECT}/databases/(default)/documents:commit',{'writes':writes})


def race_rows(meta):
    if meta.get('intervalMinutes')!=15 or type(meta.get('slot')) is not int:
        return []
    first=meta.get('firstPrizeYen')
    if not isinstance(first,int) or first<=0:raise ValueError('1着賞金が不正です')
    result=meta.get('results',[])
    if not isinstance(result,list) or not 2<=len(result)<=18:raise ValueError('着順データが不正です')
    from scheduled_vs import price_for
    rows=[];seen=set()
    for place,row in enumerate(result,1):
        if row.get('place')!=place or type(row.get('prizeYen')) is not int or row['prizeYen']!=price_for(place,{'firstPrizeYen':first}):
            raise ValueError('実際のレース賞金との不一致')
        name=row.get('name')
        owner=row.get('ownerName','') or ''
        if not isinstance(name,str) or not name or len(name)>60 or not isinstance(owner,str) or len(owner)>24:
            raise ValueError('賞金対象の馬名・オーナー名が不正です')
        identity=make_id(row)
        if identity in seen:raise ValueError('同じ馬が1レースに重複しています')
        seen.add(identity)
        rows.append({'rankingId':identity,'horseName':name,'ownerName':owner,
                     'isCom':identity.startswith('c_'),'place':place,'prizeYen':row['prizeYen']})
    return rows


def update_com(token,row,slot):
    path='vs_com_career/'+row['rankingId']
    previous=doc_get(token,path)
    if previous:
        raw=previous.get('fields',{})
        old_count=int(raw['count']['integerValue'])
        old_prize=int(raw.get('cyclePrize',{}).get('integerValue','0'))
        last_slot=int(raw.get('lastSlot',{}).get('integerValue','0'))
        if slot<=last_slot:
            # A delayed GitHub Actions recovery may publish an older heat
            # after a newer one. Never drop its official start/prize.
            print('WARNING: late COM heat integrated:',slot,'after',last_slot,flush=True)
    else:old_count=old_prize=0
    total=old_prize+row['prizeYen'];count=old_count+1
    completed=(count%20==0)
    new={'name':BASE+'/'+path,'fields':fields({
        'horseName':row['horseName'],'count':count,'cyclePrize':0 if completed else total,
        'lastCompletedCyclePrize':total if completed else (int(previous.get('fields',{}).get('lastCompletedCyclePrize',{}).get('integerValue','0')) if previous else 0),
        'lastSlot':max(slot,last_slot if previous else 0)})}
    return {'update':new,'currentDocument':{'updateTime':previous['updateTime']} if previous else {'exists':False}}


def commit_race(token,meta):
    rows=race_rows(meta)
    if not rows:return False
    slot=meta['slot']
    week=week_start(datetime.fromtimestamp(slot*SLOT_MS/1000,timezone.utc))
    receipt_path=f'vs_weekly_race_receipts/{slot}'
    digest=hashlib.sha256(json.dumps(rows,ensure_ascii=False,sort_keys=True).encode()).hexdigest()
    prior=doc_get(token,receipt_path)
    if prior:
        if prior['fields'].get('digest',{}).get('stringValue')!=digest:
            raise RuntimeError('同じ開催枠の賞金記録が変更されました。再加算を中止します')
        return False
    writes=[{'update':{'name':BASE+'/'+receipt_path,'fields':fields({
        'slot':slot,'weekStart':week,'digest':digest})},'currentDocument':{'exists':False}}]
    for row in rows:
        path=f'vs_weekly_horses/{week}/horses/{row["rankingId"]}'
        current={'horseName':row['horseName'],'ownerName':row['ownerName'],'isCom':row['isCom'],
                 'weekStart':week,'rankingId':row['rankingId']}
        writes.append({'update':{'name':BASE+'/'+path,'fields':fields(current)},
            'updateMask':{'fieldPaths':list(current)},
            'updateTransforms':[
                {'fieldPath':'prizeYen','increment':{'integerValue':str(row['prizeYen'])}},
                {'fieldPath':'starts','increment':{'integerValue':'1'}},
                *([{'fieldPath':f'places.p{row["place"]}','increment':{'integerValue':'1'}}] if 1<=row['place']<=5 else [])]})
        if row['isCom']:
            writes.append(update_com(token,row,slot))
    try:
        commit(token,writes)
    except HTTPError as e:
        if e.code in (409,412):
            recorded=doc_get(token,receipt_path)
            if recorded and recorded['fields'].get('digest',{}).get('stringValue')==digest:
                return False
        raise
    return True


def ranking(token,week):
    docs=list_docs(token,f'vs_weekly_horses/{week}/horses')
    result=[]
    for doc in docs:
        f=doc.get('fields',{})
        prizes=int(f.get('prizeYen',{}).get('integerValue','0'))
        if prizes<0:raise ValueError('週間賞金の数値が不正です')
        places=f.get('places',{}).get('mapValue',{}).get('fields',{})
        counts=[int(places.get('p'+str(i),{}).get('integerValue','0')) for i in range(1,6)]
        result.append({'horseName':f['horseName']['stringValue'],
            'ownerName':f['ownerName']['stringValue'],'prizeYen':prizes,
            'rankingId':f['rankingId']['stringValue'],
            'starts':int(f.get('starts',{}).get('integerValue','0')),'places':counts})
    return sorted(result,key=lambda h:(-h['prizeYen'],*[-n for n in h['places']],h['horseName'],h['ownerName'],h['rankingId']))


def award_calendar(week):
    """Label by the Monday's month and count its Mondays from the 1st."""
    monday=datetime.fromisoformat(week).date()
    nth=(monday.day-1)//7+1
    return {'awardYear':monday.year,'awardMonth':monday.month,
            'awardWeekOfMonth':nth,
            'awardWeekLabel':f'{monday.year}年{monday.month}月第{nth}週'}


def sealed_champion_source(token,week,winner,record):
    """Read source privately; do not put envelope or roster in public awards."""
    identity=winner['rankingId']
    if not identity.startswith('p_'):
        return None,'com'
    stage=doc_get(token,'vs_weekly_candidate_payloads/'+identity)
    if stage is None:
        # Old registrations made before this feature have no original file.
        # The official prize winner is still awarded, but falsely claiming the
        # replay is available would hide an unrecoverable source file.
        print('WARNING: champion has no encrypted source (legacy enrollment):',week,identity,flush=True)
        return None,'missing'
    f=stage.get('fields',{})
    expected={'weekStart':week,'rankingId':identity,'horseName':winner['horseName'],
              'ownerName':winner['ownerName']}
    if any(f.get(k,{}).get('stringValue')!=v for k,v in expected.items()):
        raise ValueError('受賞馬の非公開登録データが週間賞金記録と一致しません')
    sealed=f.get('sourceEnvelope',{}).get('mapValue',{}).get('fields',{})
    if (sealed.get('format',{}).get('stringValue')!='derby-fantasy-vs-sealed' or
        sealed.get('version',{}).get('integerValue')!='2' or
        sealed.get('cipher',{}).get('stringValue')!='AES-256-GCM' or
        not sealed.get('data',{}).get('stringValue')):
        raise ValueError('暗号化された受賞馬データが不正です')
    roster=f.get('roster',{}).get('mapValue',{}).get('fields',{})
    if not roster or roster.get('name',{}).get('stringValue')!=winner['horseName']:
        raise ValueError('受賞馬の走行データが不正です')
    # Protect complete sealed upload and the validated immutable runner as a
    # private, versioned document so future special races can reproduce the horse
    # without using the player's current registration or decrypting in a browser.
    target={'name':BASE+'/vs_champion_horse_archives/'+week,
            'fields':{**fields({**record,'archiveVersion':1,'sourceFormat':'derby-fantasy-vs-sealed'}),
                      'sourceEnvelope':f['sourceEnvelope'],
                      'runner':f['roster']}}
    return {'update':target,'currentDocument':{'exists':False}},'encrypted'


def cleanup_weekly_candidates(token,current_week,now):
    """Only remove old non-champion staging after the award is safely written.

    Archival write and public award use the same atomic commit. Keeping one
    additional week of temporary source gives the operator a recovery window.
    """
    local=now.astimezone(JST)
    # This job runs every 15 minutes; scan up to 120 source documents only
    # early each Monday, never 96 times/day on the free Firestore quota.
    if local.weekday()!=0 or local.hour>=3:return 0
    stale_before=(datetime.fromisoformat(current_week).date()-timedelta(days=7)).isoformat()
    docs=list_docs(token,'vs_weekly_candidate_payloads')
    removed=0
    for doc in docs:
        f=doc.get('fields',{})
        week=f.get('weekStart',{}).get('stringValue','')
        if not (len(week)==10 and week < stale_before):continue
        award=doc_get(token,'vs_weekly_awards/'+week)
        if not award:continue
        state=award.get('fields',{}).get('archiveStatus',{}).get('stringValue','')
        if state=='encrypted':
            if not doc_get(token,'vs_champion_horse_archives/'+week):continue
        elif state!='com':
            continue
        name=doc.get('name','')
        version=doc.get('updateTime','')
        if not name.startswith(BASE+'/vs_weekly_candidate_payloads/') or not version:
            raise ValueError('一時保管データの削除対象が不正です')
        from urllib.parse import urlencode
        req=Request(API+quote(name,safe='/()')+'?'+urlencode({'currentDocument.updateTime':version}),
                    headers={'Authorization':'Bearer '+token},method='DELETE')
        try:
            with urlopen(req,timeout=30):pass
            removed+=1
        except HTTPError as exc:
            if exc.code not in (404,409,412):raise
    return removed


def award_previous(token,current_week,now):
    monday=datetime.fromisoformat(current_week).replace(tzinfo=JST)
    # Allow for GitHub Actions scheduling delays and Sunday's final result.
    if now.astimezone(JST)<monday+timedelta(minutes=30):return
    past_week=(monday-timedelta(days=7)).date().isoformat()
    if past_week<'2026-11-09':return
    award_path=f'vs_weekly_awards/{past_week}'
    if doc_get(token,award_path):return
    board=ranking(token,past_week)
    if not board:return
    seq_path='vs_weekly_award_index/main'
    seq=doc_get(token,seq_path)
    n=int(seq.get('fields',{}).get('generation',{}).get('integerValue','0')) if seq else 0
    winner=board[0]
    record={'weekStart':past_week,'weekEnd':(monday-timedelta(days=1)).date().isoformat(),
            'generation':n+1,'horseName':winner['horseName'],
            'ownerName':winner['ownerName'],'prizeYen':winner['prizeYen'],
            'rankingId':winner['rankingId'],**award_calendar(past_week)}
    source_write,status=sealed_champion_source(token,past_week,winner,record)
    record['archiveStatus']=status
    record['hasReplayHorse']=status=='encrypted'
    writes=[{'update':{'name':BASE+'/'+award_path,'fields':fields(record)},
             'currentDocument':{'exists':False}},
            {'update':{'name':BASE+'/'+seq_path,'fields':fields({'generation':n+1,'lastWeekStart':past_week})},
             'currentDocument':{'updateTime':seq['updateTime']} if seq else {'exists':False}}]
    if source_write is not None:writes.append(source_write)
    try:commit(token,writes)
    except HTTPError as e:
        if e.code in (409,412) and doc_get(token,award_path):return
        raise
    print('Archived weekly champion:',past_week,record['generation'],winner['horseName'],flush=True)


def archive(token):
    result=[]
    for doc in list_docs(token,'vs_weekly_awards'):
        f=doc.get('fields',{})
        item={k: (int(f[k]['integerValue']) if k in ('generation','prizeYen') else f[k]['stringValue'])
            for k in ('weekStart','weekEnd','generation','horseName','ownerName','prizeYen')}
        cal=award_calendar(item['weekStart'])
        item.update(cal)
        item['hasReplayHorse']=f.get('hasReplayHorse',{}).get('booleanValue',False)
        result.append(item)
    return sorted(result,key=lambda r:r['generation'],reverse=True)


def public_board(token,now):
    current=week_start(now)
    result={'version':1,'timezone':'Asia/Tokyo','weekStart':current,
            'weekEnd':(datetime.fromisoformat(current)+timedelta(days=6)).date().isoformat(),
            'top10':[{k:v for k,v in row.items() if k in ('horseName','ownerName','prizeYen','starts')}
                     for row in ranking(token,current)[:10]],
            'awards':archive(token)}
    return result


def main():
    secret=os.getenv('FIREBASE_SERVICE_ACCOUNT_JSON','').strip()
    if not secret:raise RuntimeError('Firebase秘密情報がありません。賞金集計は省略できません')
    token=registered_horses._access_token(secret)
    raw=json.loads((ROOT/'race_playlist.json').read_text(encoding='utf-8'))
    if raw.get('version')!=2:raise ValueError('開催一覧が不正です')
    count=0
    for meta in sorted(raw['records'],key=lambda x:x['slot']):
        if commit_race(token,meta):count+=1
    now=datetime.now(timezone.utc)
    award_previous(token,week_start(now),now)
    # Staging is not a permanent archive. Cleanup failures should never stop
    # the racing cycle or break a successfully stored championship.
    try:
        removed=cleanup_weekly_candidates(token,week_start(now),now)
        if removed:print('Old private weekly candidates cleaned:',removed,flush=True)
    except Exception as exc:
        print('WARNING: private candidate cleanup deferred:',str(exc),flush=True)
    board=public_board(token,now)
    (ROOT/'weekly_awards.json').write_text(json.dumps(board,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(f'Weekly races newly counted={count}, current TOP10={len(board["top10"])}, lifetime awards={len(board["awards"])}',flush=True)


if __name__=='__main__':main()
