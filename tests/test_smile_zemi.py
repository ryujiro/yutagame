"""合成DOMのテスト。実サイトの認証・取得を検証したことにはならない。"""

import os
import json
import asyncio
import unittest
from datetime import datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from playwright.async_api import async_playwright

from smile_zemi import (
    JST, VerificationError, credentials, extract_today, fetch_today_learning_time,
    launch_options, parse_display_date, parse_minutes, validate_selectors,
    install_verified_transport, LOGIN_SELECTORS, CHU_SELECTORS, parse_chu_api_records, extract_chu_today, fetch_verified_chu, STAGES,
)


class ParsingTests(unittest.TestCase):
    def test_japanese_iso_and_full_width_dates(self):
        for text in ("2025年12月3日(水)", "2025-12-03", "２０２５／１２／３"):
            self.assertEqual(parse_display_date(text).isoformat(), "2025-12-03")

    def test_invalid_and_ambiguous_dates_fail(self):
        for text in ("今日", "10月10日", "2025-02-30", "2025-12-01 2025-12-02"):
            with self.subTest(text=text), self.assertRaises(VerificationError):
                parse_display_date(text)

    def test_minutes(self):
        for text, expected in (("0分", 0), ("合計：7分", 7), ("１時間 ２分", 62), ("学習時間\n12分", 12)):
            self.assertEqual(parse_minutes(text), expected)

    def test_ambiguous_or_negative_minutes_fail(self):
        for text in ("7分 9分", "-1分", "7", "未取得", "7.5分", "7分間"):
            with self.subTest(text=text), self.assertRaises(VerificationError):
                parse_minutes(text)

    def test_missing_credential_names_only(self):
        with patch.dict(os.environ, {"SMILE_ZEMI_LOGIN_ID": "", "SMILE_ZEMI_PASSWORD": ""}):
            with self.assertRaises(VerificationError) as result:
                credentials()
            self.assertEqual(result.exception.missing, ["SMILE_ZEMI_LOGIN_ID", "SMILE_ZEMI_PASSWORD"])

    def test_unverified_selectors_fail(self):
        with self.assertRaises(VerificationError):
            validate_selectors({})

    def api_data(self, total=7, reports=None, day="2025-12-03"):
        return {"response_data": {"timelines": [{"date": day, "elapsed_time": total, "reports": reports if reports is not None else [{"subject": "MAT", "elapsed_time": 7}]}]}}

    def test_api_keeps_only_dates_minutes_and_known_subjects(self):
        data = self.api_data()
        data["response_data"]["timelines"][0]["private_metadata"] = "synthetic-private-value"
        self.assertEqual(parse_chu_api_records(data), [{"date": "2025-12-03", "total_minutes": 7, "subjects": {"数学": 7}}])

    def test_api_rejects_partial_date_duplicate_date_and_invalid_minutes(self):
        inputs = [self.api_data(day="12/3"), self.api_data(total=True), self.api_data(total=-1), self.api_data(total=7.5)]
        duplicate = self.api_data()
        duplicate["response_data"]["timelines"] *= 2
        inputs.append(duplicate)
        for data in inputs:
            with self.subTest(data=data), self.assertRaises(VerificationError):
                parse_chu_api_records(data)

    def test_api_rejects_subject_sum_and_unknown_subject(self):
        for data in (self.api_data(total=8), self.api_data(reports=[{"subject": "UNKNOWN", "elapsed_time": 7}])):
            with self.subTest(data=data), self.assertRaises(VerificationError):
                parse_chu_api_records(data)


class DOMTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.playwright = await async_playwright().start()
        self.browser = await self.playwright.chromium.launch(**launch_options())
        self.context = await self.browser.new_context(timezone_id="Asia/Tokyo", locale="ja-JP")
        self.page = await self.context.new_page()
        self.today = datetime.now(JST).date()
        self.selectors = {"record_scope": ".record", "date": ".date", "total": ".total"}

    async def asyncTearDown(self):
        await self.browser.close()
        await self.playwright.stop()

    def record(self, content="", total="7分"):
        return f'<section class="record"><p class="date">{self.today.isoformat()}</p><p class="total">{total}</p>{content}</section>'

    async def test_rendered_record_and_jst(self):
        await self.page.set_content(self.record())
        result = await extract_today(self.page, self.selectors, self.today)
        self.assertEqual(result["date"], self.today.isoformat())
        self.assertEqual(result["total_minutes"], 7)
        self.assertIsNone(result["subjects"])
        self.assertTrue(result["fetched_at"].endswith("+09:00"))
        self.assertEqual(await self.page.evaluate("Intl.DateTimeFormat().resolvedOptions().timeZone"), "Asia/Tokyo")

    async def test_subjects_match_total(self):
        rows = '<div class="subject"><span class="name">算数</span><span class="minutes">3分</span></div><div class="subject"><span class="name">国語</span><span class="minutes">4分</span></div>'
        await self.page.set_content(self.record(rows))
        selectors = dict(self.selectors, subjects=".subject", subject_name=".name", subject_minutes=".minutes")
        result = await extract_today(self.page, selectors, self.today)
        self.assertEqual(result["subjects"], {"算数": 3, "国語": 4})

    async def test_subject_total_mismatch_fails(self):
        await self.page.set_content(self.record('<div class="subject"><span class="name">算数</span><span class="minutes">3分</span></div>'))
        selectors = dict(self.selectors, subjects=".subject", subject_name=".name", subject_minutes=".minutes")
        with self.assertRaises(VerificationError) as result:
            await extract_today(self.page, selectors, self.today)
        self.assertEqual(result.exception.code, "subject_total_mismatch")

    async def test_two_students_or_duplicate_cards_fail(self):
        await self.page.set_content(self.record() + self.record())
        with self.assertRaises(VerificationError) as result:
            await extract_today(self.page, self.selectors, self.today)
        self.assertEqual(result.exception.code, "today_record_missing_or_ambiguous")

    async def test_missing_day_is_not_zero_minutes(self):
        await self.page.set_content('<section class="record"><p class="date">2000-01-01</p><p class="total">0分</p></section>')
        with self.assertRaises(VerificationError) as result:
            await extract_today(self.page, self.selectors, self.today)
        self.assertEqual(result.exception.code, "today_record_missing_or_ambiguous")

    async def test_hidden_record_is_ignored(self):
        await self.page.set_content(self.record() + '<div hidden>' + self.record(total="99分") + '</div>')
        result = await extract_today(self.page, self.selectors, self.today)
        self.assertEqual(result["total_minutes"], 7)

    async def test_duplicate_total_is_rejected(self):
        await self.page.set_content(self.record('<p class="total">9分</p>'))
        with self.assertRaises(VerificationError):
            await extract_today(self.page, self.selectors, self.today)

    async def test_missing_credentials_never_launch_browser(self):
        with patch.dict(os.environ, {"SMILE_ZEMI_LOGIN_ID": "", "SMILE_ZEMI_PASSWORD": ""}), patch("smile_zemi.async_playwright", side_effect=AssertionError("browser must not launch")):
            with self.assertRaises(VerificationError) as result:
                await fetch_today_learning_time({})
            self.assertEqual(result.exception.code, "missing_environment_variables")

    async def test_login_button_role_selector(self):
        await self.page.set_content('<button><span>ログイン</span></button>')
        self.assertEqual(await self.page.locator(LOGIN_SELECTORS["submit"]).count(), 1)

    def chu_record(self, total="7分"):
        display_date = f"{self.today.month}/{self.today.day}({'月火水木金土日'[self.today.weekday()]})"
        return f'<div class="dailyRoot__a754V"><div class="studyDateInner__s0Jtj"><div class="date__FKSSm">{display_date}</div><div class="timeIcon__DA1S6"></div><div><span>{total}</span></div></div><div class="subject__bWHro"><div class="summary__raEvD"><div class="name__TRpmJ"><span>数学</span></div><div><span class="time__Pn3gb">7</span><span>分</span></div></div></div></div>'

    def chu_api_record(self, total=7):
        return [{"date": self.today.isoformat(), "total_minutes": total, "subjects": {"数学": total}}]

    async def test_chu_matches_api_year_with_rendered_month_day_and_minutes(self):
        await self.page.set_content(self.chu_record())
        result = await extract_chu_today(self.page, self.chu_api_record(), self.today)
        self.assertEqual(result["date"], self.today.isoformat())
        self.assertEqual(result["total_minutes"], 7)
        self.assertEqual(result["subjects"], {"数学": 7})

    async def test_chu_api_dom_mismatch_fails(self):
        await self.page.set_content(self.chu_record())
        with self.assertRaises(VerificationError) as error:
            await extract_chu_today(self.page, self.chu_api_record(total=9), self.today)
        self.assertEqual(error.exception.code, "api_display_mismatch")

    async def test_chu_year_is_not_inferred_from_system_clock(self):
        await self.page.set_content(self.chu_record())
        records = [{**self.chu_api_record()[0], "date": "2000-01-01"}]
        with self.assertRaises(VerificationError) as error:
            await extract_chu_today(self.page, records, self.today)
        self.assertEqual(error.exception.code, "today_record_missing_or_ambiguous")

    async def test_chu_duplicate_rendered_day_fails(self):
        await self.page.set_content(self.chu_record() + self.chu_record())
        with self.assertRaises(VerificationError) as error:
            await extract_chu_today(self.page, self.chu_api_record(), self.today)
        self.assertEqual(error.exception.code, "today_display_missing_or_ambiguous")


