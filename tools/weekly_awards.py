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
    if isinstance(v,list):return {'arrayValue':{'values':[as_value(x) for x in v]}}
    raise ValueError('invalid firestore value')


def fields(d):return {k:as_value(v) for k,v in d.items()}


def read_history(value):
    """Decode published result fields only; missing historical data stays missing."""
    if value is None:return []
    if not isinstance(value,dict) or not isinstance(value.get('arrayValue'),dict):
        raise ValueError('保存された戦歴の形式が不正です')
    values=value['arrayValue'].get('values',[])
    if not isinstance(values,list) or len(values)>20:
        raise ValueError('戦歴は20戦までです')
    rows=[]
    for item in values:
        f=item.get('mapValue',{}).get('fields',{})
        if not isinstance(f,dict):raise ValueError('戦歴データが不正です')
        try:
            slot=int(f['slot']['integerValue'])
            name=f['raceName']['stringValue']
            place=int(f['place']['integerValue'])
            prize=int(f['prizeYen']['integerValue'])
        except (KeyError,TypeError,ValueError) as exc:
            raise ValueError('戦歴データの項目が不正です') from exc
        if (slot<0 or not isinstance(name,str) or not 0<len(name)<=100 or
                not 1<=place<=18 or prize<0):
            raise ValueError('戦歴データの値が不正です')
        record={'slot':slot,'raceName':name,'place':place,'prizeYen':prize}
        # V33 public top-two details; absent older fields are not manufactured.
        for key,limit in (('firstHorseName',60),('secondHorseName',60),
                          ('firstOwnerName',24),('secondOwnerName',24),
                          ('firstSecondMargin',40)):
            item_value=f.get(key)
            if item_value is None:continue
            text_value=item_value.get('stringValue') if isinstance(item_value,dict) else None
            if not isinstance(text_value,str) or len(text_value)>limit:
                raise ValueError('戦歴の1・2着情報が不正です')
            if key.endswith('HorseName') and not text_value:
                raise ValueError('戦歴の馬名が空です')
            record[key]=text_value
        rows.append(record)
    if len({r['slot'] for r in rows})!=len(rows):
        raise ValueError('同じ開催枠の戦歴が重複しています')
    return sorted(rows,key=lambda r:r['slot'])


def top_two_public_result(meta):
    """Public 1st/2nd context from actual official results (2nd margin = gap).

    Never infer missing names, owners, or margins from time differences.
    An empty, explicitly recorded owner name means a COM horse.
    """
    results=meta.get('results',[])
    if not isinstance(results,list) or len(results)<2:return {}
    first,second=results[:2]
    if not isinstance(first,dict) or not isinstance(second,dict):return {}
    if first.get('place')!=1 or second.get('place')!=2:return {}
    data={}
    for prefix,row in (('first',first),('second',second)):
        name=row.get('name')
        if isinstance(name,str) and 0<len(name)<=60:
            data[prefix+'HorseName']=name
        # Explicit empty-string owner is a known COM horse; missing key is unknown.
        owner=row.get('ownerName')
        if owner is None and str(row.get('rankingId','')).startswith('c_'):
            owner=''  # COM identity is explicit in the finalized ranking ID.
        if isinstance(owner,str) and len(owner)<=24:
            data[prefix+'OwnerName']=owner
    margin=second.get('margin')  # First row has the winner's placeholder '―'.
    if isinstance(margin,str):
        margin=margin.strip()
        if margin and margin not in ('―','—','-') and len(margin)<=40:
            data['firstSecondMargin']=margin
    return data


def race_history_entry(slot,race_name,row,top_two):
    return {'slot':slot,'raceName':race_name,'place':row['place'],
            'prizeYen':row['prizeYen'],**top_two}


def request(token,url,body=None):
    data=json.dumps(body,ensure_ascii=False,separators=(',',':')).encode() if body is not None else None
    headers={'Authorization':'Bearer '+token,'Accept':'application/json'}
    if data is not None:headers['Content-Type']='application/json'
    req=Request(API+url,data=data,headers=headers,method='POST' if data is not None else 'GET')
    import time
    for attempt in range(4):
        try:
            with urlopen(req,timeout=35) as resp:return json.load(resp)
        except HTTPError as exc:
            if exc.code!=429 or attempt==3:raise
            delay=5*(2**attempt)
            print(f"Firestore HTTP 429: retry in {delay}s",flush=True)
            time.sleep(delay)


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


