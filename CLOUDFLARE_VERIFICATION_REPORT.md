# 無料版への変更と検証（2026-10-10）

ユーザーのCloudflare公開画面で、Browser RenderingにWorkers Paidが必要という表示を確認し、ユーザーの「無料」という指定に合わせて構成を変更した。サイトはWorkers Free、取得はGitHub Actionsの標準Linux runnerでPython + Playwrightを使用する。有料契約はしていない。

## 今回確認したこと

- Browser Renderingの依存・binding、Durable Objectのbindingとマイグレーション、Cloudflare側の必須認証シークレットを削除。Workerは画面と公開JSONの読み取りだけを行う。
- 無料Workerのdry-run成功。gzip約3.3KiB。bindingはStatic Assetsと非秘密の公開JSON URLだけ。
- Node29件、Python55件、計84件のテストが成功。無料版のJSON検証・前回値保持・JST・GETによる表示更新・認証POSTなし・取得用スクリプトの未設定停止・失敗後10分待機を含む。
- Reactの本番ビルド成功。ローカルの実workerdで画面を起動し、スマホ幅390/320を含む画面10項目が成功。無料版の表示更新でGETが1回、認証POSTが0回であることを確認。
- Workflow YAMLの読み込み、時刻設定、単一ジョブ、書き込み権限の構造を確認。actionlintは環境にないため未実行。GitHub上でのworkflow実行は未確認。
- GitHubの既存の公開JSONを認証情報なしのHTTPS GETで読めた（200）。新しい公開JSONもmainへの保存後にHTTPS GETで200を確認。198分・18:22取得の値が一致した。[free-public-json.json](verification-results/free-public-json.json)。
- **Codex CloudのLinuxから、変更後のActions用Python入口を使って実取得を1回実行し、全5段階が成功した。** 実結果は2026-10-10T18:22:20+09:00、198分、数学2分・英語19分・国語100分・理科4分・社会73分。画面・API・教科合計を照合した。[free-live.json](verification-results/free-live.json)。公開用の履歴には必要な項目だけを追加し、GitHubの自動取得設定は未完了の表示を維持した。

採用画像と最新のデスクトップ・スマホ画面を同時に確認し、ナビと本文の配置、合計と内訳の位置、文字の階層、教科の色、余白の5点を比較した。無料版では操作名を「表示を更新」へ変更し、取得準備の案内を追加した。198分・5教科・2件の履歴は実取得データであり、採用画像の162分をコピーした結果ではない。

本番設定の外部読み取りもローカルworkerdで試した。Cloudflareが非対応の `redirect: error` を検出し、`manual` に修正して3xxは受理しないようにした。8件の関連テストとdry-runを再実行して成功。修正後のネイティブworkerdの外部HTTPSはGitHub・example.comの双方でタイムアウトした。環境プロキシ経由のPython HTTPSは200なので、この環境のworkerd外向き通信の制約として切り分けた。TLS検証は維持している。最新確認の失敗を案内しながら、同梱198分と元の取得日時を保持する動作を確認した。[free-worker-source.json](verification-results/free-worker-source.json)。公開Cloudflareでの外部読み取り成功はまだ確認していない。

## 未完了

Cloudflareへの公開と発行URL、ユーザーのGitHubシークレット設定、GitHub-hosted runnerからの実認証とJSONの更新、公開URLから新しい値が読めることは未検証。Codex Cloudでの実取得成功をGitHub Actionsの成功と混同しない。ログインの安定性も継続検証が必要。

次は無料版の公開画面を開き直してGitHubと接続し、サイトを公開する。その後、元リポジトリryujiro/yutagameのGitHub Actions SecretsにID・パスワードを本人が設定し、手動実行を1回確認する。サイトの「表示を更新」は保存済みJSONのGETであり、ブラウザ上で認証はしない。

---

# 以前のBrowser Run構成の記録（現在の公開設定では使用しない）

# Cloudflare版の検証結果

2026-10-10、Codex CloudでCloudflare用のコード・設定・公開手順を準備しました。Worker名はmanabi-note。既存family-dashboardを対象にする設定・API操作は含めていません。ユーザーの指定どおり閲覧ログインはありません。

## 成功したこと

- Wrangler 4.149.0、Cloudflare公式Playwright 1.3.6を固定してインストール。
- `wrangler deploy --dry-run` 成功。画面のStatic Assets、Browser Run、SQLite Durable Objectの設定を確認。gzip後のWorkerは約631KiB。
- Nodeの21テスト成功。日本時間・APIの厳密な解析・成功履歴・再起動後の待ち時間・同時取得1回・未設定・例外の秘密抑止・保存失敗を検証。
- 更新した `scripts/setup_cloud.sh` を実行し、依存関係・画面ビルド・Workerビルド・Node21件・Python48件の合計69テストが成功。セットアップ時の実ログインは0回。
- うち5テストは実Chromiumに**合成フォームと合成APIだけ**を読み込み、同じ取得関数の画面操作・遅延API待ち合わせ・DOM/API照合・401停止・不一致POSTの送信前停止・複数のお子さまの停止を検証。ネットワークは全てフィクスチャで応答し、実サイトの認証は行っていない。
- Wranglerの実workerdランタイムでローカル起動。ルートHTML・health・dashboardが200。保存済みの162分と元の16:07取得日時を返す。別Originからの更新POSTは403。詳細は[cloudflare-local.json](verification-results/cloudflare-local.json)。
- 共通React画面をCloudflare版のAPIにつなぎ、実ブラウザでデスクトップ1440×1000・スマホ390×844と320×844を確認。画面・履歴・連打・失敗・空状態・null教科・日付変更の検査は模擬応答を使用。

採用画像 `design/concept.png` とCloudflareローカルAPIにつないだ最新の実画面を同時に開き、左ナビと本文の配置、合計と内訳の位置、文字の階層、4教科の色、余白と操作の5点以上を比較した。主要なコピーの変更はない。未設定案内は必要な状態表示として追加。デザインの仕様と数値に忠実な棒の割合は[既存の照合レポート](WEB_VERIFICATION_REPORT.md#デザイン照合)を参照。専用Browser/IABがないためローカルPlaywright Chromiumを使用。

Nodeの最初の合成ブラウザ検査は、日本語フィクスチャの文字コード指定がなくボタンを見つけられず失敗した。UTF-8指定を修正し、全21件が成功した。これはフィクスチャの問題で、実サイト認証の成功・失敗とは別。

## まだ成功していないこと

- この環境にはCloudflareを操作するアカウント認証・APIトークンがない。
- Cloudflare APIへの公開の読み取り確認は、外向きプロキシから503となった。APIトークン不足が503の原因だとは断定しない。
- ユーザー提示の既存URLは、このクラウドからのHTTP取得で403を返した。ユーザーのスマホから開けないという意味ではなく、既存サイトには変更していない。
- **Cloudflareへの実公開、公開URLの発行、公開先Browser Runでの接続・実認証・最新学習時間抽出は未検証。** ローカル成功やdry-runは公開成功ではない。

元のPython版は16:07に162分を実取得したが、Web版から16:30頃に再試行した際は認証確認に失敗した。そのため、Cloudflare版でも毎回ログインできるとは保証しない。公開先で最初に見える162分は、新たな取得結果ではなく保存済み実記録である。

次の具体的な操作は[CLOUDFLARE_README.md](CLOUDFLARE_README.md)の公開リンクから、ユーザーのCloudflareアカウントでGitHub連携と公開を行うこと。Cloudflareが返した実URLで画面とhealthを確認し、シークレットを設定後に1回だけ手動取得して各段階を検証する。
