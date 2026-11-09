#!/usr/bin/env python3
"""Record one official G1 in Chromium and publish a 24-hour schedule manifest.

The *existing* DBF physics and replay code run in a temporary derived page;
only the selected race's name/course metadata are substituted. If recording
fails no race is published. No placeholder or randomly invented replay is made.
"""
from __future__ import annotations

import argparse
import asyncio
import gzip
import json
import os
import re
import shutil
import socketserver
import tempfile
import threading
import time
from datetime import datetime, timezone
from functools import partial
from http.server import SimpleHTTPRequestHandler
from pathlib import Path
import registered_horses

ROOT = Path(__file__).resolve().parents[1]
SLOT_MS = 900_000
DAY_MS = 86_400_000
PAPER_MS = 30_000
RECORD_NAME = 'derby-fantasy-official-vs-replay'


def load_catalog() -> dict:
    data = json.loads((ROOT / 'race_catalog.json').read_text(encoding='utf-8'))
    if data['version'] != 1 or data['intervalMinutes'] != 15 or not data['races']:
        raise ValueError('公式GⅠ番組表が不正です')
    return data


def cycle_card(slot: int, catalog: dict) -> dict:
    anchor = int(datetime.fromisoformat(catalog['cycleStartsAt']).timestamp() * 1000) // SLOT_MS
    return catalog['races'][(slot - anchor) % len(catalog['races'])]


def price_for(place: int, card: dict) -> int:
    ratios = [1, .40, .25, .15, .10]
    if not 1 <= place <= 5:
        return 0
    # Avoid floating-point surprises on round(): all ratios are exact integer / 100.
    rate100 = [100, 40, 25, 15, 10][place - 1]
    return (card['firstPrizeYen'] * rate100 + 50) // 100


def build_game(card: dict) -> str:
    paths = [ROOT / f'vs_replay_engine_part{i}.txt' for i in (1, 2)]
    if any(not p.is_file() for p in paths):
        raise FileNotFoundError('既存のVSエンジン2ファイルが必要です。レース計算を作り直しません。')
    original = ''.join(p.read_text(encoding='utf-8') for p in paths)
    name = json.dumps(card['name'], ensure_ascii=False)
    venue = json.dumps(card['venue'], ensure_ascii=False)
    # The newspaper-first boot calls chooseMonthlyRace(), which can choose a
    # different race from the scheduled card. Select the scheduled G1 explicitly
    # before prepareNewRace(), otherwise the VS race may run at the wrong distance.
    scheduled_card = (
        "const initialCard=monthlyRaceCards(GRADED_MONTH_CORRECTIONS[" + name + "]||" +
        str(int(card['month'])) + ").find(r=>"
        "r.name===" + name + "&&r.venue===" + venue +
        "&&r.distance===" + str(int(card['distance'])) +
        "&&r.layout===" + json.dumps(card['layout'], ensure_ascii=False) +
        "&&r.surface==='芝'&&r.grade==='GⅠ');"
    )
    replacements = [
        ('const initialCard=chooseMonthlyRace();', scheduled_card),
        (
            'let currentRace=GRADED_RACES_V78[0];',
            'let currentRace=GRADED_RACES_V78.find(r=>r.name==='+name+')||GRADED_RACES_V78[0];'
        ),
        (
            "currentRace={name:'VS対戦レース',venue:'東京',surface:'芝',grade:'VS',distance,",
            'currentRace={name:'+name+',venue:'+venue+",surface:'芝',grade:'GⅠ',distance,"
        ),
        (
            "month:calendarMonth,layout:'本',weightRule:'定量',ages:'4+',classType:'vs'};",
            'month:'+str(card['month'])+',layout:'+json.dumps(card['layout'],ensure_ascii=False)+",weightRule:'定量',ages:'4+',classType:'vs'};"
        ),
        (
            "$('courseInfo').textContent=`VS対戦競馬場｜芝${distance}m｜馬場：${going}｜${STARTERS}頭`;",
            "$('courseInfo').textContent=`"+card['venue']+"競馬場｜芝${distance}m｜馬場：${going}｜${STARTERS}頭`;"
        ),
        (
            "document.querySelector('.race-title').firstChild.textContent='VS対戦レース ';",
            "document.querySelector('.race-title').firstChild.textContent="+name+"+' ';"
        ),
        (
            "document.querySelector('.race-title .g1').textContent='VS';",
            "document.querySelector('.race-title .g1').textContent='GⅠ';"
        ),
    ]
    for old, new in replacements:
        count = original.count(old)
        if count != 1:
            raise ValueError(f'エンジンの対応部分が変更されています（{count}件）：{old[:65]}')
        original = original.replace(old, new, 1)
    # Only the official production's roster SOURCE is switched. The original
    # physics, motion, camera, finish and recorder remain untouched.
    injection = r"""const field=(()=>{
      const originals=fromPreparedField();
      const incoming=Array.isArray(window.__dfOfficialEntries)?window.__dfOfficialEntries:[];
      if(!incoming.length)return originals;
      const selected=incoming.slice(0,18);
      const names=new Set(selected.map(x=>x.runner.name));
      const field=selected.map(x=>({...x.runner,registrationId:x.registrationId,
        ownerName:x.ownerName||'',isCom:false}));
      const count=Math.min(18,Math.max(originals.length,field.length));
      const fillers=originals.filter(h=>!names.has(h.name));
      field.push(...fillers.slice(0,Math.max(0,count-field.length)).map(h=>({...h,isCom:true})));
      for(let i=field.length-1;i>0;i--){
        const j=Math.floor(Math.random()*(i+1));
        [field[i],field[j]]=[field[j],field[i]];
      }
      window.__dfOfficialSelectedOrder=field.filter(x=>x.registrationId).map(x=>({
        registrationId:x.registrationId,name:x.name,ownerName:x.ownerName||''}));
      return field;
    })();"""
    if original.count('const field=fromPreparedField();') != 1:
        raise ValueError('公式出走馬フィールドの接続箇所が変更されています')
    original = original.replace('const field=fromPreparedField();', injection, 1)
    return original


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, format, *args):
        return


class ThreadedServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads = True


async def record_in_browser(card: dict, entrants: list[dict] | None = None) -> dict:
    from playwright.async_api import async_playwright

    html = build_game(card)
    with tempfile.TemporaryDirectory(prefix='dfvs-') as dirname:
        page_file = Path(dirname) / 'record.html'
        page_file.write_text(html, encoding='utf-8')
        server = ThreadedServer(('127.0.0.1', 0), partial(QuietHandler, directory=dirname))
        server_thread = threading.Thread(target=server.serve_forever, daemon=True)
        server_thread.start()
        url = f'http://127.0.0.1:{server.server_address[1]}/record.html'
        try:
            async with async_playwright() as p:
                browser_path=(shutil.which('google-chrome') or shutil.which('google-chrome-stable')
                              or shutil.which('chromium') or shutil.which('chromium-browser'))
                if not browser_path:
                    raise RuntimeError('GitHub runner にChrome/Chromiumがありません。')
                browser = await p.chromium.launch(headless=True, executable_path=browser_path, args=[
                    '--no-sandbox', '--enable-webgl', '--enable-unsafe-swiftshader',
                    '--use-gl=angle', '--use-angle=swiftshader', '--disable-gpu-sandbox',
                    '--disable-dev-shm-usage'
                ])
                try:
                    context = await browser.new_context(viewport={'width': 960, 'height': 720},
                                                       device_scale_factor=1)
                    # Playwright sets the official entrants before the original
                    # module initializes. None/[] preserves existing COM fields.
                    await context.add_init_script(script='window.__dfOfficialEntries='+
                        json.dumps(entrants or [],ensure_ascii=False,separators=(',',':'))+';')
                    page = await context.new_page()
                    errors = []
                    page.on('pageerror', lambda e: errors.append(str(e)[:250]))
                    await page.goto(url, wait_until='domcontentloaded', timeout=120_000)
                    started = time.monotonic()
                    while time.monotonic() - started < 240:
                        probe = await page.evaluate('''() => ({
                          status:document.querySelector('#dfOfficialProductionStatus')?.textContent||'',
                          ready:!!window.__raceReady3D,
                          error:window.__df47BootError||'',
                          startReady:typeof window.__df47Start3D==='function'
                        })''')
                        if probe['error'] or '記録準備に失敗' in probe['status']:
                            raise RuntimeError('DBFレース生成失敗：'+str(probe))
                        if '再生できます' in probe['status']:
                            record = await page.evaluate('''async () => await window.DFOfficialVSReplay.latest()''')
                            if not isinstance(record, dict):
                                raise RuntimeError('完走記録を読み戻せませんでした。')
                            if entrants:
                                selected = await page.evaluate('''() => window.__dfOfficialSelectedOrder || []''')
                                expected = {x['registrationId']:x['runner']['name'] for x in entrants}
                                if len(selected) != len(entrants) or any(
                                        expected.get(x.get('registrationId')) != x.get('name')
                                        for x in selected):
                                    raise ValueError('登録馬がレースエンジンへ渡されていません')
                                names = [h.get('name') for h in record.get('field',[])]
                                for registered in selected:
                                    if registered['name'] not in names:
                                        raise ValueError('登録馬が完走記録に存在しません: '+registered['name'])
                                stamp_record_owners(record, entrants)
                                record['registrations']=[x['registrationId'] for x in selected]
                                record['horseTokens']=[x['horseToken'] for x in entrants]
                            return record
                        if probe['startReady'] and not probe['ready']:
                            await page.evaluate('''() => window.__df47Start3D()''')
                        await asyncio.sleep(1)
                    raise TimeoutError('ゲーム内の完走記録作成が時間切れです：'+
                                       str(probe)+' / '+str(errors[:3]))
                finally:
                    await browser.close()
        finally:
            server.shutdown()
            server.server_close()