def update_com(token,row,slot,race_name,top_two):
    """Advance one COM's persistent 20-start cycle, independent of JST weeks.

    The caller atomically commits this write with its weekly-board update and
    create-only race receipt.  A completed block is passed to the weekly board
    BEFORE the live counter/prize is reset to zero.
    """
    path='vs_com_career/'+row['rankingId']
    previous=doc_get(token,path)
    raw=previous.get('fields',{}) if previous else {}
    last_slot=int(raw.get('lastSlot',{}).get('integerValue','0'))
    if previous and slot<=last_slot:
        # A reset may clear race receipts while retaining COM career counters.
        # Never credit the same or an older slot twice. Other horses in this
        # race can still be processed and the new receipt stored atomically.
        print(f'SKIP already counted COM slot={slot} lastSlot={last_slot} id={row["rankingId"]}',flush=True)
        return None
    version=int(raw.get('comCycleVersion',{}).get('integerValue','0'))
    if version==2:
        count=int(raw.get('count',{}).get('integerValue','0'))
        earned=int(raw.get('cyclePrizeYen',{}).get('integerValue','0'))
        total=int(raw.get('totalStarts',{}).get('integerValue','0'))
        maps=raw.get('cyclePlaces',{}).get('mapValue',{}).get('fields',{})
        places={f'p{i}':int(maps.get(f'p{i}',{}).get('integerValue','0')) for i in range(1,6)}
        if not 0<=count<20 or earned<0 or total<count or any(n<0 for n in places.values()):
            raise ValueError('COM馬の20戦区切りの記録が不正です')
        history=read_history(raw.get('cycleRaceResults'))
        if len(history)>count:raise ValueError('COM馬の戦歴件数が出走数を超えています')
        extra={}
    else:
        # Old builds did not preserve prize for the unfinished lifetime block.
        # Its exact amount cannot be reconstructed after the 24h replay expiry.
        # Start a fresh, honest 20-start block, preserving old starts for audit.
        old_count=int(raw.get('count',{}).get('integerValue','0'))
        if old_count<0:raise ValueError('COM馬の旧出走回数が不正です')
        count=earned=0
        total=old_count
        places={f'p{i}':0 for i in range(1,6)}
        history=[]
        extra={'legacyStartsAtCom20Migration':old_count}
    count+=1
    history.append(race_history_entry(slot,race_name,row,top_two))
    if len(history)>20:raise ValueError('COM馬の20戦内訳が上限を超えました')
    earned+=row['prizeYen']
    if 1<=row['place']<=5:
        places[f'p{row["place"]}']+=1
    completed=earned if count==20 else None
    completed_places=places.copy() if completed is not None else None
    completed_results=history.copy() if completed is not None else None
    if completed is not None:
        history=[]
        count=earned=0
        places={f'p{i}':0 for i in range(1,6)}
    data={'horseName':row['horseName'],'comCycleVersion':2,
          'count':count,'cyclePrizeYen':earned,'cyclePlaces':places,
          'totalStarts':total+1,'lastSlot':slot,
          'cycleRaceResults':history,**extra}
    write={'update':{'name':BASE+'/'+path,'fields':fields(data)},
           'updateMask':{'fieldPaths':list(data)+[
               'cyclePrize','lastCompletedCyclePrize']},
           'currentDocument':{'updateTime':previous['updateTime']} if previous else {'exists':False}}
    return write,completed,completed_places,count,completed_results


