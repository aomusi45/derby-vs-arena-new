#!/usr/bin/env python3
"""One-off DBF VS registration RESET (never touched by the regular race workflow).

ONLY the administrator who owns the GitHub Actions Firebase service-account secret
can run it. Preserves all COM data, historical race files and replay archives,
replay receipts and (anonymous) deduplication receipts. It does NOT delete
Firebase Authentication users or hosted application code.

Preview first. Execute requires --confirm DELETE_ALL_OWNER_AND_HORSE_REGISTRATIONS.
"""
from __future__ import annotations

import argparse
from collections import Counter
import json
import os
import sys
from typing import Any

PROJECT_ID = 'derby-vs-arena'
CONFIRM = 'DELETE_ALL_OWNER_AND_HORSE_REGISTRATIONS'

# These collections contain exclusively owner accounts / registration state,
# not COM competitors, historical published race results, or Firebase Auth users.
OWNER_ONLY_COLLECTIONS = (
    'vs_entries',
    'vs_public_entries',
    'vs_owner_profiles',
    'vs_owner_names',
    'vs_owner_horse_locks',
    'vs_ever_registered_horses',
    'vs_horse_usage',
    'vs_weekly_candidate_payloads',
    'vs_weekly_registration_counts',
)
# Collections that mix COM and human-player entries; NEVER bulk-clear these.
PLAYER_ONLY_FILTERED_COLLECTIONS = (
    'vs_weekly_horses',
    'vs_weekly_awards',
    'vs_champion_horse_archives',
)


def is_player_record(collection: str, path: str, doc_id: str, data: dict[str, Any]) -> bool:
    """Fail closed on ambiguous mixed-data records: never delete COM records."""
    if collection == 'vs_weekly_horses':
        bits = path.split('/')
        if len(bits) != 4 or bits[0] != 'vs_weekly_horses' or bits[2] != 'horses':
            return False
        if data.get('isCom') is True or doc_id.startswith('c_'):
            return False
        return (doc_id.startswith('p_') or (data.get('isCom') is False and
                bool(str(data.get('ownerName') or '').strip())))
    if collection in ('vs_weekly_awards', 'vs_champion_horse_archives'):
        if data.get('isCom') is True or str(data.get('rankingId') or '').startswith('c_'):
            return False
        return (str(data.get('rankingId') or '').startswith('p_') or
                bool(str(data.get('ownerName') or '').strip()))
    return False


def firestore_client():
    """Use the already configured Actions secret, no tokens printed to logs."""
    from google.oauth2 import service_account
    from google.cloud import firestore
    secret = os.environ.get('FIREBASE_SERVICE_ACCOUNT_JSON', '').strip()
    if not secret:
        raise RuntimeError('GitHub Actions secret FIREBASE_SERVICE_ACCOUNT_JSON が未設定です')
    details = json.loads(secret)
    if details.get('project_id') != PROJECT_ID:
        raise RuntimeError('サービスアカウントのプロジェクトが一致しません。削除を中止します')
    if os.environ.get('FIREBASE_PROJECT_ID', PROJECT_ID) != PROJECT_ID:
        raise RuntimeError('実行対象プロジェクトが一致しません。削除を中止します')
    credentials = service_account.Credentials.from_service_account_info(details)
    return firestore.Client(project=PROJECT_ID, credentials=credentials)


def snapshot_reset_targets(db, max_documents=50000):
    """Scan without logging private names, UIDs, or snapshots."""
    targets = {}
    for collection in OWNER_ONLY_COLLECTIONS:
        docs = []
        for snap in db.collection(collection).stream():
            docs.append(snap)
            if len(docs) > max_documents:
                raise RuntimeError('対象データが安全上限を超えました。手動調査が必要です')
        targets[collection] = docs

    # A weekly parent might be a missing document, so collection_group is required.
    mixed = {'vs_weekly_horses': db.collection_group('horses').stream(),
             'vs_weekly_awards': db.collection('vs_weekly_awards').stream(),
             'vs_champion_horse_archives': db.collection('vs_champion_horse_archives').stream()}
    for collection, it in mixed.items():
        selected = []
        seen = 0
        for snap in it:
            seen += 1
            if seen > max_documents:
                raise RuntimeError('ランキング検索が安全上限を超えました。手動調査が必要です')
            try:
                row = snap.to_dict() or {}
            except Exception as exc:
                raise RuntimeError('Firestoreランキングの取得に失敗しました') from exc
            if not isinstance(row, dict):
                raise RuntimeError('Firestoreランキングの形式が不正です')
            if is_player_record(collection, snap.reference.path, snap.id, row):
                selected.append(snap)
        targets[collection] = selected
    return targets


def snapshot_summary(targets):
    return {name: len(rows) for name, rows in targets.items()}


def delete_snapshots(db, targets):
    """Delete only the previously inventoried docs in small batches.

    `last_update_time` preconditions protect records updated since the scan.
    Failed batches stop the workflow instead of claiming a completed reset.
    """
    from google.cloud.firestore_v1 import LastUpdateOption
    counts = Counter()
    for coll, snapshots in targets.items():
        for start in range(0, len(snapshots), 200):
            batch = db.batch()
            for snap in snapshots[start:start + 200]:
                if snap.update_time is None:
                    raise RuntimeError('更新日時が不明な登録データを削除できません')
                batch.delete(snap.reference, option=LastUpdateOption(snap.update_time))
            batch.commit()
            counts[coll] += len(snapshots[start:start + 200])
            print(f'削除済: {coll} +{len(snapshots[start:start + 200])}件', flush=True)
    return dict(counts)


def main(argv=None):
    parser = argparse.ArgumentParser(description='DBF arena owner/horse registration reset')
    parser.add_argument('--mode', choices=('preview', 'delete'), default='preview')
    parser.add_argument('--confirm', default='')
    args = parser.parse_args(argv)
    if args.mode == 'delete' and args.confirm != CONFIRM:
        raise RuntimeError('実行確認文字列が一致しません。削除しません')

    db = firestore_client()
    print('プロジェクト: derby-vs-arena / 登録関連のデータのみ', flush=True)
    targets = snapshot_reset_targets(db)
    counts = snapshot_summary(targets)
    total = sum(counts.values())
    print('対象件数（個人情報の名称・UIDはログ出力しません）:', flush=True)
    for name, num in counts.items():
        print(f'  {name}: {num}件', flush=True)
    print(f'対象合計: {total}件', flush=True)
    if args.mode == 'preview':
        print('プレビュー完了：削除は一切実行していません', flush=True)
        return
    if total == 0:
        print('対象データは既に0件です。', flush=True)
        return
    print('指定された登録データの削除を開始します', flush=True)
    done = delete_snapshots(db, targets)
    if sum(done.values()) != total:
        raise RuntimeError('削除件数が一致しません。途中で終了しました')
    # Race workflows serialize via the same GitHub concurrency group; a website
    # user may still register concurrently. Fail if that happened, rather than
    # falsely reporting a totally clear state.
    after = snapshot_summary(snapshot_reset_targets(db))
    remaining = sum(after.values())
    if remaining:
        print('削除後に登録関連のデータが追加・更新されました:', after, flush=True)
        raise RuntimeError('削除後も対象データが残っています。登録中のアクセスがない時に再実行してください')
    print('完了：対象のオーナー・登録馬データはすべて0件になりました', flush=True)
    print('過去レース結果、COM馬、匿名の出走照合レシート、Firebase Authユーザーは保持しています',flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('エラー:', str(error), file=sys.stderr, flush=True)
        sys.exit(1)
