#!/usr/bin/env python3
"""Manual reset of published race history and prize rankings ONLY.

Preserves owner profiles, registrations, Firebase Auth, appearance/usage ledgers,
COM definitions, and every game/runtime file. Never runs on schedule.
"""
import argparse
import json
import os
import subprocess
from pathlib import Path

PROJECT = 'derby-vs-arena'
CONFIRM = 'DELETE_RACE_HISTORY_AND_RANKINGS_ONLY'
ROOT = Path(__file__).resolve().parents[1]
COLLECTIONS = ('vs_weekly_race_receipts', 'vs_weekly_awards',
               'vs_weekly_award_index', 'vs_champion_horse_archives',
               'vs_com_career')
LIMIT = 50000


def client():
    from google.cloud import firestore
    from google.oauth2 import service_account
    secret = os.environ.get('FIREBASE_SERVICE_ACCOUNT_JSON', '').strip()
    if not secret:
        raise RuntimeError('FIREBASE_SERVICE_ACCOUNT_JSON is missing')
    details = json.loads(secret)
    if details.get('project_id') != PROJECT or os.environ.get('FIREBASE_PROJECT_ID', PROJECT) != PROJECT:
        raise RuntimeError('Wrong Firebase project; abort')
    creds = service_account.Credentials.from_service_account_info(details)
    return firestore.Client(project=PROJECT, credentials=creds)


def targets(db):
    """Only explicitly enumerated history collections. No wildcard collection group."""
    result = {}
    for name in COLLECTIONS:
        docs = list(db.collection(name).stream())
        if len(docs) > LIMIT:
            raise RuntimeError(f'{name}: safety limit exceeded')
        result[name] = docs
    weekly = []
    # Weekly parent docs may not exist; enumerate document IDs via list_documents.
    for parent in db.collection('vs_weekly_horses').list_documents():
        weekly.extend(parent.collection('horses').stream())
        if len(weekly) > LIMIT:
            raise RuntimeError('vs_weekly_horses: safety limit exceeded')
    result['vs_weekly_horses/*/horses'] = weekly
    return result


def clear_local():
    playlist = ROOT / 'race_playlist.json'
    board = ROOT / 'weekly_awards.json'
    if not playlist.exists() or not board.exists() or not (ROOT / 'races').is_dir():
        raise RuntimeError('Expected race files missing; abort')
    raw = json.loads(playlist.read_text(encoding='utf-8'))
    if raw.get('version') != 2 or not isinstance(raw.get('records'), list):
        raise RuntimeError('Unexpected playlist format; abort')
    print('Published race entries:', len(raw['records']))
    print('Local race archives:', len(list((ROOT / 'races').glob('*.json.gz'))))
    return raw


def commit_files():
    (ROOT / 'race_playlist.json').write_text(json.dumps({'version': 2, 'records': []}, indent=2) + '\n', encoding='utf-8')
    (ROOT / 'weekly_awards.json').write_text('[]\n', encoding='utf-8')
    for path in (ROOT / 'races').glob('*.json.gz'):
        path.unlink()
    def git(*args):
        return subprocess.run(['git', *args], cwd=ROOT, check=True, text=True, capture_output=True)
    git('add', '-A', '--', 'race_playlist.json', 'weekly_awards.json', 'races/')
    changed = subprocess.run(['git', 'diff', '--cached', '--quiet'], cwd=ROOT, check=False).returncode
    if changed not in (0, 1):
        raise RuntimeError('git diff failed; abort')
    if changed == 1:
        git('-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com',
            'commit', '-m', 'Reset race history and prize rankings only')
        git('push', 'origin', 'HEAD:main')
    print('Published reset race files to main')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--mode', choices=('preview', 'delete'), default='preview')
    parser.add_argument('--confirm', default='')
    args = parser.parse_args()
    if args.mode == 'delete' and args.confirm != CONFIRM:
        raise RuntimeError('Confirmation does not match; abort')
    clear_local()
    db = client()
    rows = targets(db)
    for name, docs in rows.items():
        print(f'{name}: {len(docs)} documents')
    if args.mode == 'preview':
        print('PREVIEW ONLY: no data changed')
        return
    # All snapshots and safety checks must succeed before first delete.
    for name, docs in rows.items():
        for offset in range(0, len(docs), 300):
            batch = db.batch()
            for doc in docs[offset:offset + 300]:
                batch.delete(doc.reference)
            batch.commit()
        print(f'Cleared: {name}')
    commit_files()
    print('RESET COMPLETE: owners, registrations and accounts were not touched')


if __name__ == '__main__':
    main()