def com_weekly_write(token,path,row,week,completed,completed_places,cycle_starts,completed_results):
    """Only completed 20-start blocks may earn COM ranking money.

    Per-week best completed block wins; active partial blocks stay out of the
    standings. Cycles themselves persist in vs_com_career across Mondays.
    """
    previous=doc_get(token,path)
    f=previous.get('fields',{}) if previous else {}
    if previous and f.get('rankingId',{}).get('stringValue') not in ('',row['rankingId']):
        raise ValueError('COM馬IDが既存の週間賞金記録と不一致です')
    version=int(f.get('comPrizeVersion',{}).get('integerValue','0'))
    if version in (1,2):
        best=int(f.get('comBest20PrizeYen',{}).get('integerValue','0'))
        if best<0:raise ValueError('COM馬の完成ブロック賞金が不正です')
        blocks=int(f.get('comCompletedBlocks',{}).get('integerValue',
                   '1' if best>0 else '0')) if version==2 else (1 if best>0 else 0)
        best_map=f.get('comBest20Places',{}).get('mapValue',{}).get('fields',{})
        best_places={f'p{i}':int(best_map.get(f'p{i}',{}).get('integerValue','0')) for i in range(1,6)}
    else:
        # Legacy weekly total is NOT a verified 20-race block. Only an exact
        # 20-start record can be safely imported as one completed block.
        old_starts=0 if version==3 else int(f.get('starts',{}).get('integerValue','0'))
        old_sum=int(f.get('prizeYen',{}).get('integerValue','0'))
        if old_starts<0 or old_sum<0:raise ValueError('COM馬の旧週間記録が不正です')
        best=old_sum if old_starts==20 else 0
        blocks=1 if old_starts==20 else 0
        best_places={f'p{i}':0 for i in range(1,6)}
    best_results=read_history(f.get('comBest20RaceResults'))
    if blocks<0 or any(n<0 for n in best_places.values()):
        raise ValueError('COM馬の完成ブロック情報が不正です')
    if completed is not None:
        if completed<0 or not isinstance(completed_places,dict):
            raise ValueError('COM馬の20戦完了情報が不正です')
        blocks+=1
        if completed>best or (completed==best and tuple(completed_places.values())>tuple(best_places.values())):
            best=completed
            best_places=completed_places.copy()
            best_results=completed_results.copy() if completed_results is not None else []
    data={'horseName':row['horseName'],'ownerName':row['ownerName'],
          'isCom':True,'weekStart':week,'rankingId':row['rankingId'],
          'starts':20 if blocks else 0,'prizeYen':best,
          'comPrizeVersion':2,'comCompletedBlocks':blocks,
          'comCycleStarts':cycle_starts,
          'comBest20PrizeYen':best,'comBest20Places':best_places,
          'comBest20RaceResults':best_results}
    # Old partial-block fields are intentionally deleted, not used for ranking.
    old_fields=['comBlockStarts','comBlockPrizeYen','comLegacyStarts',
                'comLegacyTotalYen','comLegacyIncomplete','places','raceResults']
    return {'update':{'name':BASE+'/'+path,'fields':fields(data)},
            'updateMask':{'fieldPaths':list(data)+old_fields},
            'currentDocument':{'updateTime':previous['updateTime']} if previous else {'exists':False}}


def load_race_receipts(token,records):
    names=[BASE+f"/vs_weekly_race_receipts/{m['slot']}" for m in records if m.get("intervalMinutes")==15 and type(m.get("slot")) is int]
    if not names:return {}
    names=list(dict.fromkeys(names))
    receipts={}
    for start in range(0,len(names),100):
        batch=names[start:start+100]
        response=request(token,BASE+":batchGet",{"documents":batch})
        seen=set()
        for item in response:
            found=item.get("found")
            name=found["name"] if found else item["missing"]
            if name not in batch or name in seen:raise RuntimeError("Invalid receipt response")
            seen.add(name)
            receipts[name]=found
        if seen!=set(batch):raise RuntimeError("Incomplete receipt response")
    return receipts


def lifetime_owner_id(name):
    return hashlib.sha256(name.encode('utf-8')).hexdigest()


