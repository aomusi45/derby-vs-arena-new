#!/usr/bin/env python3
"""One-time permanent migration from old starts-only receipts to G1-by-G1 counts.

The previous deployed receipt contained slot+horseKey but not raceName. The
official 15-minute program is deterministic, so derive G1 from the exact slot
and frozen race_catalog. Existing/new G1 receipt IDs make retries harmless.
Writes do not change career starts or any replay, only G1 usage counts.
"""
from __future__ import annotations
import hashlib
import json
import os
from pathlib import Path
from urllib.parse import quote,urlencode
from urllib.request import Request,urlopen
import registered_horses

ROOT=Path(__file__).resolve().parents[1]
PROJECT=registered_horses.PROJECT_ID
BASE=f'projects/{PROJECT}/databases/(default)/documents'
API='https://firestore.googleapis.com/v1/'
MARK='vs_migrations/g1_history_v1'


def read_json(token,url):
    req=Request(API+url,headers={'Authorization':'Bearer '+token,'Accept':'application/json'})
    with urlopen(req,timeout=35) as res:return json.load(res)


def documents(token,collection):
    docs=[];page=''
    while True:
        q={'pageSize':'500'}
        if page:q['pageToken']=page
        result=read_json(token,quote(BASE+'/'+collection,safe='/()')+'?'+urlencode(q))
        docs.extend(result.get('documents',[]));page=result.get('nextPageToken','')
        if not page:break
        if len(docs)>250000:raise RuntimeError('履歴が多すぎるため自動移行を中止しました')
    return docs


def name_for(slot,cat):
    from datetime import datetime
    start=int(datetime.fromisoformat(cat['cycleStartsAt']).timestamp()*1000)//900000
    races=cat['races']
    if type(slot)is not int or slot<start:
        raise ValueError('番組表の開始前に出走した履歴は自動移行できません')
    return races[(slot-start)%len(races)]['name']


def make_migrations(appearance_docs,migrated_ids,cat):
    tasks=[]
    for doc in appearance_docs:
        event_id=doc['name'].rsplit('/',1)[-1]
        if event_id in migrated_ids:continue
        f=doc.get('fields',{})
        key=f.get('horseKey',{}).get('stringValue')
        slot=int(f.get('slot',{}).get('integerValue','-1'))
        if (not isinstance(key,str) or len(key)!=64 or
            any(c not in '0123456789abcdef' for c in key)):
            raise ValueError('古い出走履歴に不正な馬識別番号があります')
        race=name_for(slot,cat)
        code=hashlib.sha256(race.encode()).hexdigest()[:24]
        if hashlib.sha256(f'{slot}|{key}'.encode()).hexdigest()!=event_id:
            raise ValueError('古い出走履歴のIDが一致しません')
        tasks.append((event_id,key,slot,code))
    return tasks


def split_batches(tasks,max_events=180):
    # Firestore cannot safely update the same horse doc twice in a batch.
    # Aggregate all G1 increments for each horse into a single transform.
    for offset in range(0,len(tasks),max_events):
        batch=tasks[offset:offset+max_events]
        writes=[];increments={}
        for event_id,key,slot,code in batch:
            path=BASE+'/vs_g1_backfill_receipts/'+event_id
            writes.append({'update':{'name':path,'fields':{
                'horseKey':{'stringValue':key},'slot':{'integerValue':str(slot)},
                'raceCode':{'stringValue':code}}},'currentDocument':{'exists':False}})
            increments.setdefault(key,{}).setdefault(code,0)
            increments[key][code]+=1
        for key,g1 in increments.items():
            writes.append({'transform':{'document':BASE+'/vs_horse_usage/'+key,
                'fieldTransforms':[{'fieldPath':'g1Counts.`'+code+'`',
                    'increment':{'integerValue':str(amount)}} for code,amount in g1.items()]}})
        if len(writes)>500:raise ValueError('Firestore書込制限を超えました')
        yield writes


def commit(token,writes):
    req=Request(API+f'projects/{PROJECT}/databases/(default)/documents:commit',
       data=json.dumps({'writes':writes}).encode(),method='POST',
       headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'})
    with urlopen(req,timeout=40) as res:return json.load(res)


def main():
    secret=os.getenv('FIREBASE_SERVICE_ACCOUNT_JSON','').strip()
    if not secret:raise RuntimeError('Firebaseのサービスアカウントが必要です')
    token=registered_horses._access_token(secret)
    from urllib.error import HTTPError
    try:
        read_json(token,quote(BASE+'/'+MARK,safe='/()'))
        print('G1 history already migrated. No changes.',flush=True)
        return
    except HTTPError as error:
        if error.code!=404:raise
    cat=json.loads((ROOT/'race_catalog.json').read_text(encoding='utf8'))
    if cat.get('version')!=1 or cat.get('intervalMinutes')!=15 or not cat.get('races'):
        raise ValueError('公式番組表が不正です')
    originals=documents(token,'vs_appearance_receipts')
    migrated={d['name'].rsplit('/',1)[-1] for d in documents(token,'vs_g1_backfill_receipts')}
    tasks=make_migrations(originals,migrated,cat)
    for i,writes in enumerate(split_batches(tasks),1):
        commit(token,writes)
        print('Historic G1 receipt batch',i,'saved; records',len(writes),flush=True)
    commit(token,[{'update':{'name':BASE+'/'+MARK,'fields':{
        'version':{'integerValue':'1'},
        'knownLifetimeStarts':{'integerValue':str(len(originals))},
        'migratedG1Starts':{'integerValue':str(len(tasks))}}},
        'currentDocument':{'exists':False}}])
    print(f'G1 history migration COMPLETE: original={len(originals)}, migrated={len(tasks)}',flush=True)


if __name__=='__main__':main()
