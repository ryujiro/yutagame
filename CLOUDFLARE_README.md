# スマートフォンから開くためのCloudflare公開手順

既存のCloudflareアカウントを使い、新しいWorker **manabi-note** を作ります。既存の `family-dashboard` を編集する設定は含みません。ユーザーの希望に従い、閲覧ログインは設けません。

## まず押すリンク

**[Cloudflareでこのサイトを公開する](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fryujiro%2Fyutagame)**

Cloudflareにログインし、既存アカウントを選びます。画面の指示に従ってGitHubとの連携を許可し、このリポジトリを使って公開します。Worker名は `manabi-note` にします。公開が完了したら、Cloudflareに表示される `https://…workers.dev/` のURLをスマホで開き、家族へ共有できます。

**URLが表示されてから公開成功です。** このリンクを押すだけで、既にサイトが公開済みという意味ではありません。

## リンクから進められない場合

1. Cloudflareの **Workers & Pages** を開き、新しいWorkerの作成からGitHubリポジトリのインポートを選びます。
2. `ryujiro/yutagame` の `main` を選びます。ルートディレクトリはリポジトリのルートです。
3. Worker名を `manabi-note`、ビルドを `npm run build`、デプロイを `npm run deploy` にします。Node.js 22.12以上を使います。
4. 作成・公開し、表示されたURLを開きます。

`wrangler.jsonc` に、画面配信・Browser Run・履歴用Durable Objectsの設定が入っています。有料プランへの変更はこの構成では指定していません。Browser RunやDurable Objectsの利用可否・無料枠はアカウントのプランと実際の画面を確認してください。枠を超えたりブラウザ機能が使えない場合、新しい取得は失敗し、前回の表示を保持します。

## 学習時間を更新するための設定

公開先のWorkerで **Settings → Variables and Secrets** を開き、次の2つを **Secret** として設定します。

| 名前 | 設定する値 |
|---|---|
| `SMILE_ZEMI_LOGIN_ID` | みまもるネットのログインID |
| `SMILE_ZEMI_PASSWORD` | みまもるネットのパスワード |

値はCloudflareの設定画面だけに入力してください。チャット・GitHub・ソースコード・ビルド変数に貼り付けません。Codexのシークレット設定はCloudflareへ自動転送されません。プロキシの置換用文字列を転記することもありません。

最初は保存済みの2026-10-10 16:07取得、162分の**実取得記録**を表示します。新しい取得はシークレット設定後に更新ボタンで1回実行します。未設定時は更新できません。Cloudflare上での実認証と当日抽出は、公開・シークレット設定後に検証する必要があります。Codex Cloudで一度成功したことは、Cloudflareでも成功する証拠にはしません。

## 構成

React画面はPython版と共通です。WorkersはPythonサーバーを動かす環境ではないため、公開版の取得は独立したJavaScript関数 `fetchTodayLearningTime()` とCloudflare公式Playwrightを使用します。取得条件・既存セレクタ・DOM/API照合はPython版に合わせています。元のPython関数も残しています。

- **Workers / Static Assets**：画面と同一URLのAPI。Cloudflare側でHTTPSを提供。
- **Browser Run**：正規画面操作による1回の取得。認証後のスクリーンショット・Cookie・DOMは保存しない。
- **SQLite Durable Object**：取得履歴100件と最終試行時刻・固定エラー案内。全訪問者で同じ10分の待ち時間を管理。

Cookie・セッショントークンは履歴に保存しません。複数のお子さま・中学生以外のコースには未対応です。CAPTCHA・多要素認証がある場合は止めます。認証失敗は自動再試行しません。定期実行はしません。

## 開発者向け確認

```bash
npm ci --cache /workspace/.cache/npm --no-audit --no-fund
npm run build
npm test
# Codex環境の設定・ログの書き込み先をworkspace内にする:
XDG_CONFIG_HOME=/workspace/yutagame/.local/wrangler-config WRANGLER_SEND_METRICS=false npm run check:cloudflare
XDG_CONFIG_HOME=/workspace/yutagame/.local/wrangler-config WRANGLER_SEND_METRICS=false npm run dev:cloudflare
```

`check:cloudflare` はビルド検査だけで公開しません。`dev:cloudflare` はローカル版の設定を使用し、Browser Runやシークレットを設定していません。ローカル版を実認証の証拠にしません。

```bash
MANABI_WEB_URL=http://127.0.0.1:8787 /workspace/.venvs/yutagame/bin/python tests/web_browser_checks.py
```

CLIから公開する場合は、**自分のPC**で `npx wrangler login` のCloudflareログインを済ませ、`npm run deploy` を実行します。トークンをコマンド引数に貼り付ける必要はありません。公開時にアカウントの制限で失敗した場合、エラーを確認して対応し、有料契約を自動で追加しません。
