#!/usr/bin/env bash
set -eu
cd "$(dirname "$0")/.."
WEB_PYTHON="${WEB_PYTHON:-/workspace/.venvs/yutagame/bin/python}"
exec "$WEB_PYTHON" -m uvicorn web_app:app --host 127.0.0.1 --port "${WEB_PORT:-8000}" --workers 1 --no-access-log
