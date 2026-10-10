#!/usr/bin/env bash
set -eu
cd /workspace/yutagame
mkdir -p /workspace/.venvs /workspace/.cache/pip /workspace/.cache/npm
python3 -m venv /workspace/.venvs/yutagame
PIP_CACHE_DIR=/workspace/.cache/pip /workspace/.venvs/yutagame/bin/python -m pip install -r requirements-web.txt
PIP_CACHE_DIR=/workspace/.cache/pip /workspace/.venvs/yutagame/bin/python -m pip check
# この環境にはシステムChromiumがある。追加インストールや信頼ストア変更を行わない。
command -v chromium >/dev/null
node --version
npm --prefix frontend ci --cache /workspace/.cache/npm --no-audit --no-fund
npm --prefix frontend run build
npm ci --cache /workspace/.cache/npm --no-audit --no-fund
npm test
XDG_CONFIG_HOME=/workspace/yutagame/.local/wrangler-config WRANGLER_SEND_METRICS=false npm run check:cloudflare
/workspace/.venvs/yutagame/bin/python -m unittest discover -s tests -v
# ログインはセットアップ時には行わない。
