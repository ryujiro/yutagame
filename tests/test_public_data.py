import json
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path

from scripts.update_public_data import update
from smile_zemi import JST, STAGES, VerificationError

NOW = datetime(2026, 10, 10, 19, 0, tzinfo=JST)
RECORD = {'date': '2026-10-10', 'total_minutes': 7, 'subjects': {'数学': 7}, 'fetched_at': NOW.isoformat(timespec='seconds')}
ENV = {'SMILE_ZEMI_LOGIN_ID': 'synthetic-id', 'SMILE_ZEMI_PASSWORD': 'synthetic-password'}


class PublicDataTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / 'dashboard.json'
        self.seed = {**RECORD, 'fetched_at': (NOW - timedelta(hours=2)).isoformat(timespec='seconds')}
        self.path.write_text(json.dumps({'history': [self.seed], 'last_attempt': None, 'collection_status': 'not_configured'}))

    async def run_update(self, fetcher, **kwargs):
        return await update(self.path, fetcher=fetcher, clock=lambda: NOW, environ=ENV, **kwargs)

    async def test_success_sanitizes_result_and_history(self):
        async def fetcher(**kwargs):
            for stage in STAGES:
                kwargs['progress'][stage] = 'passed'
            return {**RECORD, 'password': 'synthetic-secret', 'child_name': 'synthetic-name'}
        code, report = await self.run_update(fetcher)
        self.assertEqual(code, 0)
        self.assertEqual(report['record'], RECORD)
        saved = json.loads(self.path.read_text())
        self.assertEqual(saved['collection_status'], 'passed')
        self.assertEqual(len(saved['history']), 2)
        self.assertNotIn('synthetic', self.path.read_text())
        self.assertEqual(saved['last_attempt'], RECORD['fetched_at'])

    async def test_missing_credentials_never_calls_fetcher(self):
        async def fetcher(**kwargs):
            self.fail('authentication_attempted')
        code, report = await update(self.path, fetcher=fetcher, clock=lambda: NOW, environ={})
        self.assertEqual(code, 2)
        self.assertEqual(report['missing_environment_variables'], list(ENV))
        self.assertEqual(json.loads(self.path.read_text())['history'], [self.seed])

    async def test_failure_preserves_data_and_persists_cooldown(self):
        calls = 0
        async def fetcher(**kwargs):
            nonlocal calls
            calls += 1
            kwargs['progress']['connection'] = 'passed'
            kwargs['progress']['login_page'] = 'passed'
            raise VerificationError('authentication', 'login_rejected')
        code, report = await self.run_update(fetcher)
        self.assertEqual(code, 2)
        self.assertEqual(report['stages']['authentication'], 'failed')
        self.assertEqual(json.loads(self.path.read_text())['history'], [self.seed])
        code, report = await self.run_update(fetcher)
        self.assertEqual(code, 0)
        self.assertEqual(report['reason'], 'cooldown')
        self.assertEqual(calls, 1)

    async def test_exception_details_not_logged_or_saved(self):
        async def fetcher(**kwargs):
            raise RuntimeError('synthetic-password Cookie=synthetic-token')
        _, report = await self.run_update(fetcher)
        self.assertNotIn('synthetic', json.dumps(report) + self.path.read_text())

    async def test_manual_challenge_stops_and_is_reported(self):
        async def fetcher(**kwargs):
            raise VerificationError('authentication', 'manual_authentication_required')
        code, report = await self.run_update(fetcher)
        self.assertEqual(code, 2)
        self.assertEqual(report['stages']['authentication'], 'blocked')
        self.assertEqual(json.loads(self.path.read_text())['failure_code'], 'manual_authentication_required')

    async def test_wrong_day_or_mismatched_subjects_not_published(self):
        for record in [{**RECORD, 'date': '2026-10-09'}, {**RECORD, 'total_minutes': 8}]:
            self.setUp()
            async def fetcher(**kwargs):
                return record
            code, _ = await self.run_update(fetcher)
            self.assertEqual(code, 2)
            self.assertEqual(json.loads(self.path.read_text())['history'], [self.seed])

    async def test_corrupt_existing_data_stops_before_login(self):
        self.path.write_text('{}')
        async def fetcher(**kwargs):
            self.fail('authentication_attempted')
        with self.assertRaises(KeyError):
            await self.run_update(fetcher)


if __name__ == '__main__':
    unittest.main()