def initialize_lifetime_owners(token):
    # Existing weekly counters already include all receipted races. Seed once,
    # before processing any new receipts. Missing parent docs are normal.
    marker='vs_lifetime_owner_meta/initialized'
    if doc_get(token,marker):return
    totals={}
    page=None
    while True:
        qs={'pageSize':'500','showMissing':'true'}
        if page:qs['pageToken']=page
        data=request(token,quote(BASE+'/vs_weekly_horses',safe='/()')+'?'+urlencode(qs))
        for parent in data.get('documents',[]):
            week=parent['name'].rsplit('/',1)[-1]
            for row in ranking(token,week):
                name=row['ownerName']
                if name and not row['rankingId'].startswith('c_'):
                    totals[name]=totals.get(name,0)+row['prizeYen']
        page=data.get('nextPageToken')
        if not page:break
    writes=[{'update':{'name':BASE+'/vs_lifetime_owner_seed/'+lifetime_owner_id(name),
                       'fields':fields({'ownerName':name,'prizeYen':prize})}}
            for name,prize in totals.items()]
    for i in range(0,len(writes),400):commit(token,writes[i:i+400])
    commit(token,[{'update':{'name':BASE+'/'+marker,'fields':fields({'version':1})},
                   'currentDocument':{'exists':False}}])


def lifetime_owner_writes(rows):
    totals={}
    for row in rows:
        if not row['isCom'] and row['ownerName']:
            name=row['ownerName'];totals[name]=totals.get(name,0)+row['prizeYen']
    return [{'update':{'name':BASE+'/vs_lifetime_owner_totals/'+lifetime_owner_id(name),
                       'fields':fields({'ownerName':name})},
             'updateMask':{'fieldPaths':['ownerName']},
             'updateTransforms':[{'fieldPath':'prizeYen','increment':{'integerValue':str(prize)}}]}
            for name,prize in totals.items()]


def lifetime_owner_board(token):
    totals={}
    for collection in ('vs_lifetime_owner_seed','vs_lifetime_owner_totals'):
        for doc in list_docs(token,collection):
            f=doc['fields'];name=f['ownerName']['stringValue'];prize=int(f['prizeYen']['integerValue'])
            if not name or prize<0:raise ValueError('Invalid lifetime owner total')
            totals[name]=totals.get(name,0)+prize
    return [{'rank':i,'ownerName':name,'prizeYen':prize} for i,(name,prize) in enumerate(
        sorted(totals.items(),key=lambda x:(-x[1],x[0])),1)][:70]


