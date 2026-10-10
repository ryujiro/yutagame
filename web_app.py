"""個人用の学習ダッシュボード。ブラウザへ認証情報を渡さない。"""
from __future__ import annotations

import asyncio
import json
import os
from datetime import datetime, timedelta
from pathlib import Path
from typing import Callable

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from smile_zemi import JST, REQUIRED_ENV, STAGES, VerificationError, fetch_today_learning_time
from learning_records import clean_record

ROOT = Path(__file__).resolve().parent
COOLDOWN_SECONDS = 600



def read_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def error_message(code: str, stage: str) -> dict:
    if code == "missing_environment_variables":
        title, message = "更新の準備ができていません", "環境設定にログインIDとパスワードを登録してください。"
    elif code == "manual_authentication_required":
        title, message = "手動での確認が必要です", "みまもるネットを開き、認証コードなどの確認を済ませてください。"
    elif code == "single_child_required_manual_selection_needed":
        title, message = "お子さまの選択が必要です", "現在は、お子さまが1人の中学生コースに対応しています。"
    elif stage == "authentication":
        title, message = "ログインを確認できませんでした", "時間をおいて更新してください。続く場合は、みまもるネットのログイン状態を確認してください。"
    elif stage in ("connection", "login_page"):
        title, message = "みまもるネットに接続できませんでした", "接続状況を確認し、時間をおいて更新してください。"
    else:
        title, message = "学習記録を取得できませんでした", "みまもるネットで今日の記録を確認し、時間をおいて更新してください。"
    return {"title": title, "message": message, "stage": stage}