def stamp_record_owners(record: dict, entrants: list[dict]) -> None:
    """Preserve user-supplied PUBLIC owner display names in genuine finished results.

    Identify horses by the recorder's registration receipt and/or verified
    horse number. Only use unique-name fallback when there are no collisions.
    COM horses never receive an owner. UID and source JSON remain private.
    """
    field = record.get('field', [])
    results = record.get('results', [])
    if not isinstance(field, list) or not isinstance(results, list):
        return
    by_receipt = {entry['registrationId']: entry for entry in entrants}
    names = {}
    for entry in entrants:
        names.setdefault(entry['runner']['name'], []).append(entry)
    field_names = [row.get('name') for row in field if isinstance(row, dict)]
    result_names = [row.get('name') for row in results if isinstance(row, dict)]

    def row_number(row):
        if not isinstance(row, dict):
            return None
        for key in ('no', 'number', 'horseNo', 'horseNumber'):
            value = row.get(key)
            if type(value) is int and 1 <= value <= 18:
                return value
        return None

    by_number = {}
    by_unique_name = {}
    for item in field:
        if not isinstance(item, dict):
            continue
        entry = by_receipt.get(item.get('registrationId'))
        name = item.get('name')
        if entry is None and isinstance(name, str) and field_names.count(name) == 1 and len(names.get(name, [])) == 1:
            entry = names[name][0]
        if not entry or entry['runner']['name'] != name:
            continue
        owner = entry.get('ownerName', '')
        if not owner:
            continue
        item['ownerName'] = owner
        number = row_number(item)
        if number is not None:
            by_number[number] = (name, owner)
        if field_names.count(name) == 1 and result_names.count(name) == 1:
            by_unique_name[name] = owner

    for row in results:
        if not isinstance(row, dict):
            continue
        # Only a verified Firestore registration may supply a public owner.
        row.pop('ownerName', None)
        name, number = row.get('name'), row_number(row)
        found = by_number.get(number)
        if found is not None and found[0] == name:
            row['ownerName'] = found[1]
        elif name in by_unique_name:
            row['ownerName'] = by_unique_name[name]


def validate_record(record: dict, card: dict) -> None:
    if record.get('schema') != RECORD_NAME or record.get('version') != 2 or record.get('status') != 'complete':
        raise ValueError('保存データの形式が違います')
    race = record.get('race', {})
    if (race.get('name') != card['name'] or race.get('venue') != card['venue'] or
            race.get('distance') != card['distance'] or race.get('surface') != '芝'):
        raise ValueError('開催予定のGⅠと記録レースの条件が一致しません')
    field = record.get('field', [])
    frames = record.get('frames', [])
    results = record.get('results', [])
    if not 2 <= len(field) <= 18 or len(results) != len(field) or len(frames) < 2:
        raise ValueError('完走記録に馬・フレーム・結果が不足しています')
    if not 0 < record.get('durationMs', 0) < SLOT_MS-PAPER_MS:
        raise ValueError('レースが10分の開催枠に収まりません')
    if not isinstance(record.get('newspaper', {}).get('entries'), str):
        raise ValueError('競馬新聞が保存されていません')
    for place, row in enumerate(results, 1):
        if row.get('place') != place or not isinstance(row.get('name'), str) or not row['name']:
            raise ValueError('確定した着順が不正です')
        if not isinstance(row.get('timeSeconds'), (float, int)) or row['timeSeconds'] < 0:
            raise ValueError('走破タイムが不正です')


