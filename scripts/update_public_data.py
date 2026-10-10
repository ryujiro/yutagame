"""GitHub Actions用。秘密を記録せず、実取得結果だけを公開JSONに保存する。"""
from __future__ import annotations

import asyncio
import json
import os
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from learning_records import clean_record
from smile_zemi import JST, REQUIRED_ENV, STAGES, VerificationError, fetch_today_learning_time

SAFE_CODES = {'manual_authentication_required', 'single_child_required_manual_selection_needed'}
STATUSES = {'not_configured', 'passed', 'failed', 'missing_credentials'}


def clean_state(value: dict) -> dict:
    history = sorted((clean_record(row) for row in value['history']),
                     key=lambda row: row['fetched_at'], reverse=True)[:100]
    attempt = value.get('last_attempt')
    if attempt is not None:
        parsed = datetime.fromisoformat(attempt)
        if parsed.tzinfo is None:
            raise ValueError('timezone_required')
        attempt = parsed.astimezone(JST).isoformat(timespec='seconds')
    status = value.get('collection_status')
    status = status if status in STATUSES else 'not_configured'
    return {'history': history, 'last_attempt': attempt, 'collection_status': status,
            'failure_stage': value.get('failure_stage') if status == 'failed' and value.get('failure_stage') in STAGES else None,
            'failure_code': value.get('failure_code') if status == 'failed' and value.get('failure_code') in SAFE_CODES else None}


def write_state(path: Path, state: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(clean_state(state), ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    temporary.replace(path)


async def update(path: Path, *, fetcher=fetch_today_learning_time,
                 clock=lambda: datetime.now(JST), environ=None) -> tuple[int, dict]:
    environ = os.environ if environ is None else environ
    # 壊れた既存データは推測して置き換えず、認証前に止める。
    state = clean_state(json.loads(path.read_text(encoding='utf-8')))
    progress = dict.fromkeys(STAGES, 'unverified')
    missing = [name for name in REQUIRED_ENV if not environ.get(name)]
    if missing:
        state.update(collection_status='missing_credentials', failure_stage=None, failure_code=None)
        write_state(path, state)
        return 2, {'status': 'not_acquired', 'missing_environment_variables': missing, 'stages': progress}
    now = clock()
    if state['last_attempt'] and (now - datetime.fromisoformat(state['last_attempt'])).total_seconds() < 600:
        return 0, {'status': 'skipped', 'reason': 'cooldown', 'stages': progress}
    state.update(last_attempt=now.isoformat(timespec='seconds'), collection_status='failed',
                 failure_stage='connection', failure_code=None)
    # 保存できない場合はログインしない。Actionsの同時実行もconcurrencyで直列化する。
    write_state(path, state)
    try:
        result = clean_record(await asyncio.wait_for(fetcher(progress=progress), timeout=200))
        if result['date'] != clock().date().isoformat():
            raise VerificationError('extraction', 'jst_date_changed_retry_required')
        state['history'] = [result, *[row for row in state['history'] if row['fetched_at'] != result['fetched_at']]][:100]
        state.update(collection_status='passed', failure_stage=None, failure_code=None)
        write_state(path, state)
        return 0, {'status': 'acquired', 'record': result, 'stages': progress}
    except Exception as error:
        stage = error.stage if isinstance(error, VerificationError) and error.stage in STAGES else next((stage for stage in STAGES if progress[stage] != 'passed'), 'extraction')
        code = error.code if isinstance(error, VerificationError) and error.code in SAFE_CODES else None
        progress[stage] = 'blocked' if code == 'manual_authentication_required' else 'failed'
        state.update(collection_status='failed', failure_stage=stage, failure_code=code)
        write_state(path, state)
        # 元の例外・HTML・URL・Cookie・入力値は出力しない。
        return 2, {'status': 'not_acquired', 'stage': stage, 'stages': progress}


def main() -> int:
    try:
        code, report = asyncio.run(update(ROOT / 'public-data/dashboard.json'))
    except Exception:
        code, report = 3, {'status': 'not_acquired', 'reason': 'state_or_runtime_unavailable'}
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return code


if __name__ == '__main__':
    raise SystemExit(main())