class FetchTimingTests(unittest.IsolatedAsyncioTestCase):
    async def test_rendered_page_shell_waits_for_delayed_record_response(self):
        # 画面の枠が先に描画され、記録APIだけが遅れて応答する状況を再現。
        observer_ready = asyncio.Event()
        marker_reached = asyncio.Event()
        callbacks = {}
        page, locator = MagicMock(), MagicMock()
        locator.filter.return_value = locator
        locator.first = locator
        async def marker_wait():
            marker_reached.set()
        locator.wait_for = AsyncMock(side_effect=marker_wait)
        page.locator.return_value = locator
        context = SimpleNamespace(new_page=AsyncMock(return_value=page))
        browser = SimpleNamespace(new_context=AsyncMock(return_value=context), close=AsyncMock())
        playwright = SimpleNamespace(chromium=SimpleNamespace(launch=AsyncMock(return_value=browser)))
        manager = AsyncMock()
        manager.__aenter__.return_value = playwright
        async def transport(_ctx, _auth, *, response_observer):
            callbacks['observe'] = response_observer
            await response_observer(SimpleNamespace(url='https://m.smile-zemi.jp/api/common/children', method='GET'), SimpleNamespace(status=200, json=AsyncMock(return_value={'response_data':{'child':[{}]}})))
            observer_ready.set()
            return {}
        async def login(_page, progress):
            progress['connection'] = progress['login_page'] = 'passed'
        async def authenticate(_page, _ctx, _auth, progress):
            progress['authentication'] = 'passed'
        today = datetime.now(JST).date().isoformat()
        result = {'date':today,'total_minutes':7,'subjects':{'数学':7},'fetched_at':datetime.now(JST).isoformat()}
        progress = dict.fromkeys(STAGES, 'unverified')
        with patch('smile_zemi.credentials',return_value=('synthetic-id','synthetic-password')), patch('smile_zemi.async_playwright',return_value=manager), patch('smile_zemi.install_verified_transport',side_effect=transport), patch('smile_zemi.open_login',side_effect=login), patch('smile_zemi.authenticate_on_page',side_effect=authenticate), patch('smile_zemi.visible_one',new_callable=AsyncMock), patch('smile_zemi.extract_chu_today',new_callable=AsyncMock,return_value=result) as extract:
            task = asyncio.create_task(fetch_verified_chu(progress))
            try:
                await asyncio.wait_for(observer_ready.wait(),timeout=2)
                await asyncio.wait_for(marker_reached.wait(),timeout=2)
                self.assertFalse(task.done())
                extract.assert_not_awaited()
                data = {'response_data':{'timelines':[{'date':today,'elapsed_time':7,'reports':[{'subject':'MAT','elapsed_time':7}]}]}}
                await callbacks['observe'](SimpleNamespace(url='https://m.smile-zemi.jp/api/chu/timeline/v2/daily-report/synthetic-child',method='GET'),SimpleNamespace(status=200,json=AsyncMock(return_value=data)))
                self.assertEqual(await asyncio.wait_for(task,timeout=2), result)
                self.assertTrue(all(status=='passed' for status in progress.values()))
                browser.close.assert_awaited_once()
            finally:
                if not task.done():
                    task.cancel()
                    await asyncio.gather(task,return_exceptions=True)


