# Family Safetyの時間記録

## 学習の手動更新（2026-10-11追加）

「学習時間を更新」は `/api/refresh` にPOSTし、Cloudflare Browser Runからみまもるネットへ正規ログインして今日の学習を取得する。GET/画面読み込みではログインしない。取得値はDOMと記録APIを照合し、D1の同日最新合計にも保存。失敗時は前回記録を維持し、ログインの自動再試行はしない。

必要: `BROWSER` binding、`@cloudflare/playwright` 1.3.6、migration `0002_manual_learning.sql`、Worker secrets `SMILE_ZEMI_LOGIN_ID` / `SMILE_ZEMI_PASSWORD`。`tools/configure-smile-secrets.ps1 -ResultFile <結果JSONの場所>` の別ウィンドウで入力し、EnterでID確定、パスワード入力後Enterで保存。パスワードは表示しない。結果JSONは成功可否だけで、ID/PWを書かない。

アプリ独自の取得間隔・1日回数制限はありません。取得終了後はすぐ次の手動更新ができます。別Worker間の同時要求だけはD1の予約で排他制御します。古い待ち時間・取得回数は制限に使いません。無料のBrowser Run枠にも利用上限があり、アカウント全体の枠を使い切ると取得は失敗する。有料プランへの変更はしていない。[Cloudflare料金・上限](https://developers.cloudflare.com/browser-run/pricing/)。

閲覧ログインは追加していないため、URLを知る人は記録閲覧と手動取得を実行可能。別サイトのブラウザからのPOSTはOriginと専用ヘッダーで拒否するが、この確認は閲覧者認証ではない。

## 構成

既存のReact画面・Workers・GitHub公開学習記録を維持し、新しいD1 `manabi-time-ledger` を追加。Microsoft認証情報は取得・保存しない。Windows側は別プロジェクトM5timeの独立した `M5time.ManabiBridge` がローカルログを読み、1分ごとの専用タスクで送信する。M5Stack側には変更なし。

## 数値の意味

- 学習: 既存学習記録の同日最新合計だけを加算。古い再送で巻き戻さない。
- 付与: Windowsの明示的な終了時刻変更を保存。選択分数そのものは取得できないため、自動取得は推定。原本のneeds_reviewは維持し、保護者指定により画面では確認操作なしで推定を利用する。
- 表示残高: 日本時間の当日・前日2日分の学習−付与（確認済み実分数＋未確認の推定分数）＋手動調整、1分:1分。日付変更で2日前の分が対象外になる。`dashboard.ledger.recent.estimated_balance_minutes`/`estimated_total_granted_minutes`を使用。推定を含む表示は推定と明記。既存の厳密な残高/確認済み集計と全期間集計は互換性のためAPIに保持する。
- 未取得学習や不明な付与分数は0分にしない。対象2日内に学習欠損、分数不明、調整読取障害がある場合は「—」。PC接続不明だけなら最終受信時点の保存残高を表示し、日時を添える。取得できた推定は実際の追加選択分数を証明するものではなく、重ねて追加などで差が生じ得る。
- 過去の保存済み原本は消さず、学習/付与/手動調整履歴として取得履歴タブに表示する。手動調整は実学習・付与と別の記録で、取得合計を変更しない。

残高は表示中30秒ごとと画面/通信復帰時にGETで読み直す。残高横の更新アイコンもGETのみで、スマイルゼミへログインしない。読み直し失敗時は前回表示と通信案内を残し、古いGETが学習更新結果を上書きしない。追加のDB migration/認証変更/Windowsタスク変更は不要。

## 手動調整（2026-10-11追加）

ホームの「手動調整」の＋から加算/減算・分数（1〜1440の整数）・任意メモ（120文字以内）を入力。10/30/60分を選択でき、調整ごとに日時と`+30分`/`-10分`などを表示する。取り消しアイコンで逆符号の記録を1回だけ残し、原本は保持する。今日・昨日の調整だけが残高に含まれ、3日目以降は履歴だけに残る。翌日の取消も元の調整の日付に計上する。

`POST /api/manual-adjustments`: 新規は`request_id`（UUID）, `delta_minutes`（符号付き整数）, `note`（省略可）。取消は`request_id`, `reversal_of`（元のUUID）のみ。日付/取得元/認証情報の追加は不可。サーバーが日時を決定する。主キーと取消対象の一意制約により再送・同時要求を二重登録しない。同UUIDの異なる内容や二度目の取消は409。

保護者指定によりパスワードなしで、URLを知る人は調整を追加/取消できる。同一Originと`X-Balance-Request: 1`の検査はブラウザの他サイトからの送信対策であり、本人確認ではない。公開編集を防ぐ認証は別途必要。調整用secretは作成していない。既存Family Safety送信のBearer認証とスマイルゼミ認証は維持する。

migration `0003_manual_adjustments.sql`を同じD1へ適用してからWorkerを配備する。migrationが失敗したら配備を止め、再実行の成功を確認する。新テーブルは学習/付与の既存テーブルを変更しない。調整の保存障害は503、読み込み障害は調整エラーと残高「—」になるが、学習表示は継続する。

## Family Safety API

POSTは `FAMILY_SAFETY_INGEST_TOKEN` のBearer認証必須。キーはブラウザに渡さず、Worker secretとWindows暗号化設定にだけ保存。最低32文字。Microsoft Cookie/トークン/パスワードを受理しない。

1. `/api/family-safety/events`: event_id（SHA256）, source_id（UUID）, subject_id（匿名別名）, occurred_at, allow_until, observed_at, source, detection_method, estimated_minutes（不明ならnull）。明示したAllowUntilだけを送る。granted_minutesは送信不可。
2. `/api/family-safety/status`: source_id, checked_at, read_status, coverage_start, local_used_minutes。最新報告から5分以上なら接続未確認。
3. `/api/family-safety/events/<event_id>/confirm`: granted_minutes, method=`parent_verified_selected_minutes`。保護者が実際の選択分数を確認した時だけ使う。確認日時・方法も保存。

イベント番号の主キーで二重登録を防ぐ。同番号で終了時刻が違う場合と、既に確認した分数を変更する場合は409。学習保存が失敗しても従来の学習画面は200で表示し、時間記録だけエラーを表示する。

閲覧は元サイトと同じ公開方式。URLを知っている人は日時・分数・確認状態を閲覧できる。非公開閲覧は別途対応が必要。

## 配備

```powershell
# frontend内で既存のnpm run build相当を実行
node node_modules/vite/bin/vite.js build
# プロジェクトルート
node node_modules/wrangler/bin/wrangler.js d1 migrations apply manabi-time-ledger --remote
node node_modules/wrangler/bin/wrangler.js deploy --dry-run
node node_modules/wrangler/bin/wrangler.js deploy
node node_modules/wrangler/bin/wrangler.js secret put FAMILY_SAFETY_INGEST_TOKEN
```

入力キーをソースや引数に書かない。`wrangler.jsonc` のD1 binding・毎時27分のcron・既存RECORDS_URLを維持する。cronは学習の既存公開記録を取り込むだけで、スマイルゼミへログインしない。既存の学習自動取得設定は今回変更していない。

新D1だけにmigrationを適用する。既存の別DBを変更・削除しない。学習日別履歴はD1に残るので、公開JSONの古い取得スナップショットが消えても保存済みの日別合計を保持する。

## 検証

```powershell
node --test cloudflare/tests/family-safety.test.js cloudflare/tests/learning.test.js cloudflare/tests/saved-records.test.js
node node_modules/wrangler/bin/wrangler.js d1 migrations apply manabi-time-ledger --local --config wrangler.local.jsonc
node node_modules/wrangler/bin/wrangler.js dev --config wrangler.local.jsonc --ip 127.0.0.1 --port 8789
$env:LEDGER_UI_URL='http://127.0.0.1:8789'
node --test cloudflare/tests/ledger-ui.test.js
```

実ブラウザ試験は `CHROME_PATH` でChromeの場所を変更可能。画面試験の付与記録は合成データで、本番DBに追加しない。スクリーンショットはOSの一時フォルダー `manabi-ledger-ui`。`LEDGER_ARTIFACT_DIR` で変更可能。

## 戻す場合

変更前のWorker version: `9dc47f17-1885-490f-b14d-2bf5f88c1cd3`。戻してもD1の履歴は削除しない。Windowsでは専用タスク `M5time.ManabiBridge` だけを無効化する。M5timeサービス・既存FamilySafetyタスク・ファームウェア・認証は操作しない。
