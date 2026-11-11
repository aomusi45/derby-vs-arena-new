#!/usr/bin/env python3
"""Permanent, idempotent counting of registered horses in *published* completed races.

Each (slot, horseKey) has a create-only receipt and an atomic counter increment.
Runs only after successful race_playlist.json publication; do not count registrations.
A retry never counts the same completed run twice. Existing 24h retention is not
an authoritative lifetime history; this ledger starts with the deployed migration.
"""
from __future__ import annotations
import hashlib
import json
import os
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen
import registered_horses

ROOT=Path(__file__).resolve().parents[1]
PROJECT=registered_horses.PROJECT_ID
BASE=f'projects/{PROJECT}/databases/(default)/documents'
REST='https://firestore.googleapis.com/v1/'


def appearances(records):
    """Only real, completed published 15-minute race registrations are counted."""
    seen=set()
    for record in records:
        if record.get('intervalMinutes') != 15 or type(record.get('slot')) is not int:
            continue
        slot=record['slot']
        keys=record.get('horseKeys',[])
        if not isinstance(keys,list):
            raise ValueError('レースの馬識別情報が不正です')
        for key in keys:
            if not isinstance(key,str) or len(key)!=64 or any(c not in '0123456789abcdef' for c in key):
                raise ValueError('レースの馬識別情報が不正です')
            if (slot,key) not in seen:
                seen.add((slot,key));yield slot,key,record.get('name')


def count_commit(token,slot,key,race_name):
    if not isinstance(race_name,str) or not race_name or len(race_name)>100:
        raise ValueError("レース名が不正です")
    race_code=hashlib.sha256(race_name.encode()).hexdigest()[:24]
    event_id=hashlib.sha256(f'{slot}|{key}'.encode()).hexdigest()
    receipt=f'{BASE}/vs_appearance_receipts/{event_id}'
    g1_receipt=f'{BASE}/vs_g1_backfill_receipts/{event_id}'
    usage=f'{BASE}/vs_horse_usage/{key}'
    writes=[
        {'update':{'name':receipt,'fields':{
            'horseKey':{'stringValue':key},'slot':{'integerValue':str(slot)}}},
         'currentDocument':{'exists':False}},
        {'update':{'name':g1_receipt,'fields':{
            'horseKey':{'stringValue':key},'slot':{'integerValue':str(slot)},
            'raceCode':{'stringValue':race_code}}},
         'currentDocument':{'exists':False}},
        {'transform':{'document':usage,'fieldTransforms':[
            {'fieldPath':'count','increment':{'integerValue':'1'}},
            {'fieldPath':'g1Counts.'+race_code,'increment':{'integerValue':'1'}}]}}
    ]
    req=Request(REST+f'projects/{PROJECT}/databases/(default)/documents:commit',
        data=json.dumps({'writes':writes}).encode(),method='POST',
        headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'})
    try:
        with urlopen(req,timeout=30) as resp:
            result=json.load(resp)
        if len(result.get('writeResults',[]))!=3:
            raise RuntimeError('Firestore出走回数保存の応答が不完全です')
        return True
    except HTTPError as exc:
        if exc.code in (409,412):
            # A collision is only a valid retry if the exact event receipt exists.
            check=Request(REST+quote(receipt,safe='/()'),headers={'Authorization':'Bearer '+token})
            with urlopen(check,timeout=20) as resp:
                existing=json.load(resp)
            f=existing.get('fields',{})
            if (f.get('horseKey',{}).get('stringValue')==key and
                f.get('slot',{}).get('integerValue')==str(slot)):
                # Previous deployed appearance receipts recorded only career
                # starts. Add the named-G1 count once, without recounting starts.
                backfill_writes=[
                    {'update':{'name':g1_receipt,'fields':{
                        'horseKey':{'stringValue':key},'slot':{'integerValue':str(slot)},
                        'raceCode':{'stringValue':race_code}}},
                     'currentDocument':{'exists':False}},
                    {'transform':{'document':usage,'fieldTransforms':[
                        {'fieldPath':'g1Counts.'+race_code,'increment':{'integerValue':'1'}}]}}
                ]
                try:
                    req=Request(REST+f'projects/{PROJECT}/databases/(default)/documents:commit',
                        data=json.dumps({'writes':backfill_writes}).encode(),method='POST',
                        headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'})
                    with urlopen(req,timeout=30) as done:json.load(done)
                except HTTPError as migration_error:
                    if migration_error.code not in (409,412):raise
                    # Verify the exact migration receipt; a conflict must not
                    # silently suppress an unrecorded G1 appearance.
                    check=Request(REST+quote(g1_receipt,safe='/()'),
                                  headers={'Authorization':'Bearer '+token})
                    with urlopen(check,timeout=20) as done:
                        migrated=json.load(done).get('fields',{})
                    if (migrated.get('horseKey',{}).get('stringValue')!=key or
                        migrated.get('slot',{}).get('integerValue')!=str(slot) or
                        migrated.get('raceCode',{}).get('stringValue')!=race_code):
                        raise
                return False
        raise


def load_counts():
    """Backward-compatible count-only interface."""
    return {k:v["count"] for k,v in load_usage().items()}


def load_usage():
    secret=os.environ['FIREBASE_SERVICE_ACCOUNT_JSON'].strip()
    if not secret:raise ValueError('出走回数DBの認証設定がありません')
    token=registered_horses._access_token(secret)
    url=REST+f'{BASE}/vs_horse_usage'
    counts={};next_page=''
    while True:
        params={'pageSize':'500'}
        if next_page:params['pageToken']=next_page
        req=Request(url+'?'+urlencode(params),headers={'Authorization':'Bearer '+token})
        with urlopen(req,timeout=30) as resp:raw=json.load(resp)
        for doc in raw.get('documents',[]):
            key=doc['name'].rsplit('/',1)[-1]
            if len(key)!=64:raise ValueError('出走回数DBの馬識別子が不正です')
            value=doc.get('fields',{}).get('count',{}).get('integerValue')
            count=int(value)
            if count<0:raise ValueError('出走回数が不正です')
            raw_g1=doc.get('fields',{}).get('g1Counts',{}).get('mapValue',{}).get('fields',{})
            g1={}
            for code,val in raw_g1.items():
                if (len(code)!=24 or any(ch not in '0123456789abcdef' for ch in code)
                      or not isinstance(val,dict)):
                    raise ValueError('GⅠ別出走履歴が不正です')
                n=int(val.get('integerValue',-1))
                if n<0: raise ValueError('GⅠ別出走回数が不正です')
                g1[code]=n
            counts[key]={'count':count,'g1Counts':g1}
        next_page=raw.get('nextPageToken','')
        if not next_page:break
    return counts


def main():
    secret=os.environ.get('FIREBASE_SERVICE_ACCOUNT_JSON','').strip()
    if not secret:raise ValueError('FIREBASE_SERVICE_ACCOUNT_JSONが必要です（出走回数確認は省略不可）')
    manifest=json.loads((ROOT/'race_playlist.json').read_text(encoding='utf-8'))
    if manifest.get('version')!=2:raise ValueError('開催記録の形式が不正です')
    token=registered_horses._access_token(secret)
    added=0;existing=0
    for slot,key,race_name in appearances(manifest.get('records',[])):
        if count_commit(token,slot,key,race_name):added+=1
        else:existing+=1
    print(f'Completed-horse appearances: added={added}, already-counted={existing}',flush=True)

if __name__=='__main__':main()
