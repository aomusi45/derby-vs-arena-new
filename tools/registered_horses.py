#!/usr/bin/env python3
"""Read frozen VS horses from existing Firebase Firestore (Spark compatible).

GitHub Actions uses a SERVICE ACCOUNT SECRET server-side. No secret is ever
included in Pages output. Read failure returns COM-only racing in the caller.
"""
from __future__ import annotations
import hashlib
import json
import os
import random
import re
from datetime import datetime, timedelta, timezone
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen

JST = timezone(timedelta(hours=9))
STATS = ('speed','sta','kick','early','sustain','grit','stability')
PROJECT_ID = 'derby-vs-arena'
MAX_ENTRIES = 150  # 2 schedules x 96 slots/day x 150 docs ~28.8k reads/day
UID_RE = re.compile(r'[A-Za-z0-9_-]{1,128}\Z')


def _num(value, minimum: float, maximum: float):
    if type(value) not in (int, float) or not minimum <= value <= maximum:
        raise ValueError('馬の能力値が不正です')
    return value


def normalize(row: dict) -> dict:
    """Revalidate ALL racing inputs received through untrusted user documents."""
    if not isinstance(row, dict):
        raise ValueError('登録行が不正です')
    owner, horse_id, source = row.get('ownerUid'), row.get('horseId'), row.get('roster')
    if (not isinstance(owner, str) or not UID_RE.fullmatch(owner) or
            not isinstance(horse_id, str) or not 1 <= len(horse_id) <= 180):
        raise ValueError('登録者・馬IDが不正です')
    if (not isinstance(source, dict) or not isinstance(source.get('name'), str)
            or not 1 <= len(source['name']) <= 60 or source.get('name') != row.get('horseName')):
        raise ValueError('馬名が不正です')
    if source.get('sex') not in ('牡','牝','セ') or source.get('tactic') not in ('逃げ','先行','差し','追込'):
        raise ValueError('性別または脚質が不正です')
    if source.get('growth') not in ('持続','早熟','普通','晩成'):
        raise ValueError('成長タイプが不正です')
    if not isinstance(source.get('coatType'), str) or len(source['coatType']) > 16:
        raise ValueError('毛色が不正です')
    for stat in STATS:
        _num(source.get(stat), 0, 500)
    for stat, lo, hi in [('age',2,8),('aptMin',800,4000),('aptMax',800,4000),
            ('form',0,100),('fatigue',0,100),('health',0,110),('temperament',0,110),
            ('bestDistance',800,4000),('earnedPrize',0,10000000000000),('g1Wins',0,1000)]:
        _num(source.get(stat), lo, hi)
    if source['aptMin'] > source['aptMax']:
        raise ValueError('距離適性が不正です')
    going = source.get('going')
    if not isinstance(going, dict):
        raise ValueError('馬場適性が不正です')
    for key in ('良','稍重','重','不良'):
        _num(going.get(key), 0, 200)
    runner = {k:source[k] for k in STATS}
    for k in ('name','sex','coatType','age','growth','tactic','bestDistance','aptMin','aptMax',
              'health','temperament','form','fatigue','g1Wins','earnedPrize'):
        runner[k] = source[k]
    runner['going'] = {k:going[k] for k in ('良','稍重','重','不良')}
    runner['isCom'] = False
    registration_id = hashlib.sha256((owner+'|'+horse_id).encode()).hexdigest()[:24]
    return {'registrationId': registration_id, 'runner': runner,
            'updatedAt': row.get('updatedAt',''), 'ownerUid': owner}


def _firestore_value(value: dict):
    """Decode Firestore REST typed fields without executing input."""
    if not isinstance(value, dict) or len(value) != 1:
        raise ValueError('Firestoreフィールドが不正です')
    kind, raw = next(iter(value.items()))
    if kind == 'stringValue':
        return raw
    if kind == 'integerValue':
        return int(raw)
    if kind == 'doubleValue':
        return float(raw)
    if kind == 'booleanValue':
        return bool(raw)
    if kind == 'timestampValue':
        return raw
    if kind == 'mapValue':
        return {k:_firestore_value(v) for k,v in raw.get('fields',{}).items()}
    if kind == 'nullValue':
        return None
    raise ValueError('登録馬に未知のFirestore型があります')


