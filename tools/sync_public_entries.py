#!/usr/bin/env python3
"""Mirror only public horse/owner names from active registrations in Firestore.

Uses existing GitHub Actions service account, never publishes UIDs, abilities,
private horse IDs or keys. Runs before race recording and after consumption.
No race or registration semantics are changed.
"""
from __future__ import annotations
import json
import os
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen
import registered_horses

PROJECT = 'derby-vs-arena'
BASE = f'projects/{PROJECT}/databases/(default)/documents'
API = 'https://firestore.googleapis.com/v1/'


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


def active_names(documents):
    result={}
    for doc in documents:
        row=registered_horses._decode_document(doc)
        owner=row['ownerName']
        if not owner or '/' in owner:
            raise ValueError('公開オーナー名が不正です')
        if owner in result:
            raise RuntimeError('重複したオーナー名が見つかりました。公開一覧を更新しません')
        result[owner]={'ownerName':owner,'horseName':row['runner']['name'],
                       'updatedAt':row['updatedAt']}
    return result


def build_writes(active, public):
    writes=[]
    for owner,entry in active.items():
        existing=public.get(owner)
        if existing and all(simple_field(existing,k)==entry[k] for k in ('ownerName','horseName')) and \
           simple_field(existing,'updatedAt','timestampValue')==entry['updatedAt']:
            continue
        name=f'{BASE}/vs_public_entries/{owner}'
        write={'update':{'name':name,'fields':{
            'ownerName':{'stringValue':entry['ownerName']},
            'horseName':{'stringValue':entry['horseName']},
            'updatedAt':{'timestampValue':entry['updatedAt']}}},
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
    active=active_names(list_docs(token,'vs_entries'))
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
