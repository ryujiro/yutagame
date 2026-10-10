import asyncio
import json
import os
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient
from smile_zemi import JST, STAGES, VerificationError
from web_app import DashboardService, clean_record, create_app

# 合成データはこのテスト内だけ。本番の初期表示には使わない。
NOW = datetime(2026, 10, 10, 18, 0, tzinfo=JST)
RECORD = {"date": "2026-10-10", "total_minutes": 7, "subjects": {"数学": 7}, "fetched_at": NOW.isoformat()}


class WebServiceTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.env = patch.dict(os.environ, {"SMILE_ZEMI_LOGIN_ID": "unit-test-id", "SMILE_ZEMI_PASSWORD": "unit-test-password"})
        self.env.start()
        self.calls = 0

    def tearDown(self):
        self.env.stop()
        self.directory.cleanup()

    async def fetch(self, *, progress):
        self.calls += 1
        progress.update({stage: "passed" for stage in STAGES})
        return dict(RECORD)

    def service(self, **kwargs):
        return DashboardService(state_path=self.root / "state.json", seed_path=self.root / "no-seed.json",
                                fetcher=kwargs.pop("fetcher", self.fetch), clock=lambda: NOW, **kwargs)

    async def test_success_is_persisted_and_survives_restart(self):
        service = self.service()
        status, response = await service.refresh()
        self.assertEqual(status, 200)
        self.assertEqual(response["record"], RECORD)
        self.assertFalse(response["refreshing"])
        restored = self.service()
        self.assertEqual(restored.snapshot()["record"], RECORD)
        status, _ = await restored.refresh()
        self.assertEqual(status, 429)
        self.assertEqual(self.calls, 1)

    async def test_failure_notice_survives_restart(self):
        async def failed(*, progress):
            raise VerificationError("authentication", "login_rejected_no_automatic_retry")
        service = self.service(fetcher=failed)
        await service.refresh()
        restored = self.service()
        self.assertEqual(restored.snapshot()["error"]["stage"], "authentication")
        self.assertGreater(restored.snapshot()["retry_after_seconds"], 0)
        self.assertEqual((self.root / "state.json").stat().st_mode & 0o777, 0o600)
        content = (self.root / "state.json").read_text()
        self.assertNotIn("unit-test-id", content)
        self.assertNotIn("unit-test-password", content)

    async def test_failure_keeps_previous_record_and_cooldown(self):
        async def failed(*, progress):
            self.calls += 1
            raise VerificationError("authentication", "login_rejected_no_automatic_retry")
        service = self.service(fetcher=failed)
        service.history = [dict(RECORD)]
        status, response = await service.refresh()
        self.assertEqual(status, 502)
        self.assertEqual(response["record"], RECORD)
        self.assertEqual(response["error"]["stage"], "authentication")
        self.assertEqual(response["verification_stages"]["authentication"], "failed")
        status, response = await service.refresh()
        self.assertEqual(status, 429)
        self.assertGreater(response["retry_after_seconds"], 0)
        self.assertEqual(self.calls, 1)

    async def test_concurrent_requests_make_only_one_login(self):
        entered, finish = asyncio.Event(), asyncio.Event()
        async def blocked(*, progress):
            entered.set()
            await finish.wait()
            return await self.fetch(progress=progress)
        service = self.service(fetcher=blocked)
        first = asyncio.create_task(service.refresh())
        await entered.wait()
        status, response = await service.refresh()
        self.assertEqual(status, 409)
        self.assertTrue(response["refreshing"])
        finish.set()
        self.assertEqual((await first)[0], 200)
        self.assertEqual(self.calls, 1)

    async def test_missing_credentials_does_not_call_fetcher(self):
        with patch.dict(os.environ, {}, clear=True):
            status, response = await self.service().refresh()
        self.assertEqual(status, 503)
        self.assertEqual(set(response["missing_environment_variables"]), {"SMILE_ZEMI_LOGIN_ID", "SMILE_ZEMI_PASSWORD"})
        self.assertEqual(self.calls, 0)

    async def test_exception_details_are_not_exposed(self):
        async def failed(*, progress):
            raise RuntimeError("unit-test-password Cookie=unit-test-token")
        status, response = await self.service(fetcher=failed).refresh()
        self.assertEqual(status, 502)
        self.assertNotIn("unit-test-password", json.dumps(response))
        self.assertNotIn("unit-test-token", json.dumps(response))

    async def test_old_day_cannot_be_accepted_as_today(self):
        async def old(*, progress):
            return {**RECORD, "date": "2026-10-09"}
        status, response = await self.service(fetcher=old).refresh()
        self.assertEqual(status, 502)
        self.assertIsNone(response["record"])

    async def test_bad_subject_sum_is_rejected(self):
        async def wrong(*, progress):
            return {**RECORD, "subjects": {"数学": 1}}
        status, response = await self.service(fetcher=wrong).refresh()
        self.assertEqual(status, 502)
        self.assertIsNone(response["record"])

    async def test_null_subjects_are_not_converted_to_zero(self):
        self.assertIsNone(clean_record({**RECORD, "subjects": None})["subjects"])

    async def test_bootstrap_retains_actual_seed_timestamp(self):
        seed = self.root / "seed.json"
        seed.write_text(json.dumps(RECORD))
        service = DashboardService(state_path=self.root / "state.json", seed_path=seed, clock=lambda: NOW)
        self.assertEqual(service.snapshot()["record"]["fetched_at"], RECORD["fetched_at"])
        self.assertEqual(len(service.history), 1)

    async def test_storage_failure_stops_before_login(self):
        service = self.service()
        with patch.object(service, "persist", side_effect=OSError("unit-test-password")):
            status, response = await service.refresh()
        self.assertEqual(status, 503)
        self.assertEqual(self.calls, 0)
        self.assertNotIn("unit-test-password", json.dumps(response))


class WebHttpTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        root = Path(self.directory.name)
        self.service = DashboardService(state_path=root / "state.json", seed_path=root / "none.json", clock=lambda: NOW)
        self.client = TestClient(create_app(self.service))

    def tearDown(self):
        self.client.close()
        self.directory.cleanup()

    def test_dashboard_get_never_attempts_authentication(self):
        with patch.object(self.service, "fetcher", side_effect=AssertionError("unexpected_authentication")):
            response = self.client.get("/api/dashboard")
        self.assertEqual(response.status_code, 200)
        self.assertIsNone(response.json()["record"])
        self.assertEqual(response.headers["cache-control"], "no-store")

    def test_cross_origin_refresh_is_rejected(self):
        response = self.client.post("/api/refresh", headers={"X-Learning-Request": "1", "Origin": "https://unrelated.example"})
        self.assertEqual(response.status_code, 403)
        self.assertIsNone(self.service.last_attempt)

    def test_simple_form_cannot_trigger_login(self):
        response = self.client.post("/api/refresh", data={"unused": "value"})
        self.assertEqual(response.status_code, 403)
        self.assertIsNone(self.service.last_attempt)

    def test_refresh_retry_after_is_server_enforced(self):
        self.service.last_attempt = NOW - timedelta(seconds=30)
        with patch.dict(os.environ, {"SMILE_ZEMI_LOGIN_ID": "unit-test-id", "SMILE_ZEMI_PASSWORD": "unit-test-password"}):
            response = self.client.post("/api/refresh", headers={"X-Learning-Request": "1"})
        self.assertEqual(response.status_code, 429)
        self.assertGreater(int(response.headers["retry-after"]), 0)


if __name__ == "__main__":
    unittest.main()
