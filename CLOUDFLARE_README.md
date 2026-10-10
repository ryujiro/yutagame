# 無料で公開する「まなびノート」

Cloudflare Workers Freeでスマホ向けのサイトを表示し、GitHub ActionsのPython + Playwrightで学習時間を取得します。有料Browser Rendering、Durable Objects、Cloudflare APIトークンは使いません。閲覧用のログインはありません。

## 公開済みのサイト

**https://manabi-note.family-dashboard.workers.dev/**

2026-10-10 20:13（日本時間）に公開サイトのHTML・health・dashboardのHTTP200、スマホ幅390/320での表示を確認しました。現在の198分は18:22の保存済み実記録です。次は下の「自動取得を設定する」を行います。

## まずサイトを公開する

[Cloudflareの公開画面を開く](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fryujiro%2Fyutagame)

以前の公開画面を開いている場合は、上のリンクから開き直します。

1. 「新しいGitHub接続」を押し、GitHubで接続を許可する。
2. プロジェクト名は `manabi-note`。既存の `family-dashboard` は変更しない。
3. 「デプロイ」を押す。有料Browser Renderingへの案内は、最新の無料版設定では不要。
4. 完了後にCloudflareが表示する `https://…workers.dev/` を開く。そのURLを家族に共有する。

公開ウィザードはサイト用のGitリポジトリを複製します。サイトは複製側で動き、取得するデータは元の `ryujiro/yutagame` から読みます。取得用の設定は下記の元リポジトリで行ってください。

ボタンから進めない場合はWorkers & PagesでGitHubの `ryujiro/yutagame` を取り込みます。ブランチ `main`、ルートディレクトリは空欄、ビルド `npm run build`、デプロイ `npm run deploy`、Worker名 `manabi-note`。Workers Freeを使用し、有料プランの購入は不要です。

このリンクは公開手続きの入口です。発行前のサイトURLを公開済みとして扱わないでください。

## 次に自動取得を設定する

[GitHubの取得用シークレット設定を開く](https://github.com/ryujiro/yutagame/settings/secrets/actions)

「New repository secret」から、次の2つを登録します。

| Name | Secretに入力する値 |
| --- | --- |
| `SMILE_ZEMI_LOGIN_ID` | みまもるネットのログインID |
| `SMILE_ZEMI_PASSWORD` | みまもるネットのパスワード |

値はGitHubのSecret欄にだけ入力します。チャット・ソースコード・通常のVariablesには書きません。Codex CloudのシークレットはGitHubに自動転送されません。CloudflareにこのID・パスワードを登録する必要はありません。

[GitHub Actionsを開く](https://github.com/ryujiro/yutagame/actions/workflows/learning-records.yml)。必要ならActionsを有効にし、「Run workflow」で `main` を選び、1回実行します。定期取得は日本時間15:17〜22:17の毎時17分です。GitHub側の混雑で遅れる場合があります。公開リポジトリの標準GitHub-hosted runnerの無料枠を使い、有料runnerを選びません。

実行が成功したらサイトで「表示を更新」を押します。これは保存記録を読み直す操作で、みまもるネットにログインする操作ではありません。GitHubの配信キャッシュで反映まで数分かかる場合があります。追加でサイトを再デプロイする必要はありません。

Actionsの取得処理は元の `ryujiro/yutagame` だけで実行します。ウィザードで作った複製側のworkflowは取得ジョブをスキップします。

## データと失敗時の動作

`public-data/dashboard.json` に学習日・合計分・教科別分・取得日時の最新100件と、最終試行時刻・固定の取得状態だけを保存します。このデータは、閲覧制限を設けないという指定に従って公開します。ID・パスワード・子どもの名前・ID・Cookie・ticket・セッショントークン・認証後DOMは保存しません。

初回は実取得済みの記録を表示します。現在の最新記録は2026-10-10 18:22:20取得、198分（数学2分、英語19分、国語100分、理科4分、社会73分）。これを起動時の新たな取得結果とは表示しません。GitHubの設定前は「自動取得は準備中です」と表示します。

取得関数は独立した `fetch_today_learning_time()`、Actions用の入口は `scripts/update_public_data.py`。未設定なら認証を試行せず、不足する変数名を報告します。取得は同時に1ジョブ、全試行に10分の待ち時間を設けます。自動再試行はありません。失敗時は前回の記録・取得日時を保持します。CAPTCHAや多要素認証は回避せず、手動確認を報告します。中学生コース・子ども1人の確認済み画面に対応します。

無料WorkerはGitHubの公開JSONをHTTPSで読み、ホスト・日付・分数・教科合計・日時を検証します。配信先の障害や不正なデータの場合は、ビルドに含めた実記録を表示して案内を出します。GitHubの公開JSONが必須なので、元リポジトリを非公開に変更する場合は取得結果の配信方法も変更が必要です。

## 開発と検証

```bash
cd /workspace/yutagame
npm ci --cache /workspace/.cache/npm --no-audit --no-fund
npm run build
npm test
XDG_CONFIG_HOME=/workspace/yutagame/.local/wrangler-config WRANGLER_SEND_METRICS=false npm run check:cloudflare
/workspace/.venvs/yutagame/bin/python -m unittest discover -s tests -v
```

クラウド内のローカル検証は同じ環境変数で `npm run dev:cloudflare`。`wrangler.local.jsonc` は同梱データだけを読み、外部への取得やログインを行いません。画面検証は `MANABI_WEB_URL=http://127.0.0.1:8787 /workspace/.venvs/yutagame/bin/python tests/web_browser_checks.py`。

`cloudflare/src/fetch-smile.js` と `service.js` は以前の実装の検証用として残していますが、無料Workerには読み込まれません。Cloudflare公式Playwrightの依存、Browser binding、Durable Object binding、マイグレーション、必須シークレットは公開設定から削除しました。

CloudflareとGitHubの無料利用枠の範囲で利用します。無料枠を超えた場合に有料へ自動移行する設定は追加していません。Cloudflare公開URLは確認済みです。GitHub Actionsでの実取得は、本人のシークレット設定後に確認します。[検証レポート](CLOUDFLARE_VERIFICATION_REPORT.md)を参照してください。
