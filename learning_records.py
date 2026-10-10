"""公開できる学習記録の項目だけを検証・抽出する。"""
from datetime import date, datetime
from typing import Any

from smile_zemi import JST, SUBJECT_NAMES


def clean_record(value: Any) -> dict:
    if not isinstance(value, dict):
        raise ValueError('invalid_record')
    day = value.get('date')
    if not isinstance(day, str) or date.fromisoformat(day).isoformat() != day:
        raise ValueError('invalid_date')
    total = value.get('total_minutes')
    if type(total) is not int or total < 0:
        raise ValueError('invalid_minutes')
    fetched = datetime.fromisoformat(value['fetched_at'])
    if fetched.tzinfo is None:
        raise ValueError('timezone_required')
    subjects = value.get('subjects')
    if subjects is not None:
        if not isinstance(subjects, dict) or not subjects:
            raise ValueError('invalid_subjects')
        if any(k not in SUBJECT_NAMES.values() or type(v) is not int or v < 0 for k, v in subjects.items()):
            raise ValueError('invalid_subjects')
        if sum(subjects.values()) != total:
            raise ValueError('subject_total_mismatch')
        subjects = dict(subjects)
    return {'date': day, 'total_minutes': total, 'subjects': subjects,
            'fetched_at': fetched.astimezone(JST).isoformat(timespec='seconds')}
