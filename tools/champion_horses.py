#!/usr/bin/env python3
"""Private archived-yearly-champion horse loader, for future exhibition races.

This library never exports original encrypted .dbfvs.json envelopes to the
public weekly_awards.json or to client-side JavaScript. Only authorized GitHub
Actions service-account code can access Firestore archive documents.

Use load_runner(token, 'YYYY-MM-DD') to retrieve the validated immutable racing
snapshot from the award's week. The returned runner is compatible with the
existing scheduled_vs.record_in_browser() entrants input.
"""
from __future__ import annotations
import re
from urllib.error import HTTPError
from weekly_awards import doc_get
from registered_horses import _firestore_value

WEEK_RE=re.compile(r'^\d{4}-\d{2}-\d{2}$')
STATS=('speed','sta','kick','early','sustain','grit','stability')


def load_runner(token:str,week_start:str)->dict:
    """Load only a non-COM champion, return a race-ready immutable snapshot.

    A year representative can have won on an older week than the current horse
    lock. Do not query mutable vs_entries, which may have been overwritten.
    """
    if not isinstance(week_start,str) or not WEEK_RE.fullmatch(week_start):
        raise ValueError('受賞週の形式は YYYY-MM-DD を指定してください')
    award=doc_get(token,'vs_weekly_awards/'+week_start)
    if not award:raise ValueError('この週の年度代表馬はまだ決定していません')
    fields=award.get('fields',{})
    if not fields.get('hasReplayHorse',{}).get('booleanValue',False):
        raise ValueError('この年度代表馬には保存された暗号化馬データがありません（COMまたは旧記録）')
    saved=doc_get(token,'vs_champion_horse_archives/'+week_start)
    if not saved:raise RuntimeError('受賞馬の保存済みデータが見つかりません')
    sf=saved.get('fields',{})
    for key in ('rankingId','ownerName','horseName','weekStart'):
        if sf.get(key,{}).get('stringValue')!=fields.get(key,{}).get('stringValue'):
            raise ValueError('保存された年度代表馬の照合に失敗しました')
    envelope=_firestore_value(sf['sourceEnvelope'])
    if (envelope.get('format')!='derby-fantasy-vs-sealed' or
        envelope.get('version')!=2 or envelope.get('cipher')!='AES-256-GCM' or
        not isinstance(envelope.get('data'),str)):
        raise ValueError('暗号化登録データが不正です')
    runner=_firestore_value(sf['runner'])
    if not isinstance(runner,dict) or runner.get('name')!=sf['horseName']['stringValue']:
        raise ValueError('保存された馬の能力データが不正です')
    if runner.get('sex') not in ('牡','牝','セ') or runner.get('tactic') not in ('逃げ','先行','差し','追込'):
        raise ValueError('保存された馬の性別・脚質が不正です')
    if any(type(runner.get(k)) not in (float,int) or not 0<=runner[k]<=500 for k in STATS):
        raise ValueError('保存された馬の能力値が不正です')
    # One private archive per award. Use the award's rankingId as a stable
    # exhibition registration ID; original weekly counts/slots are untouched.
    return {'registrationId':'champion-'+week_start,
            'runner':{**runner,'isCom':False},
            'ownerName':sf['ownerName']['stringValue'],
            'awardWeek':week_start,
            'generation':int(fields['generation']['integerValue'])}


def load_encrypted_source(token:str,week_start:str)->dict:
    """Private administrative read; never return it from the public website."""
    # Ensure the archive belongs to a replayable player champion.
    load_runner(token,week_start)
    saved=doc_get(token,'vs_champion_horse_archives/'+week_start)
    return _firestore_value(saved['fields']['sourceEnvelope'])
