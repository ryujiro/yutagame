# まなびノートの起動方法

React + Vite の画面と、Python + FastAPI のサーバーで動作します。前回取得した学習時間を表示し、「学習時間を更新」から `fetch_today_learning_time()` を呼び出します。定期取得はしません。

スマホから開くための公開版は[Cloudflare公開手順](CLOUDFLARE_README.md)を使ってください。以下はPythonサーバーを使うローカル版の手順です。

## このクラウド環境で起動する

依存関係と画面のビルドは準備済みです。

```bash
cd /workspace/yutagame
bash scripts/run_web.sh
```

8000番ポートで起動します。Codex Cloud内の127.0.0.1は、手元のPCのブラウザから直接アクセスするURLではありません。ポート転送または公開先への配置が必要です。今回は公開URLの発行までは行っていません。

## 初めて準備する場合

Python 3.10以上、Node.js 22.12以上、Chromiumが必要です。この環境はPython 3.12・Node.js 24・`/usr/bin/chromium`を使用しています。

```bash
cd /workspace/yutagame
python3 -m venv /workspace/.venvs/yutagame
PIP_CACHE_DIR=/workspace/.cache/pip /workspace/.venvs/yutagame/bin/python -m pip install -r requirements-web.txt
npm --prefix frontend ci --cache /workspace/.cache/npm --no-audit --no-fund
npm --prefix frontend run build
bash scripts/run_web.sh
```

別のマシンではvenvの場所を変更できます。`WEB_PYTHON` にPythonの実行ファイル、`WEB_PORT` にポート番号を指定します。Chromiumの場所を変更するときは `SMILE_ZEMI_CHROMIUM_PATH` を指定します。

## 認証情報

`SMILE_ZEMI_LOGIN_ID` と `SMILE_ZEMI_PASSWORD` を、実行するサーバーの環境に設定します。設定手順は[README.md](README.md#認証情報の安全な設定)を参照してください。Codex Cloudでは、両シークレットの送信先を `smile-zemi.jp` と `m.smile-zemi.jp` にします。

値を画面・ソースコード・Git・コマンド引数に入力する必要はありません。ブラウザには認証情報を返しません。未設定ならログインを試さず、更新ボタンを無効にします。CAPTCHA・多要素認証が必要な場合は手動確認の案内を出して停止します。

## 表示と履歴

初回は `verification-results/today.json` に保存された**実取得結果**を読み込みます。現在は2026-10-10 16:07取得、合計162分の記録です。これは初回表示用の過去の実データであり、起動時に新たに取得したという意味ではありません。保存記録がなければ空画面になります。

新しい取得が成功した場合だけ、取得時刻付きの履歴を追加します。最新100件を `.local/web-state.json` に保存します。これは取得履歴であり、1日1件の集計ではありません。保存する項目は日付・分数・教科・取得日時・最終試行時刻・固定のエラー案内です。Cookie・セッショントークンは保存しません。`.local` はGit管理対象外です。

取得失敗時は前回の結果と取得日時を保持します。教科別がnullなら「取得されていません」と表示し、0分にしません。日付は日本時間で判定し、前日以前の記録は「最近の学習」と注意文を表示します。

連続認証を減らすため、成功・失敗ともに試行から10分は再更新を止めます。これはアプリの待ち時間で、10分でサイトの認証制限が解除されるという保証ではありません。サーバー側でも制御するため、複数タブ・連打・再起動で待ち時間を回避できません。1プロセス・1workerで起動してください。CLIを直接実行した場合は、このWeb版の待ち時間管理の対象外です。

現在の自動取得は、お子さま1人・中学生コースに対応しています。複数のお子さま、他コースは未対応です。

## APIと開発

| 操作 | エンドポイント | 動作 |
|---|---|---|
| 状態取得 | `GET /api/dashboard` | 保存結果と履歴を返す。ログインしない |
| 手動更新 | `POST /api/refresh` | 正規画面から1回だけ取得する |
| 起動確認 | `GET /api/health` | `{"status":"ok"}` |

更新POSTには `X-Learning-Request: 1` が必要です。別Originのリクエストや通常フォームからは更新できません。競合中は409、待ち時間中は429、取得失敗は502、未設定・保存失敗は503です。失敗レスポンスにも前回結果を含みます。

画面の開発中は、バックエンドを起動したうえで別の端末から `npm --prefix frontend run dev` を実行します。Viteが `/api` を8000番ポートへ転送します。

```bash
/workspace/.venvs/yutagame/bin/python -m unittest discover -s tests -v
# サーバーを起動した状態で、ログインなしの画面検証:
/workspace/.venvs/yutagame/bin/python tests/web_browser_checks.py
```

ユーザーの指定に従い、閲覧ログインは設けません。Cloudflare公開版はHTTPSのURLから閲覧・手動更新できます。スマイルゼミの認証情報はサーバー側のシークレットとして扱います。
