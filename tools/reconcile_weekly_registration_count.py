#!/usr/bin/env python3
"""Repair the JST-week registration quota from immutable first-entry records.

One owner may register only one horse per week. Subsequent entries into other
G1 races are *not* additional horses. This job never touches an owner's horse,
entry, starts, prize money, or permanent registration history.

A single conditional Firestore write avoids overwriting a concurrent admission.
A new registration uses the same quota document and must advance its updateTime.
"""
from __future__ import annotations
import json
import os
import re
import sys
from datetime import datetime, timezone
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen

import registered_horses

PROJECT = registered_horses.PROJECT_ID
API = 'https://firestore.googleapis.com/v1/'
BASE = f'projects/{PROJECT}/databases/(default)/documents'
UID_RE = re.compile(r'^[A-Za-z0-9_-]{1,128}$')
KEY_RE = re.compile(r'^[0-9a-f]{64}$')


def jst_week(ms: int) -> int:
    return registered_horses.jst_week_index(ms)


def owner_count(rows: list[dict], week_index: int) -> tuple[int, int]:
    """Count unique weekly owners, NOT race applications or document count.

    Two records for the same owner in one week are evidence of a bad earlier
    writer; retain both immutable records but charge only one weekly slot.
    """
    owners: dict[str, str] = {}
    duplicate = 0
    for doc in rows:
        if not isinstance(doc, dict) or not isinstance(doc.get('name'), str):
            raise ValueError('永久登録履歴の形式が不正です')
        fields = doc.get('fields')
        if not isinstance(fields, dict):
            raise ValueError('永久登録履歴にフィールドがありません')
        uid = fields.get('ownerUid', {}).get('stringValue')
        key = fields.get('horseKey', {}).get('stringValue')
        week_raw = fields.get('weekIndex', {}).get('integerValue')
        if not isinstance(uid, str) or not UID_RE.fullmatch(uid):
            raise ValueError('永久登録履歴に不正なオーナーIDがあります')
        if not isinstance(key, str) or not KEY_RE.fullmatch(key):
            raise ValueError('永久登録履歴に不正な馬IDがあります')
        if doc['name'].rsplit('/', 1)[-1] != key:
            raise ValueError('永久登録履歴の識別子が一致しません')
        try:
            stored_week = int(week_raw)
        except (ValueError, TypeError):
            raise ValueError('永久登録履歴に登録週がありません') from None
        if stored_week != week_index:
            raise ValueError('指定週以外の永久登録履歴が返されました')
        if uid in owners:
            duplicate += 1
        else:
            owners[uid] = key
    return len(owners), duplicate


def api_json(token: str, uri: str, data: dict | None = None):
    raw = json.dumps(data, separators=(',', ':')).encode('utf-8') if data is not None else None
    headers = {'Authorization': 'Bearer ' + token, 'Accept': 'application/json'}
    if raw is not None:
        headers['Content-Type'] = 'application/json'
    req = Request(API + uri, data=raw, headers=headers, method='POST' if raw is not None else 'GET')
    with urlopen(req, timeout=35) as response:
        return json.load(response)


def quota_doc(token: str, week_index: int):
    path = quote(f'{BASE}/vs_weekly_registration_counts/w{week_index}', safe='/()')
    try:
        return api_json(token, path)
    except HTTPError as e:
        if e.code == 404:
            return None
        raise


def registered_this_week(token: str, week_index: int) -> list[dict]:
    # Filter at Firestore so all historic permanent records aren't downloaded.
    query = {'structuredQuery': {
        'from': [{'collectionId': 'vs_ever_registered_horses'}],
        'where': {'fieldFilter': {
            'field': {'fieldPath': 'weekIndex'},
            'op': 'EQUAL', 'value': {'integerValue': str(week_index)}
        }},
        'limit': 5000,
    }}
    payload = api_json(token, f'projects/{PROJECT}/databases/(default)/documents:runQuery', query)
    if not isinstance(payload, list):
        raise ValueError('Firestore週間登録履歴の応答が不正です')
    rows = [item['document'] for item in payload if isinstance(item, dict) and 'document' in item]
    if len(rows) >= 5000:
        raise RuntimeError('週間登録履歴が上限に達したため自動修復しません')
    return rows


def reconcile(token: str, week_index: int, dry_run: bool = False) -> dict:
    # Read quota first; an admission during the scan changes updateTime,
    # causing our conditional commit to fail rather than lose its increment.
    previous = quota_doc(token, week_index)
    records = registered_this_week(token, week_index)
    correct, repeated = owner_count(records, week_index)
    if correct > 120:
        raise RuntimeError('週のユニークな登録オーナー数が120を超えています。手動確認が必要です')
    if previous is None:
        if correct:
            # Do not silently create a quota for an inconsistent live database.
            raise RuntimeError('登録履歴はありますが週間カウンターがありません。手動確認が必要です')
        return {'week': week_index, 'current': 0, 'correct': 0, 'duplicates': repeated, 'changed': False}
    raw = previous.get('fields', {})
    try:
        current = int(raw['count']['integerValue'])
        saved_week = int(raw['weekIndex']['integerValue'])
    except (KeyError, TypeError, ValueError):
        raise ValueError('週間カウンターの保存形式が不正です') from None
    version = previous.get('updateTime')
    if saved_week != week_index or not isinstance(version, str) or not version:
        raise ValueError('週間カウンターの登録週・更新日時が不正です')
    if not 0 <= current <= 120:
        raise ValueError('週間カウンターの値が範囲外です')
    if correct == 0 and current != 0:
        # Missing historical documents must NEVER wipe a live quota.
        raise RuntimeError('登録履歴が0件なのに週間登録枠が使用されています。自動変更を中止します')
    changed = current != correct
    if changed and not dry_run:
        # UpdateMask preserves the document's original createdAt/updatedAt.
        write = {'update': {'name': f'{BASE}/vs_weekly_registration_counts/w{week_index}',
                            'fields': {'count': {'integerValue': str(correct)}}},
                 'updateMask': {'fieldPaths': ['count']},
                 'currentDocument': {'updateTime': version}}
        try:
            result = api_json(token, f'projects/{PROJECT}/databases/(default)/documents:commit',
                              {'writes': [write]})
        except HTTPError as e:
            if e.code in (409, 412):
                print('週間登録枠が同時更新されたため、今回の補正を見送ります', flush=True)
                return {'week': week_index, 'current': current, 'correct': correct,
                        'duplicates': repeated, 'changed': False, 'concurrent': True}
            raise
        if len(result.get('writeResults', [])) != 1:
            raise RuntimeError('週間登録枠の更新確認に失敗しました')
    return {'week': week_index, 'current': current, 'correct': correct,
            'duplicates': repeated, 'changed': changed and not dry_run,
            'dryRun': dry_run}


def main():
    secret = os.getenv('FIREBASE_SERVICE_ACCOUNT_JSON', '').strip()
    if not secret:
        raise RuntimeError('FIREBASE_SERVICE_ACCOUNT_JSON がありません。補正は実行しません')
    project = os.getenv('FIREBASE_PROJECT_ID', PROJECT)
    if project != PROJECT:
        raise ValueError('FirebaseのプロジェクトIDが異なります')
    now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
    week = jst_week(now_ms)
    token = registered_horses._access_token(secret)
    result = reconcile(token, week, '--dry-run' in sys.argv[1:])
    print('Weekly unique registration owners (JST):', json.dumps(result, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