def commit_race(token,meta,receipts=None):
    rows=race_rows(meta)
    if not rows:return False
    slot=meta['slot']
    week=week_start(datetime.fromtimestamp(slot*SLOT_MS/1000,timezone.utc))
    receipt_path=f'vs_weekly_race_receipts/{slot}'
    digest=hashlib.sha256(json.dumps(rows,ensure_ascii=False,sort_keys=True).encode()).hexdigest()
    race_name=meta.get('name')
    if not isinstance(race_name,str) or not race_name or len(race_name)>100:
        raise ValueError('レース名が不正です')
    top_two=top_two_public_result(meta)
    def result_transform(row):
        # Firestore's arrayUnion keeps race results attached to each weekly
        # player-horse document already loaded for the weekly standings.
        # COM race results are not needed for a player's personal history.
        return {'fieldPath':'raceResults','appendMissingElements':{'values':[
            {'mapValue':{'fields':fields(race_history_entry(slot,race_name,row,top_two))}}
        ]}}
    prior=receipts[BASE+"/"+receipt_path] if receipts is not None and BASE+"/"+receipt_path in receipts else doc_get(token,receipt_path)
    if prior:
        if prior['fields'].get('digest',{}).get('stringValue')!=digest:
            raise RuntimeError('同じ開催枠の賞金記録が変更されました。再加算を中止します')
        # Backfill legacy receipts ONCE, without ever crediting prize/starts
        # again. The marker prevents repetitive writes on every 15-minute run.
        if prior['fields'].get('historyVersion',{}).get('integerValue')=='1':
            return False
        backfill=[{'update':{'name':BASE+'/'+receipt_path,
                    'fields':fields({'historyVersion':1})},
                    'updateMask':{'fieldPaths':['historyVersion']},
                    'currentDocument':{'updateTime':prior['updateTime']}}]
        backfill.extend({'transform':{
                    'document':BASE+f'/vs_weekly_horses/{week}/horses/{r["rankingId"]}',
                    'fieldTransforms':[result_transform(r)]}}
                  for r in rows if not r['isCom'])
        try:commit(token,backfill)
        except HTTPError as e:
            if e.code in (409,412):return False
            raise
        return False
    writes=[{'update':{'name':BASE+'/'+receipt_path,'fields':fields({
        'slot':slot,'weekStart':week,'digest':digest,'historyVersion':1})},'currentDocument':{'exists':False}}]
    for row in rows:
        path=f'vs_weekly_horses/{week}/horses/{row["rankingId"]}'
        if row['isCom']:
            # The previous implementation always incremented prizeYen here,
            # which displayed lifetime-within-week totals after 20 starts.
            com_update=update_com(token,row,slot,race_name,top_two)
            if com_update is None:
                continue  # Already credited in persistent COM career; no double payment.
            career,completed,completed_places,cycle_starts,completed_results=com_update
            writes.append(com_weekly_write(token,path,row,week,completed,completed_places,cycle_starts,completed_results))
            writes.append(career)
            continue
        current={'horseName':row['horseName'],'ownerName':row['ownerName'],'isCom':False,
                 'weekStart':week,'rankingId':row['rankingId']}
        writes.append({'update':{'name':BASE+'/'+path,'fields':fields(current)},
            'updateMask':{'fieldPaths':list(current)},
            'updateTransforms':[
                {'fieldPath':'prizeYen','increment':{'integerValue':str(row['prizeYen'])}},
                {'fieldPath':'starts','increment':{'integerValue':'1'}},
                *([{'fieldPath':f'places.p{row["place"]}','increment':{'integerValue':'1'}}] if 1<=row['place']<=5 else []),
                result_transform(row)]})
    writes.extend(lifetime_owner_writes(rows))
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
        identity=f.get('rankingId',{}).get('stringValue','')
        com=identity.startswith('c_')
        if com:
            version=int(f.get('comPrizeVersion',{}).get('integerValue','0'))
            if version not in (1,2):
                # Unknown old COM sums may contain incomplete 20-race cycles.
                continue
            best=int(f.get('comBest20PrizeYen',{}).get('integerValue','0'))
            if best<0:raise ValueError('COM馬の確定賞金が不正です')
            if version==2:
                blocks=int(f.get('comCompletedBlocks',{}).get('integerValue','0'))
                if blocks<1:continue
            elif best==0:
                continue
            prizes=best
            starts=20  # show the completed 20-race set, never lifetime totals
            p=f.get('comBest20Places',{}).get('mapValue',{}).get('fields',{})
        else:
            prizes=int(f.get('prizeYen',{}).get('integerValue','0'))
            starts=int(f.get('starts',{}).get('integerValue','0'))
            p=f.get('places',{}).get('mapValue',{}).get('fields',{})
        if prizes<0 or starts<0:raise ValueError('週間賞金の数値が不正です')
        counts=[int(p.get('p'+str(i),{}).get('integerValue','0')) for i in range(1,6)]
        if any(n<0 for n in counts):raise ValueError('着順記録の数値が不正です')
        # COM: best completed 20-start block only. Player: this week's official starts.
        # Older blocks without a saved per-race breakdown remain intentionally partial.
        race_results=read_history(f.get('comBest20RaceResults' if com else 'raceResults'))
        result.append({'horseName':f['horseName']['stringValue'],
            'ownerName':f['ownerName']['stringValue'],'prizeYen':prizes,
            'rankingId':identity,'starts':starts,'places':counts,
            'raceResults':race_results})
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
            'rankingId':winner['rankingId'],
            'raceResults':winner['raceResults'],**award_calendar(past_week)}
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