class TransportTests(unittest.IsolatedAsyncioTestCase):
    async def setup_route(self, url, method="GET", auth=None, post_data=None):
        context = AsyncMock()
        state = await install_verified_transport(context, auth)
        handler = context.route.call_args.args[1]
        route = AsyncMock()
        body = post_data.encode() if isinstance(post_data, str) else post_data
        route.request = SimpleNamespace(url=url, method=method, post_data_buffer=body)
        await handler(route)
        return route, state

    async def test_https_is_fetched_with_verification_defaults(self):
        route, state = await self.setup_route("https://smile-zemi.jp/mimamoru-net/ui/login")
        route.fetch.assert_awaited_once_with(timeout=30_000, max_redirects=0)
        route.fulfill.assert_awaited_once()
        route.abort.assert_not_awaited()
        self.assertEqual(state, {})

    async def test_non_https_is_blocked(self):
        route, state = await self.setup_route("http://smile-zemi.jp/")
        route.fetch.assert_not_awaited()
        route.abort.assert_awaited_once()
        self.assertEqual(state["failure"], "non_https_request_blocked")

    async def test_post_to_unverified_host_is_blocked(self):
        route, state = await self.setup_route("https://example.invalid/login", "POST", ("synthetic-id", "synthetic-password"), post_data="synthetic-password")
        route.fetch.assert_not_awaited()
        self.assertEqual(state["failure"], "unverified_authentication_destination")

    async def test_credential_in_query_is_blocked(self):
        route, state = await self.setup_route("https://smile-zemi.jp/?password=synthetic-password", auth=("synthetic-id", "synthetic-password"))
        route.fetch.assert_not_awaited()
        self.assertEqual(state["failure"], "credential_in_url_blocked")

    async def test_post_to_verified_host_is_allowed(self):
        route, state = await self.setup_route("https://smile-zemi.jp/", "POST", ("synthetic-id", "synthetic-password"))
        route.fetch.assert_awaited_once()
        self.assertEqual(state, {})

    async def test_post_to_official_api_host_is_allowed(self):
        route, state = await self.setup_route("https://m.smile-zemi.jp/api/common/login", "POST", ("synthetic-id", "synthetic-password"), post_data=json.dumps({"user_id":"synthetic-id", "password":"synthetic-password"}))
        route.fetch.assert_awaited_once()
        self.assertEqual(state, {})

    async def test_stale_login_form_does_not_send_incorrect_credentials(self):
        route, state = await self.setup_route("https://m.smile-zemi.jp/api/common/login", "POST", ("synthetic-id", "synthetic-password"), post_data=json.dumps({"user_id":"synthetic-id", "password":""}))
        route.fetch.assert_not_awaited()
        route.abort.assert_awaited_once()
        self.assertEqual(state["failure"], "login_form_payload_not_ready")

    async def test_optional_analytics_is_blocked_without_auth_failure(self):
        route, state = await self.setup_route("https://example.invalid/analytics", "POST", ("synthetic-id", "synthetic-password"), post_data="anonymous-metrics")
        route.fetch.assert_not_awaited()
        route.abort.assert_awaited_once()
        self.assertEqual(state, {})

    async def test_binary_analytics_is_blocked_without_decode_error(self):
        route, state = await self.setup_route("https://example.invalid/analytics", "POST", ("synthetic-id", "synthetic-password"), post_data=b"\x1f\x8b\x08\xff")
        route.fetch.assert_not_awaited()
        route.abort.assert_awaited_once()
        self.assertEqual(state, {})

    async def test_route_exceptions_are_suppressed_even_when_abort_fails(self):
        context = AsyncMock()
        state = await install_verified_transport(context)
        route = AsyncMock()
        route.request = SimpleNamespace(url="https://smile-zemi.jp/", method="GET")
        route.fetch.side_effect = ValueError("synthetic-sensitive-error")
        route.abort.side_effect = ValueError("synthetic-sensitive-error")
        await context.route.call_args.args[1](route)
        self.assertEqual(state["failure"], "transport_operation_failed")


if __name__ == "__main__":
    unittest.main()