class DashboardService:
    def __init__(self, *, state_path: Path | None = None, seed_path: Path | None = None,
                 fetcher: Callable = fetch_today_learning_time,
                 clock: Callable = lambda: datetime.now(JST), last_attempt: datetime | None = None):
        self.state_path = state_path or ROOT / ".local/web-state.json"
        self.fetcher, self.clock = fetcher, clock
        self.lock = asyncio.Lock()
        self.error: dict | None = None
        self.last_attempt = last_attempt
        self.history: list[dict] = []
        saved = read_json(self.state_path)
        if isinstance(saved, dict):
            try:
                self.history = sorted([clean_record(r) for r in saved.get("history", [])],
                                      key=lambda r: r["fetched_at"], reverse=True)[:100]
                if saved.get("last_attempt"):
                    attempt = datetime.fromisoformat(saved["last_attempt"])
                    if attempt.tzinfo is not None:
                        self.last_attempt = attempt.astimezone(JST)
                allowed_errors = [error_message(code, stage) for code in (
                    "missing_environment_variables", "manual_authentication_required",
                    "single_child_required_manual_selection_needed", "fetch_failed") for stage in STAGES]
                if saved.get("error") in allowed_errors:
                    self.error = saved["error"]
            except (ValueError, KeyError, TypeError):
                self.history = []
        if not self.history:
            seed = read_json(seed_path or ROOT / "verification-results/today.json")
            try:
                self.history = [clean_record(seed)]
            except (ValueError, KeyError, TypeError):
                pass
        if self.last_attempt is None and self.history:
            self.last_attempt = datetime.fromisoformat(self.history[0]["fetched_at"])

    def persist(self) -> None:
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.state_path.with_suffix(".tmp")
        with os.fdopen(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w", encoding="utf-8") as out:
            json.dump({"history": self.history, "last_attempt": self.last_attempt.isoformat() if self.last_attempt else None,
                       "error": self.error},
                      out, ensure_ascii=False)
        os.replace(temporary, self.state_path)

    def snapshot(self) -> dict:
        now = self.clock()
        next_at = self.last_attempt + timedelta(seconds=COOLDOWN_SECONDS) if self.last_attempt else None
        remaining = max(0, int((next_at - now).total_seconds()) + 1) if next_at and next_at > now else 0
        missing = [name for name in REQUIRED_ENV if not os.environ.get(name)]
        return {"record": self.history[0] if self.history else None, "history": self.history,
                "today": now.astimezone(JST).date().isoformat(), "server_time": now.isoformat(timespec="seconds"),
                "refreshing": self.lock.locked(), "retry_after_seconds": remaining,
                "next_refresh_at": next_at.isoformat(timespec="seconds") if remaining else None,
                "credentials_ready": not missing, "missing_environment_variables": missing,
                "error": self.error}

    async def refresh(self) -> tuple[int, dict]:
        if self.lock.locked():
            return 409, {**self.snapshot(), "request_message": "学習記録を取得しています。少しお待ちください。"}
        async with self.lock:
            if self.snapshot()["missing_environment_variables"]:
                self.error = error_message("missing_environment_variables", "authentication")
                return 503, {**self.snapshot(), "refreshing": False}
            if self.snapshot()["retry_after_seconds"]:
                return 429, {**self.snapshot(), "refreshing": False,
                             "request_message": "続けて更新するには、少し時間をおいてください。"}
            self.last_attempt = self.clock()
            try:
                # 失敗・プロセス再起動時も短時間の連続認証を防ぐ。
                self.persist()
            except OSError:
                self.error = {"title": "記録を保存できませんでした", "message": "保存先の空き容量と書き込み設定を確認してください。", "stage": "storage"}
                return 503, {**self.snapshot(), "refreshing": False}
            progress = {stage: "unverified" for stage in STAGES}
            try:
                record = clean_record(await asyncio.wait_for(self.fetcher(progress=progress), timeout=120))
                if record["date"] != self.clock().astimezone(JST).date().isoformat():
                    raise VerificationError("extraction", "jst_date_changed_retry_required")
            except VerificationError as exc:
                stage = exc.stage if exc.stage in STAGES else "extraction"
                progress[stage] = "blocked" if exc.code == "manual_authentication_required" else "failed"
                self.error = error_message(exc.code, stage)
                try:
                    self.persist()
                except OSError:
                    pass
                return 502, {**self.snapshot(), "refreshing": False, "verification_stages": progress}
            except Exception:
                # 例外文字列・レスポンス・DOM・秘密を返したりログに書いたりしない。
                stage = next((s for s in STAGES if progress[s] != "passed"), "extraction")
                progress[stage] = "failed"
                self.error = error_message("fetch_failed", stage)
                try:
                    self.persist()
                except OSError:
                    pass
                return 502, {**self.snapshot(), "refreshing": False, "verification_stages": progress}
            self.history = [record] + [r for r in self.history if r["fetched_at"] != record["fetched_at"]]
            self.history = self.history[:100]
            self.error = None
            try:
                self.persist()
            except OSError:
                self.error = {"title": "取得できましたが、保存できませんでした", "message": "この画面には取得した記録を表示しています。保存先の設定を確認してください。", "stage": "storage"}
            return 200, {**self.snapshot(), "refreshing": False, "verification_stages": progress}


def create_app(service: DashboardService | None = None) -> FastAPI:
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    dashboard = service or DashboardService()
    app.state.dashboard = dashboard

    @app.middleware("http")
    async def privacy_headers(request: Request, call_next):
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Content-Security-Policy"] = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
        return response

    @app.get("/api/health")
    async def health():
        return {"status": "ok"}

    @app.get("/api/dashboard")
    async def dashboard_state():
        return dashboard.snapshot()

    @app.post("/api/refresh")
    async def refresh(request: Request):
        # 通常の別サイトからのフォーム送信では認証試行を実行させない。
        if request.headers.get("X-Learning-Request") != "1":
            return JSONResponse({"message": "request_not_allowed"}, status_code=403)
        origin = request.headers.get("origin")
        if origin:
            from urllib.parse import urlsplit
            parsed = urlsplit(origin)
            current = urlsplit(str(request.url))
            same_origin = (parsed.scheme, parsed.netloc) == (current.scheme, current.netloc)
            local_dev = parsed.scheme == "http" and parsed.hostname in ("localhost", "127.0.0.1") and parsed.port == 5173 and current.hostname in ("localhost", "127.0.0.1")
            if not same_origin and not local_dev:
                return JSONResponse({"message": "request_not_allowed"}, status_code=403)
        status, data = await dashboard.refresh()
        headers = {"Retry-After": str(data["retry_after_seconds"])} if status == 429 else None
        return JSONResponse(data, status_code=status, headers=headers)

    dist = ROOT / "frontend/dist"
    if (dist / "assets").is_dir():
        app.mount("/assets", StaticFiles(directory=dist / "assets"), name="assets")

    @app.get("/favicon.svg")
    async def favicon():
        return FileResponse(ROOT / "frontend/public/favicon.svg", media_type="image/svg+xml")

    @app.get("/")
    async def index():
        if not (dist / "index.html").is_file():
            return JSONResponse({"message": "frontend_build_required"}, status_code=503)
        return FileResponse(dist / "index.html")

    return app


app = create_app()
