# Family Safetyの時間記録

## 構成

既存のReact画面・Workers・GitHub公開学習記録を維持し、新しいD1 `manabi-time-ledger` を追加。Microsoft認証情報は取得・保存しない。Windows側は別プロジェクトM5timeの独立した `M5time.ManabiBridge` がローカルログを読み、1分ごとの専用タスクで送信する。M5Stack側には変更なし。

## 数値の意味

- 学習: 既存学習記録の同日最新合計だけを加算。古い再送で巻き戻さない。
- 付与: Windowsの明示的な終了時刻変更を保存。選択分数そのものは取得できないため、自動取得は推定・要確認。確認済み分数だけを累計に含める。
- 残高: 学習累計−確認済み付与累計、1分:1分。日付でリセットしない。
- 未取得学習は0分にしない。学習欠損、要確認付与、PC接続不明がある場合、利用可能残高は「—」。保存済み記録の差額は別表示で、過去全期間の持ち越し残高とは断定しない。
- ログ保持期間以前の付与と、学習元から届かなかった日別記録は復元できない。正確な初期持ち越し残高の補正は未実装。

## API

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