def repair_first_champion(token):
    path='vs_weekly_awards/2026-11-16'
    doc=doc_get(token,path)
    if not doc:return
    f=doc['fields']
    if (f.get('generation',{}).get('integerValue')!='1' or
        f.get('horseName',{}).get('stringValue')!='ディープインパルス' or
        f.get('ownerName',{}).get('stringValue')!='' or
        not f.get('rankingId',{}).get('stringValue','').startswith('c_')):return
    history=read_history(f.get('raceResults'))
    expected=[(1994798, '皐月賞', 2, 80000000), (1994799, '天皇賞（春）', 1, 300000000), (1994803, '日本ダービー', 1, 300000000), (1994805, '宝塚記念', 1, 300000000), (1994808, '菊花賞', 1, 200000000), (1994809, '天皇賞（秋）', 1, 300000000), (1994812, 'ジャパンカップ', 1, 500000000), (1994813, '有馬記念', 1, 500000000), (1994814, '大阪杯', 4, 45000000), (1994816, '皐月賞', 1, 200000000), (1994817, '天皇賞（春）', 1, 300000000), (1994821, '日本ダービー', 1, 300000000), (1994826, '菊花賞', 1, 200000000), (1994827, '天皇賞（秋）', 1, 300000000), (1994830, 'ジャパンカップ', 1, 500000000), (1994831, '有馬記念', 1, 500000000), (1994834, '皐月賞', 9, 0), (1994835, '天皇賞（春）', 1, 300000000), (1994839, '日本ダービー', 1, 300000000), (1994841, '宝塚記念', 1, 300000000)]
    if [(r['slot'],r['raceName'],r['place'],r['prizeYen']) for r in history]!=expected:return
    if f.get('prizeYen',{}).get('integerValue')!='22805000000':return
    commit(token,[{'update':{'name':BASE+'/'+path,'fields':fields({'prizeYen':sum(r['prizeYen'] for r in history)})},
                   'updateMask':{'fieldPaths':['prizeYen']},
                   'currentDocument':{'updateTime':doc['updateTime']}}])
    print('Repaired first champion prize from saved 20 results',flush=True)


def archive(token):
    result=[]
    for doc in list_docs(token,'vs_weekly_awards'):
        f=doc.get('fields',{})
        item={k: (int(f[k]['integerValue']) if k in ('generation','prizeYen') else f[k]['stringValue'])
            for k in ('weekStart','weekEnd','generation','horseName','ownerName','prizeYen')}
        cal=award_calendar(item['weekStart'])
        item.update(cal)
        item['hasReplayHorse']=f.get('hasReplayHorse',{}).get('booleanValue',False)
        item['raceResults']=read_history(f.get('raceResults'))
        result.append(item)
    return sorted(result,key=lambda r:r['generation'],reverse=True)


def public_board(token,now):
    current=week_start(now)
    board=ranking(token,current)
    # Only PUBLIC owner names and race earnings. Never publish UID, horseKey,
    # encrypted data, private horse statistics or future registrations.
    standings=[{'rank':pos,'horseName':horse['horseName'],
                'ownerName':horse['ownerName'],'prizeYen':horse['prizeYen']}
               for pos,horse in enumerate(board,1)]
    # Race results are already published when each race completes. Export
    # only public name/owner/time/place/money; never UID/horseKey/envelope.
    race_results=[{'ownerName':h['ownerName'],'horseName':h['horseName'],**r}
                  for h in board if h['ownerName'] for r in h.get('raceResults',[])]
    if len(race_results)>4000:raise ValueError('週間出走結果の公開上限を超えました')
    race_results.sort(key=lambda r:(-r['slot'],r['place'],r['horseName']))
    result={'version':1,'timezone':'Asia/Tokyo','weekStart':current,
            'weekEnd':(datetime.fromisoformat(current)+timedelta(days=6)).date().isoformat(),
            'top10':[{k:v for k,v in row.items() if k in ('horseName','ownerName','prizeYen','starts','raceResults')}
                     for row in board[:10]],
            'standings':standings,
            'raceResults':race_results,
            'awards':archive(token),
            'lifetimeOwners':lifetime_owner_board(token)}
    return result


def main():
    secret=os.getenv('FIREBASE_SERVICE_ACCOUNT_JSON','').strip()
    if not secret:raise RuntimeError('Firebase秘密情報がありません。賞金集計は省略できません')
    token=registered_horses._access_token(secret)
    raw=json.loads((ROOT/'race_playlist.json').read_text(encoding='utf-8'))
    if raw.get('version')!=2:raise ValueError('開催一覧が不正です')
    initialize_lifetime_owners(token)
    count=0
    records=sorted(raw['records'],key=lambda x:x['slot'])
    receipts=load_race_receipts(token,records)
    for meta in records:
        if commit_race(token,meta,receipts):count+=1
    now=datetime.now(timezone.utc)
    repair_first_champion(token)
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