def metadata_for(record: dict, card: dict, slot: int) -> dict:
    return {
        'registrations': record.get('registrations', []),
        'horseTokens': record.get('horseTokens', []),
        'registrationSnapshotMs': record.get('registrationSnapshotMs', 0),
        'slot': slot,
        'intervalMinutes': 15,
        'file': f'races/{slot}.json.gz',
        'raceId': record['raceId'],
        'name': card['name'], 'venue': card['venue'],
        'distance': card['distance'], 'month': card['month'],
        'durationMs': record['durationMs'],
        'firstPrizeYen': card['firstPrizeYen'],
        'results': [{
            'place': row['place'], 'no': row['no'], 'name': row['name'],
            'timeSeconds': row['timeSeconds'], 'margin': row.get('margin', '―'),
            'prizeYen': price_for(row['place'], card),
            **({'ownerName': row['ownerName']} if row.get('ownerName') else {})
        } for row in record['results']]
    }


def has_expired(row: dict, at_ms: int) -> bool:
    # Preserve the 24-hour retention of existing 10-minute records after the changeover.
    interval = int(row.get('intervalMinutes', 10))
    if interval not in (10, 15):
        raise ValueError('記録の開催間隔が不正です')
    completed = row['slot'] * interval * 60_000 + PAPER_MS + row['durationMs']
    return completed + DAY_MS <= at_ms


