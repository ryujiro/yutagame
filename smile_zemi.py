"""みまもるネットの技術検証。秘密や認証後のDOMをログに出力しない。"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import shutil
import unicodedata
from datetime import date, datetime
from pathlib import Path
from typing import Any, Mapping, Awaitable, Callable
from urllib.parse import parse_qs, unquote, urlsplit
from zoneinfo import ZoneInfo

from playwright.async_api import Error as PlaywrightError
from playwright.async_api import async_playwright

LOGIN_URL = "https://smile-zemi.jp/mimamoru-net/ui/login"
LOGIN_API_URL = "https://m.smile-zemi.jp/api/common/login"
SERVICE_HOSTS = frozenset(("smile-zemi.jp", "m.smile-zemi.jp"))
JST = ZoneInfo("Asia/Tokyo")
STAGES = ("connection", "login_page", "authentication", "records_page", "extraction")
REQUIRED_ENV = ("SMILE_ZEMI_LOGIN_ID", "SMILE_ZEMI_PASSWORD")
LOGIN_SELECTORS = {
    "login_id": 'input[type="email"][name="userId"]',
    "password": 'input[type="password"][name="password"]',
    "submit": 'role=button[name="ログイン"]',
}
CHU_SELECTORS = {
    "records_marker": ".dailyLogRoot__J7L4P",
    "record_scope": ".dailyRoot__a754V",
    "date": ".date__FKSSm",
    "total": ".studyDateInner__s0Jtj > div:last-child",
    "subjects": ".subject__bWHro",
    "subject_name": ".summary__raEvD .name__TRpmJ",
    "subject_minutes": ".summary__raEvD .time__Pn3gb",
}
SUBJECT_NAMES = {
    "MAT": "数学", "JPN": "国語", "SCI": "理科", "SOC": "社会", "ENG": "英語",
    "TEC": "技術", "HOM": "家庭", "HAP": "保体", "ART": "美術", "MUS": "音楽",
    "EKN": "英検", "EK2": "英語プレミアム",
}


class VerificationError(Exception):
    """メッセージには固定の診断文字列と変数名のみを含める。"""

    def __init__(self, stage: str, code: str, *, missing: list[str] | None = None, api_code: int | None = None):
        super().__init__(code)
        self.stage = stage
        self.code = code
        self.missing = missing or []
        self.api_code = api_code if api_code in (40100, 40110, 40120) else None


def timestamp() -> str:
    return datetime.now(JST).isoformat(timespec="seconds")


def parse_display_date(text: str) -> date:
    normalized = unicodedata.normalize("NFKC", text).strip()
    matches = re.findall(r"(?<!\d)(\d{4})\s*(?:年|[-/])\s*(\d{1,2})\s*(?:月|[-/])\s*(\d{1,2})(?:日)?(?!\d)", normalized)
    if len(matches) != 1:
        raise VerificationError("extraction", "full_date_missing_or_ambiguous")
    try:
        return date(*(int(x) for x in matches[0]))
    except ValueError:
        raise VerificationError("extraction", "invalid_display_date") from None


def parse_minutes(text: str) -> int:
    normalized = unicodedata.normalize("NFKC", text)
    normalized = re.sub(r"\s+", "", normalized)
    match = re.fullmatch(r"(?:(?:合計|学習時間|合計学習時間|当日の合計学習時間)[:：]?)?(?:(\d+)時間)?(\d+)分", normalized)
    if not match:
        raise VerificationError("extraction", "duration_missing_or_ambiguous")
    return int(match[1] or 0) * 60 + int(match[2])


def credentials() -> tuple[str, str]:
    missing = [name for name in REQUIRED_ENV if not os.environ.get(name)]
    if missing:
        raise VerificationError("authentication", "missing_environment_variables", missing=missing)
    return tuple(os.environ[name] for name in REQUIRED_ENV)  # type: ignore[return-value]


def validate_selectors(selectors: Mapping[str, Any]) -> None:
    required = ("login_id", "password", "submit", "authenticated_marker", "records_marker", "record_scope", "date", "total")
    if any(not isinstance(selectors.get(key), str) or not selectors[key].strip() for key in required):
        raise VerificationError("authentication", "verified_selectors_required")
    for key in ("records_link", "subjects", "subject_name", "subject_minutes", "manual_challenge"):
        if key in selectors and (not isinstance(selectors[key], str) or not selectors[key].strip()):
            raise VerificationError("authentication", "invalid_selector_configuration")
    if "subjects" in selectors and not all(key in selectors for key in ("subject_name", "subject_minutes")):
        raise VerificationError("extraction", "subject_selectors_incomplete")


def proxy_configuration() -> dict[str, str] | None:
    value = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy")
    if not value:
        return None
    parsed = urlsplit(value)
    if parsed.scheme not in ("http", "https", "socks5") or not parsed.hostname:
        raise VerificationError("connection", "unsupported_proxy_configuration")
    port = f":{parsed.port}" if parsed.port else ""
    proxy = {"server": f"{parsed.scheme}://{parsed.hostname}{port}"}
    if parsed.username:
        proxy["username"] = unquote(parsed.username)
    if parsed.password:
        proxy["password"] = unquote(parsed.password)
    return proxy


def launch_options() -> dict[str, Any]:
    options: dict[str, Any] = {"headless": True}
    executable = os.environ.get("SMILE_ZEMI_CHROMIUM_PATH") or shutil.which("chromium") or shutil.which("google-chrome")
    if executable:
        options["executable_path"] = executable
    proxy = proxy_configuration()
    if proxy:
        options["proxy"] = proxy
    return options


def browser_failure(stage: str, error: PlaywrightError) -> VerificationError:
    # Playwrightの例外はfillした値、リクエストURL、DOMを含み得るので出力しない。
    message = str(error)
    code = "browser_operation_failed"
    if "ERR_TUNNEL_CONNECTION_FAILED" in message or "statusCode=403" in message:
        code = "proxy_tunnel_failed"
    elif "ERR_CERT" in message or "certificate" in message.lower():
        code = "tls_verification_failed"
    elif "Executable doesn't exist" in message:
        code = "browser_not_installed"
    elif "Timeout" in message or "timeout" in message:
        code = "timeout_or_selector_not_found"
    return VerificationError(stage, code)


async def install_verified_transport(context: Any, auth: tuple[str, str] | None = None, *, response_observer: Callable[[Any, Any], Awaitable[None]] | None = None) -> dict[str, str]:
    """既存のNode CA設定でHTTPSを検証。OS/Chromiumの信頼ストアを変更しない。

    route.fetch は同じ BrowserContext の APIRequestContext を使用するため、
    正規レスポンスのCookieも非永続の同コンテキストで管理される。
    リダイレクトはブラウザに渡し、遷移ごとに送信先制約を評価する。
    """
    state: dict[str, str] = {}

    async def handle_route(route: Any) -> None:
        request = route.request
        destination = urlsplit(request.url)
        query_values = [value for values in parse_qs(destination.query).values() for value in values]
        if destination.scheme != "https":
            state["failure"] = "non_https_request_blocked"
            await route.abort()
            return
        if auth is not None:
            if request.url == LOGIN_API_URL and request.method == "POST":
                # Reactの入力状態が追いついていない場合、誤った認証POSTを送らない。
                try:
                    payload = json.loads(request.post_data_buffer or b"")
                    ready = isinstance(payload, dict) and payload.get("user_id") == auth[0] and payload.get("password") == auth[1]
                except (ValueError, UnicodeError):
                    ready = False
                if not ready:
                    state["failure"] = "login_form_payload_not_ready"
                    await route.abort()
                    return
            if any(value in auth for value in query_values):
                state["failure"] = "credential_in_url_blocked"
                await route.abort()
                return
            if request.method not in ("GET", "HEAD", "OPTIONS") and destination.hostname not in SERVICE_HOSTS:
                # 計測タグ等の送信を止めるが、認証情報を含まないものは認証失敗と混同しない。
                # 計測タグはgzip等のバイナリ本文も送る。post_dataのUTF-8変換を避ける。
                if any(secret.encode("utf-8") in (request.post_data_buffer or b"") for secret in auth):
                    state["failure"] = "unverified_authentication_destination"
                await route.abort()
                return
        # ignore_https_errors は指定しない。既定値Falseを維持する。
        response = await route.fetch(timeout=30_000, max_redirects=0)
        if response_observer is not None and destination.hostname in SERVICE_HOSTS:
            await response_observer(request, response)
        await route.fulfill(response=response)

    async def transport(route: Any) -> None:
        try:
            await handle_route(route)
        except Exception as error:
            # 非Playwright例外や終了時のabort例外もイベント側の生ログへ漏らさない。
            if urlsplit(route.request.url).hostname in SERVICE_HOSTS:
                state["failure"] = browser_failure("connection", error).code if isinstance(error, PlaywrightError) else "transport_operation_failed"
            try:
                await route.abort()
            except Exception:
                pass

    await context.route("**/*", transport)
    return state


async def visible_one(root: Any, selector: str, stage: str) -> Any:
    locator = root.locator(selector).filter(visible=True)
    if await locator.count() != 1:
        raise VerificationError(stage, "visible_selector_missing_or_ambiguous")
    return locator


async def manual_challenge(page: Any, selectors: Mapping[str, Any]) -> bool:
    # 完全な検出は保証しない。未検出でも認証成功マーカーが必須。
    if selectors.get("manual_challenge") and await page.locator(selectors["manual_challenge"]).filter(visible=True).count():
        return True
    for frame in page.frames:
        host = urlsplit(frame.url).hostname or ""
        if any(word in host for word in ("recaptcha", "hcaptcha", "challenges.cloudflare")):
            return True
    for selector in ('iframe[title*="reCAPTCHA"]', 'iframe[title*="CAPTCHA"]', 'input[autocomplete="one-time-code"]'):
        if await page.locator(selector).filter(visible=True).count():
            return True
    return bool(await page.get_by_text(re.compile(r"認証コードを入力|確認コードを入力|ロボットではないことを確認")).filter(visible=True).count())


async def open_login(page: Any, progress: dict[str, str]) -> None:
    try:
        response = await page.goto(LOGIN_URL, wait_until="domcontentloaded", timeout=30_000)
    except PlaywrightError as error:
        raise browser_failure("connection", error) from None
    if response is None or response.status >= 400:
        raise VerificationError("connection", "http_error")
    progress["connection"] = "passed"
    current = urlsplit(page.url)
    if current.scheme != "https" or current.hostname != "smile-zemi.jp":
        raise VerificationError("login_page", "unverified_login_destination")
    try:
        await page.locator('input[type="password"]').filter(visible=True).first.wait_for(timeout=15_000)
        await page.get_by_role("button", name="ログイン", exact=True).wait_for(timeout=15_000)
    except PlaywrightError as error:
        if await manual_challenge(page, {}):
            raise VerificationError("login_page", "manual_authentication_required") from None
        raise browser_failure("login_page", error) from None
    progress["login_page"] = "passed"


async def probe_login(progress: dict[str, str] | None = None) -> dict[str, Any]:
    """認証情報を読み込まず、公開ログイン画面だけを検査する。"""
    progress = progress if progress is not None else dict.fromkeys(STAGES, "unverified")
    try:
        async with async_playwright() as playwright:
            browser = await playwright.chromium.launch(**launch_options())
            try:
                context = await browser.new_context(locale="ja-JP", timezone_id="Asia/Tokyo", service_workers="block")
                transport = await install_verified_transport(context)
                page = await context.new_page()
                try:
                    await open_login(page, progress)
                except VerificationError:
                    if transport.get("failure"):
                        raise VerificationError("connection", transport["failure"]) from None
                    raise
                selectors = ('input[type="email"]', 'input[type="text"]', 'input[type="password"]', 'button[type="submit"]', 'input[type="submit"]')
                counts = {selector: await page.locator(selector).filter(visible=True).count() for selector in selectors}
                confirmed = {}
                for selector in LOGIN_SELECTORS.values():
                    confirmed[selector] = await page.locator(selector).filter(visible=True).count()
                return {"status": "login_page_loaded", "checked_at": timestamp(), "stages": progress, "visible_control_counts": counts, "confirmed_login_selector_counts": confirmed, "manual_challenge_detected": await manual_challenge(page, {})}
            finally:
                await browser.close()
    except PlaywrightError as error:
        raise browser_failure("connection", error) from None


async def authenticate_on_page(page: Any, context: Any, auth: tuple[str, str], progress: dict[str, str]) -> None:
    """正規画面のボタンから1回だけ認証する。セッションは同じメモリ内コンテキストで使用。"""
    preflight = await context.request.fetch(LOGIN_API_URL, method="OPTIONS", timeout=20_000)
    if preflight.status == 403:
        raise VerificationError("authentication", "authentication_host_access_denied")
    if await manual_challenge(page, {}):
        raise VerificationError("authentication", "manual_authentication_required")
    await (await visible_one(page, LOGIN_SELECTORS["login_id"], "authentication")).fill(auth[0])
    await (await visible_one(page, LOGIN_SELECTORS["password"], "authentication")).fill(auth[1])
    async with page.expect_response(lambda r: r.url == LOGIN_API_URL and r.request.method == "POST", timeout=25_000) as pending:
        await page.get_by_role("button", name="ログイン", exact=True).click()
    response = await pending.value
    if response.status == 401:
        api_code = None
        try:
            rejected = await response.json()
            api_code = rejected.get("response_status", {}).get("code")
        except Exception:
            pass
        code = {40110: "login_rejected_warning_no_automatic_retry", 40120: "login_temporarily_blocked_no_automatic_retry"}.get(api_code, "login_rejected_no_automatic_retry")
        raise VerificationError("authentication", code, api_code=api_code)
    if response.status != 200:
        raise VerificationError("authentication", "login_api_http_error")
    data = await response.json()
    if not isinstance(data, dict) or not isinstance(data.get("response_data"), dict) or not data["response_data"].get("ticket"):
        raise VerificationError("authentication", "authentication_success_not_confirmed")
    # ticketは存在確認のみ。生レスポンスを保持・出力しない。
    del data
    try:
        await page.locator('input[type="password"]').wait_for(state="hidden", timeout=15_000)
        await page.get_by_text("ログアウト", exact=True).filter(visible=True).wait_for(timeout=15_000)
    except PlaywrightError:
        if await manual_challenge(page, {}):
            raise VerificationError("authentication", "manual_authentication_required") from None
        raise VerificationError("authentication", "authenticated_page_not_loaded") from None
    if await manual_challenge(page, {}):
        raise VerificationError("authentication", "manual_authentication_required")
    progress["authentication"] = "passed"


async def probe_auth(progress: dict[str, str] | None = None) -> dict[str, Any]:
    """正規ログインを1回試し、認証情報・ticket等を含まない診断のみを返す。"""
    auth = credentials()
    progress = progress if progress is not None else dict.fromkeys(STAGES, "unverified")
    stage = "connection"
    try:
        async with async_playwright() as playwright:
            browser = await playwright.chromium.launch(**launch_options())
            try:
                context = await browser.new_context(locale="ja-JP", timezone_id="Asia/Tokyo", service_workers="block")
                transport = await install_verified_transport(context, auth)
                page = await context.new_page()
                await open_login(page, progress)
                stage = "authentication"
                await authenticate_on_page(page, context, auth, progress)
                labels = {}
                for label in ("お子さま", "日々のとりくみ", "学習のようす", "学習の状況", "学習状況", "ログアウト", "中学生コース", "小学生コース"):
                    count = await page.get_by_text(label, exact=True).filter(visible=True).count()
                    if count:
                        labels[label] = count
                return {"status": "authenticated", "checked_at": timestamp(), "stages": progress, "known_visible_labels": labels}
            finally:
                await browser.close()
    except PlaywrightError as error:
        if stage == "authentication" and transport.get("failure"):
            raise VerificationError(stage, transport["failure"]) from None
        raise browser_failure(stage, error) from None


async def extract_today(page: Any, selectors: Mapping[str, Any], today: date) -> dict[str, Any]:
    """設定済みの画面DOMから当日の一意な記録のみを取り出す。"""
    scopes = page.locator(selectors["record_scope"]).filter(visible=True)
    matching = []
    for scope in await scopes.all():
        date_element = await visible_one(scope, selectors["date"], "extraction")
        if parse_display_date(await date_element.inner_text()) == today:
            matching.append(scope)
    if len(matching) != 1:
        raise VerificationError("extraction", "today_record_missing_or_ambiguous")
    scope = matching[0]
    total_element = await visible_one(scope, selectors["total"], "extraction")
    total = parse_minutes(await total_element.inner_text())
    subjects = None
    if "subjects" in selectors:
        rows = scope.locator(selectors["subjects"]).filter(visible=True)
        if await rows.count():
            subjects = {}
            for row in await rows.all():
                name_element = await visible_one(row, selectors["subject_name"], "extraction")
                name = (await name_element.inner_text()).strip()
                if not name or name in subjects:
                    raise VerificationError("extraction", "subject_name_missing_or_ambiguous")
                duration = await visible_one(row, selectors["subject_minutes"], "extraction")
                subjects[name] = parse_minutes(await duration.inner_text())
            if sum(subjects.values()) != total:
                raise VerificationError("extraction", "subject_total_mismatch")
    # 読み取り中の画面更新やJST日付変更を成功扱いにしない。
    date_element = await visible_one(scope, selectors["date"], "extraction")
    if parse_display_date(await date_element.inner_text()) != today or parse_minutes(await total_element.inner_text()) != total:
        raise VerificationError("extraction", "display_changed_during_extraction")
    if datetime.now(JST).date() != today:
        raise VerificationError("extraction", "jst_date_changed_retry_required")
    return {"date": today.isoformat(), "total_minutes": total, "subjects": subjects, "fetched_at": timestamp()}


def parse_chu_api_records(data: Any) -> list[dict[str, Any]]:
    """正規画面が取得した応答から、日付・時間だけを残す。"""
    if not isinstance(data, dict) or not isinstance(data.get("response_data"), dict):
        raise VerificationError("extraction", "timeline_api_schema_changed")
    timelines = data["response_data"].get("timelines")
    if not isinstance(timelines, list):
        raise VerificationError("extraction", "timeline_api_schema_changed")
    records, seen = [], set()
    for item in timelines:
        if not isinstance(item, dict) or not isinstance(item.get("date"), str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", item["date"]):
            raise VerificationError("extraction", "timeline_api_date_invalid")
        day = parse_display_date(item["date"]).isoformat()
        if day in seen:
            raise VerificationError("extraction", "timeline_api_date_ambiguous")
        seen.add(day)
        total, reports = item.get("elapsed_time"), item.get("reports")
        if type(total) is not int or total < 0 or not isinstance(reports, list):
            raise VerificationError("extraction", "timeline_api_duration_invalid")
        subjects = {}
        for report in reports:
            if not isinstance(report, dict) or report.get("subject") not in SUBJECT_NAMES:
                raise VerificationError("extraction", "timeline_api_subject_unknown")
            name, minutes = SUBJECT_NAMES[report["subject"]], report.get("elapsed_time")
            if name in subjects or type(minutes) is not int or minutes < 0:
                raise VerificationError("extraction", "timeline_api_subject_invalid")
            subjects[name] = minutes
        if subjects and sum(subjects.values()) != total:
            raise VerificationError("extraction", "subject_total_mismatch")
        records.append({"date": day, "total_minutes": total, "subjects": subjects or None})
    return records


async def extract_chu_today(page: Any, records: list[dict[str, Any]], today: date) -> dict[str, Any]:
    """APIの年付き日付と実表示M/Dを照合し、合計・教科別はDOMから取得する。"""
    expected = [r for r in records if r["date"] == today.isoformat()]
    if len(expected) != 1:
        raise VerificationError("extraction", "today_record_missing_or_ambiguous")
    display_date = f"{today.month}/{today.day}({'月火水木金土日'[today.weekday()]})"
    matches = []
    for root in await page.locator(CHU_SELECTORS["record_scope"]).filter(visible=True).all():
        element = await visible_one(root, CHU_SELECTORS["date"], "extraction")
        if unicodedata.normalize("NFKC", (await element.inner_text()).strip()) == display_date:
            matches.append(root)
    if len(matches) != 1:
        raise VerificationError("extraction", "today_display_missing_or_ambiguous")
    root = matches[0]

    async def read_display() -> dict[str, Any]:
        element = await visible_one(root, CHU_SELECTORS["date"], "extraction")
        if unicodedata.normalize("NFKC", (await element.inner_text()).strip()) != display_date:
            raise VerificationError("extraction", "display_changed_during_extraction")
        total = parse_minutes(await (await visible_one(root, CHU_SELECTORS["total"], "extraction")).inner_text())
        subjects = {}
        for subject in await root.locator(CHU_SELECTORS["subjects"]).filter(visible=True).all():
            name = (await (await visible_one(subject, CHU_SELECTORS["subject_name"], "extraction")).inner_text()).strip()
            if name not in SUBJECT_NAMES.values() or name in subjects:
                raise VerificationError("extraction", "subject_name_missing_or_ambiguous")
            number = await (await visible_one(subject, CHU_SELECTORS["subject_minutes"], "extraction")).inner_text()
            subjects[name] = parse_minutes(number + "分")
        if subjects and sum(subjects.values()) != total:
            raise VerificationError("extraction", "subject_total_mismatch")
        return {"date": today.isoformat(), "total_minutes": total, "subjects": subjects or None}

    result = await read_display()
    if result != expected[0]:
        raise VerificationError("extraction", "api_display_mismatch")
    if await read_display() != result:
        raise VerificationError("extraction", "display_changed_during_extraction")
    if datetime.now(JST).date() != today:
        raise VerificationError("extraction", "jst_date_changed_retry_required")
    return {**result, "fetched_at": timestamp()}


async def fetch_verified_chu(progress: dict[str, str]) -> dict[str, Any]:
    """実検証した、子ども1人・中学生コースの日別記録を取得する。"""
    auth = credentials()
    stage, transport = "connection", {}
    observations: dict[str, Any] = {}
    records_received = asyncio.Event()

    async def observe(request: Any, response: Any) -> None:
        path = urlsplit(request.url).path
        timeline_request = bool(re.fullmatch(r"/api/chu/timeline/v2/daily-report/[^/]+", path))
        if request.method != "GET":
            return
        try:
            if response.status != 200:
                if timeline_request:
                    observations["failure"] = "timeline_api_http_error"
                return
            if path == "/api/common/children":
                children = (await response.json()).get("response_data", {}).get("child")
                if isinstance(children, list):
                    observations["child_count"] = len(children)
            elif timeline_request:
                observations["records"] = parse_chu_api_records(await response.json())
        except VerificationError as error:
            observations["failure"] = error.code
        except Exception:
            observations["failure"] = "timeline_response_unreadable"
        finally:
            if timeline_request:
                records_received.set()

    try:
        async with async_playwright() as playwright:
            browser = await playwright.chromium.launch(**launch_options())
            try:
                context = await browser.new_context(locale="ja-JP", timezone_id="Asia/Tokyo", service_workers="block")
                transport = await install_verified_transport(context, auth, response_observer=observe)
                page = await context.new_page()
                page.set_default_timeout(30_000)
                await open_login(page, progress)
                stage = "authentication"
                await authenticate_on_page(page, context, auth, progress)
                stage = "records_page"
                # 今回のアカウントでは、正規ログイン後に日別画面が自動で開く。
                await page.locator(CHU_SELECTORS["records_marker"]).filter(visible=True).wait_for()
                if observations.get("child_count") != 1:
                    raise VerificationError(stage, "single_child_required_manual_selection_needed")
                await visible_one(page, CHU_SELECTORS["records_marker"], stage)
                progress[stage] = "passed"
                stage = "extraction"
                # 画面の枠はAPI応答より先に描画される。記録応答の完了を待つ。
                try:
                    await asyncio.wait_for(records_received.wait(), timeout=30)
                except TimeoutError:
                    raise VerificationError(stage, transport.get("failure", "verified_timeline_response_missing")) from None
                if observations.get("failure"):
                    raise VerificationError(stage, observations["failure"])
                if "records" not in observations:
                    raise VerificationError(stage, "verified_timeline_response_missing")
                await page.locator(CHU_SELECTORS["record_scope"]).filter(visible=True).first.wait_for()
                result = await extract_chu_today(page, observations["records"], datetime.now(JST).date())
                progress[stage] = "passed"
                return result
            finally:
                await browser.close()
    except PlaywrightError as error:
        if transport.get("failure"):
            raise VerificationError(stage, transport["failure"]) from None
        raise browser_failure(stage, error) from None


async def fetch_today_learning_time(selectors: Mapping[str, Any] | None = None, *, progress: dict[str, str] | None = None) -> dict[str, Any]:
    """環境変数で認証し、JSTの当日の記録をJSON互換dictで返す独立関数。"""
    login_id, password = credentials()  # 未設定ならブラウザも起動しない。
    progress = progress if progress is not None else dict.fromkeys(STAGES, "unverified")
    if selectors is None:
        return await fetch_verified_chu(progress)
    selectors = {**LOGIN_SELECTORS, **selectors}
    validate_selectors(selectors)
    stage = "connection"
    try:
        async with async_playwright() as playwright:
            browser = await playwright.chromium.launch(**launch_options())
            try:
                context = await browser.new_context(locale="ja-JP", timezone_id="Asia/Tokyo", service_workers="block")
                transport = await install_verified_transport(context, (login_id, password))
                page = await context.new_page()
                page.set_default_timeout(15_000)
                try:
                    await open_login(page, progress)
                except VerificationError:
                    if transport.get("failure"):
                        raise VerificationError("connection", transport["failure"]) from None
                    raise
                stage = "authentication"
                if await manual_challenge(page, selectors):
                    raise VerificationError(stage, "manual_authentication_required")
                await (await visible_one(page, selectors["login_id"], stage)).fill(login_id)
                await (await visible_one(page, selectors["password"], stage)).fill(password)
                await (await visible_one(page, selectors["submit"], stage)).click()
                try:
                    await page.locator(selectors["authenticated_marker"]).filter(visible=True).first.wait_for()
                except PlaywrightError as error:
                    if transport.get("failure"):
                        raise VerificationError(stage, transport["failure"]) from None
                    if await manual_challenge(page, selectors):
                        raise VerificationError(stage, "manual_authentication_required") from None
                    raise browser_failure(stage, error) from None
                await visible_one(page, selectors["authenticated_marker"], stage)
                if await manual_challenge(page, selectors):
                    raise VerificationError(stage, "manual_authentication_required")
                progress[stage] = "passed"
                stage = "records_page"
                if selectors.get("records_link"):
                    await (await visible_one(page, selectors["records_link"], stage)).click()
                await page.locator(selectors["records_marker"]).filter(visible=True).first.wait_for()
                await visible_one(page, selectors["records_marker"], stage)
                progress[stage] = "passed"
                stage = "extraction"
                await page.locator(selectors["record_scope"]).filter(visible=True).first.wait_for()
                result = await extract_today(page, selectors, datetime.now(JST).date())
                progress[stage] = "passed"
                return result
            finally:
                await browser.close()
    except PlaywrightError as error:
        raise browser_failure(stage, error) from None


async def main() -> int:
    parser = argparse.ArgumentParser(description="みまもるネット技術検証（認証情報は環境変数のみ）")
    parser.add_argument("--probe-login", action="store_true", help="公開ログイン画面を確認。認証は試行しない")
    parser.add_argument("--probe-auth", action="store_true", help="正規ログインを1回試行し、安全な診断だけを出力")
    parser.add_argument("--selectors", type=Path, help="実画面で確認済みのセレクタJSON")
    args = parser.parse_args()
    progress = dict.fromkeys(STAGES, "unverified")
    try:
        if args.probe_login and args.probe_auth:
            raise VerificationError("authentication", "choose_one_probe_mode")
        if args.probe_login:
            result = await probe_login(progress)
        elif args.probe_auth:
            result = await probe_auth(progress)
        else:
            credentials()
            if not args.selectors:
                result = await fetch_today_learning_time(progress=progress)
            else:
                try:
                    selectors = json.loads(args.selectors.read_text(encoding="utf-8"))
                    if not isinstance(selectors, dict):
                        raise ValueError
                except (OSError, ValueError):
                    raise VerificationError("authentication", "selector_file_unreadable_or_invalid") from None
                result = await fetch_today_learning_time(selectors, progress=progress)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except VerificationError as error:
        progress[error.stage] = "blocked" if error.code in ("missing_environment_variables", "verified_selectors_required", "manual_authentication_required") else "failed"
        result = {"status": "not_acquired", "checked_at": timestamp(), "stages": progress, "error": {"stage": error.stage, "code": error.code}}
        if error.missing:
            result["error"]["missing_environment_variables"] = error.missing
        if error.api_code is not None:
            result["error"]["api_code"] = error.api_code
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 2
    except Exception:
        # traceback/例外値には秘密が含まれ得るため、常に固定文字列のみ。
        print(json.dumps({"status": "not_acquired", "checked_at": timestamp(), "stages": progress, "error": {"code": "unexpected_error_details_suppressed"}}, ensure_ascii=False, indent=2))
        return 3


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
