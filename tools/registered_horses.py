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
MAX_ENTRIES = 150  # Max 120 weekly horses, plus temporarily pending entries
UID_RE = re.compile(r'[A-Za-z0-9_-]{1,128}\Z')
WEEK_MS = 604_800_000
WEEK_EPOCH_MS = 313_200_000  # Monday 00:00 JST, 1970-01-05


def jst_week_index(ms: int) -> int:
    return (ms - WEEK_EPOCH_MS) // WEEK_MS



def _num(value, minimum: float, maximum: float):
    if type(value) not in (int, float) or not minimum <= value <= maximum:
        raise ValueError('馬の能力値が不正です')
    return value


def timestamp_us(value: str) -> int:
    """Canonical Firestore server timestamp, with microsecond precision."""
    if not isinstance(value, str) or not value:
        raise ValueError('Firestore登録日時がありません')
    dt = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if dt.tzinfo is None:
        raise ValueError('Firestore登録日時にタイムゾーンがありません')
    delta = dt.astimezone(timezone.utc) - datetime(1970, 1, 1, tzinfo=timezone.utc)
    return (delta.days * 86400 + delta.seconds) * 1_000_000 + delta.microseconds


def registration_id(owner: str, horse_id: str, updated_at: str) -> str:
    # One receipt per submission, not per login/horse: re-registering gets a new receipt.
    return hashlib.sha256((owner+'|'+horse_id+'|'+str(timestamp_us(updated_at))).encode()).hexdigest()[:24]


def horse_token(horse_id: str, runner: dict) -> str:
    """Fingerprint the same exported horse, not every owner's local horse ID.

    Different players may legitimately have the SAME local sourceHorseId.
    Including verified racing parameters prevents those players from being
    merged merely because their games assigned the same local ID.
    """
    payload = json.dumps({'horseId': horse_id, 'runner': runner},
                         ensure_ascii=False, sort_keys=True, separators=(',', ':'))
    return hashlib.sha256(('dbf-export-v3|'+payload).encode()).hexdigest()[:24]


def legacy_registration_id(owner: str, horse_id: str) -> str:
    return hashlib.sha256((owner+'|'+horse_id).encode()).hexdigest()[:24]


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
    owner_name = row.get('ownerName', '')
    # Legacy entries have no public owner name. Never expose ownerUid as a fallback.
    if (not isinstance(owner_name, str) or len(owner_name)>24 or
            any(ord(ch)<32 or ord(ch)==127 for ch in owner_name)):
        raise ValueError('オーナー名が不正です')
    owner_name = owner_name.strip()
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
    submitted_at = row.get('updatedAt', '')
    registered_week = jst_week_index(timestamp_us(submitted_at)//1000)
    legacy_without_week = row.get('weekIndex') is None
    week_index = row.get('weekIndex', registered_week)
    if type(week_index) is not int or week_index != registered_week:
        raise ValueError('登録週が公式日本時間の週間枠と一致しません')
    # Same uid + source horse ID as the official Cloudflare registration Worker.
    horse_key = hashlib.sha256((owner+'|'+horse_id).encode()).hexdigest()
    if row.get('horseKey') != horse_key:
        raise ValueError('公式登録の馬識別キーが一致しません')
    ident = registration_id(owner, horse_id, submitted_at)
    return {'registrationId': ident, 'horseToken': horse_token(horse_id, runner),
            'horseId': horse_id, 'horseKey': horse_key, 'legacyId': legacy_registration_id(owner, horse_id),
            'runner': runner, 'updatedAt': submitted_at, 'ownerUid': owner,
            'ownerName': owner_name, 'weekIndex': week_index,
            'legacyWithoutWeek': legacy_without_week}


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
    # Firestore rules require serverTimestamp() == request.time for each write.
    # Use its persisted value (also available in the Web SDK) for the receipt ID.
    if not isinstance(fields.get('updatedAt'), str):
        raise ValueError('登録日時はFirestoreのサーバー日時が必要です')
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


def unique_horse_count(entries: list[dict]) -> int:
    """Same exported horse uploaded from new guest accounts counts just once."""
    return len({e['horseToken'] for e in entries if not e.get('legacyWithoutWeek')})


def choose(entries: list[dict], card: dict, slot: int, published: list[dict], usage: dict | None = None) -> list[dict]:
    """One entry/slot; lifetime <=20; G1 <=2, using permanent Firestore receipts."""
    slot_start_ms = slot * 900_000
    used_receipts = set()
    used_horse_before = {}
    for meta in published:
        if not isinstance(meta.get('slot'), int):
            continue
        interval = int(meta.get('intervalMinutes', 10))
        recorded_ids = meta.get('registrations', [])
        if isinstance(recorded_ids, list):
            used_receipts.update(recorded_ids)
        snapshot_ms = meta.get('registrationSnapshotMs')
        if isinstance(snapshot_ms, int) and snapshot_ms > 0:
            for token in meta.get('horseTokens', []):
                used_horse_before[token] = max(snapshot_ms, used_horse_before.get(token, 0))
    eligible_by_horse = {}
    # If a guest logged in again and uploaded the SAME JSON, prefer the latest
    # registration without reducing a distinct player's differently trained horse.
    for row in sorted(entries, key=lambda item: timestamp_us(item['updatedAt']), reverse=True):
        # V1 pending entries are consumed by the cleanup job, not admitted
        # to the new once-per-week event without a permanent enrollment.
        if row.get('legacyWithoutWeek'):
            continue
        ident = row['registrationId']
        state = (usage or {}).get(row['horseKey'])
        # No ledger access = fail closed for real entries. A passing empty map
        # explicitly says there are no past completed appearances.
        if usage is None or not isinstance(state,dict):
            if usage is None: continue
            state={'count':0,'g1Counts':{}}
        g1_code = hashlib.sha256(card['name'].encode()).hexdigest()[:24]
        if state['count']>=20 or state.get('g1Counts',{}).get(g1_code,0)>=2:
            continue
        # V28: validate age and sex again at final drawing, never trust UI/Worker alone.
        runner=row.get('runner',{})
        sex, age=runner.get('sex'), runner.get('age')
        band=card.get('ages')
        if (card.get('female') and sex!='牝') or type(age) is not int or band not in ('2','3','3+','4+'):
            continue
        if not (age==2 if band=='2' else age==3 if band=='3' else
                age>=3 if band=='3+' else age>=4):
            continue
        if (ident in used_receipts or
                timestamp_us(row['updatedAt']) <= used_horse_before.get(row['horseToken'], -1) * 1000):
            continue
        try:
            # The Monday 00:00 race cannot take entries from the prior week.
            # Registered horses expire at Sunday 23:59 JST even at 0 starts.
            if row['weekIndex'] != jst_week_index(slot_start_ms):
                continue
            # Registration during slot N belongs to the NEXT slot N+1 only.
            # Previously this tested only the upper bound, letting stale horses
            # race again in all subsequent slots when consumption was delayed.
            submitted_us = timestamp_us(row['updatedAt'])
            if not ((slot_start_ms - 900_000) * 1000 <= submitted_us < slot_start_ms * 1000):
                continue
        except (ValueError, TypeError, AttributeError):
            continue
        eligible_by_horse.setdefault(row['horseToken'], row)
    eligible = list(eligible_by_horse.values())
    random.Random(slot).shuffle(eligible)
    return eligible[:18]
