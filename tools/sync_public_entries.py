#!/usr/bin/env python3
"""Mirror public horse/owner names and server-verified career counts from Firestore.

Uses existing GitHub Actions service account, never publishes UIDs, abilities,
private horse IDs or keys. Counts come from the permanent official usage ledger.
Runs before race recording and after consumption.
No race or registration semantics are changed.
"""
from __future__ import annotations
import json
import os
import time
from urllib.error import HTTPError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen
import registered_horses

PROJECT = 'derby-vs-arena'
BASE = f'projects/{PROJECT}/databases/(default)/documents'
API = 'https://firestore.googleapis.com/v1/'
SLOT_MS = 15 * 60 * 1000


def request_json(url, token, data=None):
    headers = {'Authorization':'Bearer '+token, 'Accept':'application/json'}
    if data is not None:
        headers['Content-Type'] = 'application/json'
    req = Request(url, data=json.dumps(data).encode() if data is not None else None,
                  headers=headers, method='POST' if data is not None else 'GET')
    with urlopen(req, timeout=25) as res:
        return json.load(res)


def list_docs(token, coll):
    url = API + BASE + '/' + coll + '?' + urlencode({'pageSize':'150'})
    response=request_json(url,token)
    if response.get('nextPageToken'):
        raise RuntimeError('公開登録の集計上限150件を超えました。誤った集計を防ぐため中止')
    return response.get('documents',[])


def simple_field(doc, key, kind='stringValue'):
    return doc.get('fields',{}).get(key,{}).get(kind)


def lifetime_count(token, horse_key, cache):
    if horse_key in cache:
        return cache[horse_key]
    if not isinstance(horse_key,str) or len(horse_key)!=64 or any(c not in '0123456789abcdef' for c in horse_key):
        raise ValueError('出走回数照合用の馬識別子が不正です')
    url=API+BASE+'/vs_horse_usage/'+horse_key
    try:
        data=request_json(url,token)
    except HTTPError as exc:
        if exc.code == 404:
            cache[horse_key]=0
            return 0
        raise
    field=data.get('fields',{}).get('count',{}).get('integerValue')
    if field is None:
        raise ValueError('公式出走回数が不正です')
    count=int(field)
    if count<0 or count>20:
        raise ValueError('公式出走回数が範囲外です')
    cache[horse_key]=count
    return count


def active_names(documents, target_slot=None, token=None):
    result={}
    if target_slot is None:
        target_slot=int(time.time()*1000)//SLOT_MS+1
    cache={}
    for doc in documents:
        row=registered_horses._decode_document(doc)
        submitted_ms=registered_horses.timestamp_us(row['updatedAt'])//1000
        if row.get('legacyWithoutWeek') or submitted_ms//SLOT_MS+1!=target_slot or row['weekIndex'] != registered_horses.jst_week_index(target_slot*SLOT_MS):
            continue
        owner=row['ownerName']
        if not owner or '/' in owner:
            raise ValueError('公開オーナー名が不正です')
        if owner in result:
            raise RuntimeError('重複したオーナー名が見つかりました。公開一覧を更新しません')
        entry={'ownerName':owner,'horseName':row['runner']['name'],
               'updatedAt':row['updatedAt']}
        horse_key=doc.get('fields',{}).get('horseKey',{}).get('stringValue')
        if horse_key:
            if not token:
                raise ValueError('出走回数照合にはサーバーの認証が必要です')
            entry['appearanceCount']=lifetime_count(token,horse_key,cache)
        result[owner]=entry
    return result


def build_writes(active, public):
    writes=[]
    for owner,entry in active.items():
        existing=public.get(owner)
        same=bool(existing and all(simple_field(existing,k)==entry[k] for k in ('ownerName','horseName')) and
           simple_field(existing,'updatedAt','timestampValue')==entry['updatedAt'])
        if 'appearanceCount' in entry:
            same=same and simple_field(existing,'appearanceCount','integerValue')==str(entry['appearanceCount'])
        if same:
            continue
        name=f'{BASE}/vs_public_entries/{owner}'
        fields={
            'ownerName':{'stringValue':entry['ownerName']},
            'horseName':{'stringValue':entry['horseName']},
            'updatedAt':{'timestampValue':entry['updatedAt']}}
        if 'appearanceCount' in entry:
            fields['appearanceCount']={'integerValue':str(entry['appearanceCount'])}
        write={'update':{'name':name,'fields':fields},
            'currentDocument':{'updateTime':existing['updateTime']} if existing else {'exists':False}}
        writes.append(write)
    for owner,doc in public.items():
        if owner not in active:
            writes.append({'delete':f'{BASE}/vs_public_entries/{owner}',
                           'currentDocument':{'updateTime':doc['updateTime']}})
    return writes


def main():
    secret=os.getenv('FIREBASE_SERVICE_ACCOUNT_JSON','').strip()
    if not secret:
        raise RuntimeError('FIREBASE_SERVICE_ACCOUNT_JSON がありません。公開登録を更新できません')
    if os.getenv('FIREBASE_PROJECT_ID',PROJECT)!=PROJECT:
        raise ValueError('FirebaseプロジェクトIDが違います')
    token=registered_horses._access_token(secret)
    active=active_names(list_docs(token,'vs_entries'),token=token)
    public_docs=list_docs(token,'vs_public_entries')
    public={}
    for doc in public_docs:
        owner=doc['name'].rsplit('/',1)[-1]
        if owner in public:
            raise RuntimeError('公開オーナー名に重複があります')
        public[owner]=doc
    writes=build_writes(active,public)
    # Use updateTime/exists preconditions to avoid overwriting new registrations.
    # Failed commits are retried by the next scheduled cycle.
    for write in writes:
        request_json(API+f'projects/{PROJECT}/databases/(default)/documents:commit',
                     token,{'writes':[write]})
    print('Public name-only entries:',len(active),'synchronized:',len(writes), flush=True)

if __name__=='__main__':
    main()
