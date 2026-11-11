#!/usr/bin/env python3
"""Consume only registrations that appear in an ALREADY published DBF replay.

Run *after* push_recorded_races.py succeeds. A Firestore delete has an
updateTime precondition so a player re-registering during recording is safe.
The script is idempotent: already-deleted entries require no action.
"""
from __future__ import annotations
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen

import registered_horses

ROOT = Path(__file__).resolve().parents[1]


def consumption_plan(documents: list[dict], records: list[dict]) -> list[dict]:
    """Only a published replay can consume an earlier matching submission."""
    published_receipts = set()
    legacy_receipts = {}
    used_horse_cutoffs = {}
    published_slots = set()
    for record in records:
        if record.get('intervalMinutes') != 15 or not isinstance(record.get('slot'), int):
            continue
        published_slots.add(record['slot'])
        identifiers = record.get('registrations', [])
        published_receipts.update(i for i in identifiers if isinstance(i, str))
        for identifier in identifiers:
            legacy_receipts[identifier] = max(legacy_receipts.get(identifier, 0), record['slot'] * 900000)
        cutoff = record.get('registrationSnapshotMs')
        if isinstance(cutoff, int) and cutoff > 0:
            for token in record.get('horseTokens', []):
                if isinstance(token, str):
                    used_horse_cutoffs[token] = max(used_horse_cutoffs.get(token, 0), cutoff)
    plan = []
    for doc in documents:
        try:
            row = registered_horses._decode_document(doc)
            updated_us = registered_horses.timestamp_us(row['updatedAt'])
            matched = row['registrationId'] in published_receipts
            legacy = (row['legacyId'] in legacy_receipts and
                      updated_us <= legacy_receipts[row['legacyId']] * 1000)
            cloned = (row['horseToken'] in used_horse_cutoffs and
                      updated_us <= used_horse_cutoffs[row['horseToken']] * 1000)
            # A submission made within a 15-minute cycle is for the next
            # scheduled slot. Once that slot has a published result, its
            # registration is no longer active, even if the race fell back to
            # COM-only. Never count this as a completed horse appearance.
            assigned_slot = (updated_us // 1000) // 900_000 + 1
            completed_slot = assigned_slot in published_slots
            if not (matched or legacy or cloned or completed_slot):
                continue
            version = doc.get('updateTime')
            name = doc.get('name')
            if version and name and name.endswith('/' + row['ownerUid']):
                plan.append({'documentName': name, 'updateTime': version,
                             'horseName': row['runner']['name']})
        except (ValueError, TypeError, KeyError) as exc:
            print('Invalid registration not consumed:', str(exc), flush=True)
    return plan


def list_documents(token: str, project: str) -> list[dict]:
    base = f'https://firestore.googleapis.com/v1/projects/{quote(project)}/databases/(default)/documents/vs_entries'
    request = Request(base + '?' + urlencode({'pageSize': str(registered_horses.MAX_ENTRIES)}),
                      headers={'Authorization': 'Bearer ' + token, 'Accept': 'application/json'})
    with urlopen(request, timeout=30) as response:
        obj = json.loads(response.read(2_000_000))
    if obj.get('nextPageToken'):
        raise RuntimeError('Firestore登録数が上限を超えました。削除は中止します')
    return obj.get('documents', [])


def consume_records(documents: list[dict], records: list[dict], delete_fn) -> int:
    plan = consumption_plan(documents, records)
    for item in plan:
        delete_fn(item['documentName'], item['updateTime'])
    return len(plan)


def main():
    secret = os.getenv('FIREBASE_SERVICE_ACCOUNT_JSON', '').strip()
    if not secret:
        print('Consumption skipped: Firebase secret is not configured.', flush=True)
        return
    project = os.getenv('FIREBASE_PROJECT_ID', registered_horses.PROJECT_ID)
    if project != registered_horses.PROJECT_ID:
        raise ValueError('FirebaseプロジェクトIDが異なります')
    published = json.loads((ROOT / 'race_playlist.json').read_text(encoding='utf-8'))
    if published.get('version') != 2:
        raise ValueError('公開レース一覧が不正です。登録解除を中止します')
    token = registered_horses._access_token(secret)
    documents = list_documents(token, project)
    def delete(name: str, version: str):
        expected_prefix = f'projects/{project}/databases/(default)/documents/vs_entries/'
        if not name.startswith(expected_prefix):
            raise ValueError('不正なFirestore登録パスを拒否しました')
        uri = 'https://firestore.googleapis.com/v1/' + quote(name, safe='/()')
        uri += '?' + urlencode({'currentDocument.updateTime': version})
        req = Request(uri, method='DELETE', headers={'Authorization': 'Bearer ' + token})
        try:
            with urlopen(req, timeout=20):
                pass
        except HTTPError as exc:
            # A new write changed the updateTime (409/412): never delete it.
            # A previous successful run may have deleted the document (404).
            if exc.code in (404, 409, 412):
                print('New/removed registration protected:', name.rsplit('/', 1)[-1], exc.code, flush=True)
                return
            raise
    n = consume_records(documents, published['records'], delete)
    print(f'VS registrations safely consumed after replay publication: {n}', flush=True)
    # Refresh the public aggregate from the remaining live registrations.
    # The normal conflict-safe publisher will commit it in the following step.
    import scheduled_vs
    current_entries = registered_horses.load()
    current_ms = int(__import__('time').time()*1000)
    published['registrationSummary'] = scheduled_vs.public_registration_summary(
        current_entries, scheduled_vs.load_catalog(), published['records'],
        current_ms, published_at_ms=current_ms)
    (ROOT / 'race_playlist.json').write_text(
        json.dumps(published, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


if __name__ == '__main__':
    main()