def public_registration_summary(entries: list[dict], catalog: dict,
                                records: list[dict], as_of_ms: int,
                                published_at_ms: int | None = None) -> dict:
    """Only publish aggregate counts. Never publish personal IDs or horse stats.

    A recorded upcoming slot already has its final selected entrants; an
    unrecorded slot has only candidates. Both are labelled explicitly.
    """
    next_slot = ((int(time.time() * 1000) if published_at_ms is None else published_at_ms) // SLOT_MS) + 1
    card = cycle_card(next_slot, catalog)
    published = next((row for row in records if row.get('intervalMinutes') == 15
                      and row.get('slot') == next_slot), None)
    if published is not None:
        candidate_count = len(published.get('registrations', []))
        final = True
    else:
        candidate_count = len(registered_horses.choose(entries, card, next_slot, records))
        final = False
    return {
        'version': 1,
        'registeredCount': registered_horses.unique_horse_count(entries),
        'asOfMs': as_of_ms,
        'nextSlot': next_slot,
        'nextCandidateCount': candidate_count,
        'nextFinal': final,
    }


def publish_record(record: dict | None, card: dict | None, slot: int, now_ms: int,
                   registered: list[dict] | None = None,
                   catalog: dict | None = None,
                   registered_at_ms: int | None = None) -> tuple[int, int]:
    manifest_path = ROOT / 'race_playlist.json'
    current = json.loads(manifest_path.read_text(encoding='utf-8')) if manifest_path.exists() else {'version': 2,'records': []}
    if current.get('version') != 2:
        raise ValueError('旧版のレース一覧は使用できません')
    records = [r for r in current.get('records', []) if not has_expired(r, now_ms)]
    if record is not None:
        if card is None:
            raise ValueError('レース条件が必要です')
        validate_record(record, card)
        target = ROOT / 'races' / f'{slot}.json.gz'
        target.parent.mkdir(exist_ok=True)
        payload = json.dumps(record, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8')
        if len(payload) > 45_000_000:
            raise ValueError('保存記録が45MBを超えています')
        with target.open('wb') as f:
            with gzip.GzipFile(fileobj=f, mode='wb', compresslevel=6, mtime=0) as gz:
                gz.write(payload)
        records = [r for r in records if r['slot'] != slot]
        records.append(metadata_for(record, card, slot))
    records.sort(key=lambda x: x['slot'])
    if len(records) > 160:
        raise ValueError('保存期間を超える記録が残っています')
    manifest = {'version': 2, 'records': records}
    # Preserve the previous valid snapshot if Firebase is temporarily unreachable.
    snapshot = current.get('registrationSummary')
    if registered is not None and catalog is not None and registered_at_ms is not None:
        try:
            snapshot = public_registration_summary(registered, catalog, records, registered_at_ms)
        except Exception as error:
            print('WARNING: entry count summary unavailable:', repr(error), flush=True)
    if isinstance(snapshot, dict):
        manifest['registrationSummary'] = snapshot
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    keep = {row['file'] for row in records}
    for file in (ROOT/'races').glob('*.json.gz'):
        if file.relative_to(ROOT).as_posix() not in keep:
            file.unlink()
    return len(records), len(list((ROOT/'races').glob('*.json.gz')))


def scheduled_slot(now_ms: int) -> int:
    """For the :08/:23/:38/:53 cron, do not skip a race if GitHub starts late.

    Before the :15 boundary, record the upcoming race. If the runner starts
    after that boundary (up to the next scheduled preparation), record the
    still-current race rather than skipping it for the following slot.
    This never creates two slots in one run.
    """
    current = now_ms // SLOT_MS
    elapsed = now_ms % SLOT_MS
    return current + (1 if elapsed >= 8 * 60_000 else 0)


def pending_record_slots(now_ms: int, catalog: dict, records: list[dict]) -> list[int]:
    """Prioritize the next scheduled race, then backfill the newest missing slot.

    Bound each invocation to two recordings so a long backlog cannot block the
    next 15-minute GitHub Actions run. Only repair slots still within 24 hours.
    A repeated/late workflow is idempotent and will not overwrite valid races.
    """
    primary = scheduled_slot(now_ms)
    valid = {row['slot'] for row in records
             if row.get('intervalMinutes') == 15 and
             (ROOT / row['file']).is_file() and not has_expired(row, now_ms)}
    anchor = int(datetime.fromisoformat(catalog['cycleStartsAt']).timestamp()*1000)//SLOT_MS
    earliest = max(anchor, (now_ms-DAY_MS+SLOT_MS-1)//SLOT_MS)
    current = now_ms//SLOT_MS
    pending = []
    if primary not in valid:
        pending.append(primary)
    # The current slot must not be treated as a missed slot if it is the primary.
    for slot in range(current, earliest-1, -1):
        if len(pending)>=2:
            break
        if slot!=primary and slot not in valid:
            pending.append(slot)
    return pending


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--slot', type=int, help='test/manual exact epoch 15-minute slot')
    parser.add_argument('--record-file', type=Path, help='test-only: use genuine saved record JSON instead of Chromium')
    args = parser.parse_args()
    now_ms = int(time.time()*1000)
    catalog = load_catalog()
    if args.slot is not None:
        slots = [args.slot]
    else:
        manifest = json.loads((ROOT/'race_playlist.json').read_text(encoding='utf-8'))
        if manifest.get('version') != 2:
            raise ValueError('開催記録一覧の版が不正です')
        slots = pending_record_slots(now_ms, catalog, manifest['records'])
    # Reuse the existing one-time server-side Firestore read; never expose entries.
    # A missing secret / failed read is "unknown", not falsely "zero registered".
    registered = None
    registered_at_ms = None
    if os.getenv('FIREBASE_SERVICE_ACCOUNT_JSON', '').strip():
        try:
            registered = registered_horses.load()
            registered_at_ms = int(time.time() * 1000)
            print('Official VS registered horses loaded:',len(registered),flush=True)
        except Exception as error:
            # Never stop the established race because the registration DB is down.
            print('WARNING: registration database unavailable, COM-only race continues:',
                  repr(error),flush=True)
    else:
        print('VS registration: secret missing; aggregate count unavailable.',flush=True)
    if not slots:
        print('Current race already recorded; checking 24-hour retention.', flush=True)
        print('Remaining records:', publish_record(None,None,scheduled_slot(now_ms),now_ms,
              registered,catalog,registered_at_ms), flush=True)
        return
    print('Recording slots (scheduled, missing):', slots, flush=True)
    for i,slot in enumerate(slots):
        card = cycle_card(slot, catalog)
        print('G1 slot:', datetime.fromtimestamp(slot*SLOT_MS/1000,timezone.utc).isoformat(), card['name'], flush=True)
        try:
            existing = json.loads((ROOT/'race_playlist.json').read_text(encoding='utf-8'))['records']
            entrants = registered_horses.choose(registered or [],card,slot,existing)
            print('Registered entrants for',card['name'],':',len(entrants),flush=True)
            if args.record_file:
                record = json.loads(args.record_file.read_text(encoding='utf-8'))
            else:
                try:
                    record = await record_in_browser(card,entrants)
                except Exception:
                    if not entrants:
                        raise
                    # A new registered horse must never stop the established
                    # COM-only 15-minute event. Keep the original race running.
                    import traceback
                    traceback.print_exc()
                    print('WARNING: registered roster failed; retrying established COM field.',flush=True)
                    record = await record_in_browser(card,[])
            if record.get('registrations') and registered_at_ms is not None:
                record['registrationSnapshotMs'] = registered_at_ms
            print('Recording finished:',record.get('durationMs'),'ms',len(record.get('results',[])),'horses', flush=True)
            print('Remaining records:',publish_record(record,card,slot,now_ms,
                  registered,catalog,registered_at_ms), flush=True)
        except Exception:
            if i==0 or args.slot is not None:
                raise
            # A failed historical backfill must not suppress publication of the
            # successfully recorded upcoming race. Expose the full failure in logs.
            import traceback
            traceback.print_exc()
            print('Warning: missed slot will be retried by a later run:',slot,flush=True)


if __name__=='__main__':
    asyncio.run(main())
