#!/usr/bin/env python3
"""Safely publish official VS replay files from an ephemeral GitHub Actions checkout.

The recorder has already written races/*.json.gz and race_playlist.json.
If main moved while the race was being recorded, merge those generated races
with the latest remote records instead of force-pushing or overwriting a manifest.
Never re-run the race simulation on a push conflict.
"""
from __future__ import annotations

import json
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SLOT_MS = 900_000
DAY_MS = 86_400_000
PAPER_MS = 30_000
MAX_RETRIES = 6


def git(*args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    p = subprocess.run(['git', *args], cwd=ROOT, text=True, capture_output=True)
    if check and p.returncode:
        raise RuntimeError(f"git {' '.join(args)} failed ({p.returncode}):\n{p.stdout}{p.stderr}")
    return p


def manifest_rows(raw: dict) -> dict[int, dict]:
    if not isinstance(raw, dict) or raw.get('version') != 2 or not isinstance(raw.get('records'), list):
        raise ValueError('race_playlist.json の形式が不正です')
    rows = {}
    for row in raw['records']:
        if not isinstance(row, dict) or type(row.get('slot')) is not int:
            raise ValueError('レース枠番号が不正です')
        slot = row['slot']
        expected = f'races/{slot}.json.gz'
        if slot < 0 or row.get('file') != expected:
            raise ValueError('レース記録のファイル名が不正です')
        if int(row.get('intervalMinutes', 10)) not in (10, 15):
            raise ValueError('レース記録の間隔が不正です')
        if slot in rows:
            raise ValueError(f'同じレース枠が重複しています: {slot}')
        rows[slot] = row
    return rows


def load_manifest() -> dict[int, dict]:
    path = ROOT / 'race_playlist.json'
    return manifest_rows(json.loads(path.read_text(encoding='utf-8')) if path.exists()
                         else {'version': 2, 'records': []})


def old_manifest() -> dict[int, dict]:
    p = git('show', 'HEAD:race_playlist.json', check=False)
    if p.returncode:
        # An empty initial repository may have no manifest; do not silently
        # treat other git failures as an empty manifest.
        if 'does not exist' in p.stderr or 'exists on disk, but not in' in p.stderr:
            return {}
        raise RuntimeError('元のレース一覧を読み取れません: ' + p.stderr)
    return manifest_rows(json.loads(p.stdout))


def expired(row: dict, now_ms: int) -> bool:
    interval = int(row.get('intervalMinutes', 10))
    duration = row['durationMs']
    if not isinstance(duration, (int, float)) or duration < 0:
        raise ValueError('完走記録の所要時間が不正です')
    completed = row['slot'] * interval * 60_000 + PAPER_MS + duration
    return completed + DAY_MS <= now_ms


def snapshot_generated() -> dict[int, tuple[dict, bytes]]:
    """Capture ONLY records added/updated by this run before resetting checkout."""
    previous = old_manifest()
    latest = load_manifest()
    generated = {}
    for slot, row in latest.items():
        if previous.get(slot) == row:
            continue
        path = ROOT / row['file']
        if not path.is_file():
            raise FileNotFoundError(f'生成済みレース記録がありません: {row["file"]}')
        data = path.read_bytes()
        if not data.startswith(b'\x1f\x8b'):
            raise ValueError(f'レース記録がgzip形式ではありません: {row["file"]}')
        generated[slot] = (row, data)
    return generated


def entry_summary_from(raw: dict) -> dict | None:
    """Validate a public aggregate; never accept user details in the manifest."""
    entry = raw.get('registrationSummary')
    if not isinstance(entry, dict) or set(entry) != {
            'version', 'registeredCount', 'asOfMs', 'nextSlot',
            'nextCandidateCount', 'nextFinal'}:
        return None
    if (entry['version'] != 1 or type(entry['registeredCount']) is not int or
            not 0 <= entry['registeredCount'] <= 150 or
            type(entry['asOfMs']) is not int or entry['asOfMs'] < 1 or
            type(entry['nextSlot']) is not int or entry['nextSlot'] < 1 or
            type(entry['nextCandidateCount']) is not int or
            not 0 <= entry['nextCandidateCount'] <= 18 or
            type(entry['nextFinal']) is not bool):
        return None
    return entry


def integrate(generated: dict[int, tuple[dict, bytes]], now_ms: int,
              generated_summary: dict | None = None) -> tuple[int, int]:
    """Merge generated slots and summary. Newest aggregate wins; remote wins race ties."""
    current_raw = json.loads((ROOT / 'race_playlist.json').read_text(encoding='utf-8'))
    current = manifest_rows(current_raw)
    records = {slot: row for slot, row in current.items() if not expired(row, now_ms)}
    added = 0
    for slot, (row, data) in generated.items():
        if slot in records or expired(row, now_ms):
            # A concurrent runner has already published this slot. Keep that
            # recorded replay and its results, never replace it with a rerun.
            continue
        (ROOT / 'races').mkdir(exist_ok=True)
        (ROOT / row['file']).write_bytes(data)
        records[slot] = row
        added += 1
    if len(records) > 160:
        raise ValueError('保存可能な24時間分のレース記録を超えています')
    keep = {row['file'] for row in records.values()}
    for row in records.values():
        if not (ROOT / row['file']).is_file():
            raise FileNotFoundError('公開一覧の記録ファイルが不足しています: ' + row['file'])
    race_dir = ROOT / 'races'
    race_dir.mkdir(exist_ok=True)
    for path in race_dir.glob('*.json.gz'):
        if path.relative_to(ROOT).as_posix() not in keep:
            path.unlink()
    manifest = {'version': 2, 'records': [records[k] for k in sorted(records)]}
    remote_summary = entry_summary_from(current_raw)
    winner = remote_summary
    if generated_summary is not None and (remote_summary is None or
            generated_summary['asOfMs'] > remote_summary['asOfMs']):
        winner = generated_summary
    if winner is not None:
        manifest['registrationSummary'] = winner
    if manifest != current_raw:
        (ROOT / 'race_playlist.json').write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return added, len(records)


def main() -> None:
    # Take the only snapshot before any hard reset of the temporary CI checkout.
    generated = snapshot_generated()
    # Capture the aggregate BEFORE reset --hard clears runner-generated files.
    summary_raw = json.loads((ROOT / 'race_playlist.json').read_text(encoding='utf-8'))
    generated_summary = entry_summary_from(summary_raw)
    print(f'Race records to integrate: {len(generated)}', flush=True)
    git('config', 'user.name', 'github-actions[bot]')
    git('config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com')
    for attempt in range(1, MAX_RETRIES + 1):
        git('fetch', 'origin', 'main')
        # Safe inside GitHub Actions' throwaway checkout: generated replay bytes
        # have been snapshotted, and we only ever commit race data. This does NOT
        # reset the remote branch, nor use --force.
        git('reset', '--hard', 'origin/main')
        git('clean', '-fd', '--', 'races/')
        added, count = integrate(generated, int(time.time() * 1000), generated_summary)
        git('add', '-A', '--', 'race_playlist.json', 'races/')
        if git('diff', '--cached', '--quiet', check=False).returncode == 0:
            print(f'Published data already current ({count} records, {added} new).', flush=True)
            return
        git('commit', '-m', 'Official VS scheduled G1 record and 24h retention')
        pushed = git('push', 'origin', 'HEAD:main', check=False)
        if pushed.returncode == 0:
            print(f'Race records published ({added} new, {count} retained) on attempt {attempt}.', flush=True)
            return
        error = (pushed.stdout + pushed.stderr).lower()
        if 'fetch first' not in error and 'non-fast-forward' not in error and 'failed to push some refs' not in error:
            raise RuntimeError('レース記録の保存に失敗しました（競合以外）:\n' + pushed.stderr)
        if attempt == MAX_RETRIES:
            raise RuntimeError(f'GitHubの保存競合が{MAX_RETRIES}回続きました。レース記録は未公開です。\n' + pushed.stderr)
        print(f'Concurrent update detected; fetching and merging (attempt {attempt}/{MAX_RETRIES}).', flush=True)
        time.sleep(min(attempt, 4))


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(f'ERROR: {exc}', file=sys.stderr, flush=True)
        raise