def _decode_document(document: dict) -> dict:
    fields = {k:_firestore_value(v) for k,v in document.get('fields',{}).items()}
    doc_id = document.get('name','').rsplit('/',1)[-1]
    if fields.get('ownerUid') != doc_id:
        raise ValueError('登録者IDとドキュメントIDが一致しません')
    # registration time from Firestore server, never from a client timestamp.
    fields['updatedAt'] = document.get('updateTime','')
    return normalize(fields)


def _access_token(secret_json: str) -> str:
    from google.oauth2 import service_account
    from google.auth.transport.requests import Request as GoogleRequest
    credentials = service_account.Credentials.from_service_account_info(
        json.loads(secret_json), scopes=['https://www.googleapis.com/auth/datastore'])
    credentials.refresh(GoogleRequest())
    if not credentials.token:
        raise RuntimeError('Firebaseサービスアカウントの認証に失敗しました')
    return credentials.token


def load() -> list[dict]:
    secret_json = os.getenv('FIREBASE_SERVICE_ACCOUNT_JSON', '').strip()
    project = os.getenv('FIREBASE_PROJECT_ID',PROJECT_ID).strip()
    if project != PROJECT_ID:
        raise ValueError('FirebaseプロジェクトIDが異なります')
    if not secret_json:
        print('VS registration: Firebase service account secret not configured; COM-only racing.', flush=True)
        return []
    token = _access_token(secret_json)
    base = (f'https://firestore.googleapis.com/v1/projects/{quote(project)}/'
            'databases/(default)/documents/vs_entries')
    rows = []
    page_token = ''
    while True:
        # Avoid unexpectedly exhausting Firestore Spark daily read quotas.
        qs = {'pageSize':str(MAX_ENTRIES)}
        if page_token:
            qs['pageToken'] = page_token
        request = Request(base+'?'+urlencode(qs),headers={
            'Authorization':'Bearer '+token,'Accept':'application/json'})
        with urlopen(request,timeout=20) as response:
            obj = json.loads(response.read(2_000_000))
        if not isinstance(obj, dict) or not isinstance(obj.get('documents',[]),list):
            raise ValueError('Firestoreの登録一覧が不正です')
        for doc in obj.get('documents',[]):
            try:
                rows.append(_decode_document(doc))
            except (ValueError, TypeError, KeyError) as error:
                print('Invalid Firebase registration skipped:',str(error),flush=True)
        if obj.get('nextPageToken'):
            # No silent unfair cutoff of a bigger registered field.
            raise RuntimeError('登録馬が150頭を超えています。Firestore無料枠内に収まる取得方式が必要です')
        break
    return rows


def choose(entries: list[dict], card: dict, slot: int, published: list[dict]) -> list[dict]:
    """One group of <=18, one appearance per *horse* per G1 per JST day."""
    slot_start_ms = slot * 900_000
    today = datetime.fromtimestamp(slot_start_ms / 1000, JST).date()
    already=set()
    for meta in published:
        if meta.get('name') != card['name'] or not isinstance(meta.get('slot'),int):
            continue
        interval = int(meta.get('intervalMinutes',10))
        if datetime.fromtimestamp(meta['slot']*interval*60,JST).date() != today:
            continue
        already.update(meta.get('registrations',[]))
    eligible=[];seen=set()
    for row in entries:
        ident=row['registrationId']
        if ident in seen or ident in already:
            continue
        try:
            updated = datetime.fromisoformat(row['updatedAt'].replace('Z','+00:00'))
            if updated.tzinfo is None or updated.timestamp()*1000 > slot_start_ms:
                continue
        except (ValueError,TypeError,AttributeError):
            continue
        seen.add(ident)
        eligible.append(row)
    random.Random(slot).shuffle(eligible)
    return eligible[:18]
