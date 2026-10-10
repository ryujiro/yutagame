# Cloudflare版の検証結果

2026-10-10、Codex CloudでCloudflare用のコード・設定・公開手順を準備しました。Worker名はmanabi-note。既存family-dashboardを対象にする設定・API操作は含めていません。ユーザーの指定どおり閲覧ログインはありません。

## 成功したこと

- Wrangler 4.149.0、Cloudflare公式Playwright 1.3.6を固定してインストール。
- `wrangler deploy --dry-run` 成功。画面のStatic Assets、Browser Run、SQLite Durable Objectの設定を確認。gzip後のWorkerは約631KiB。
- Nodeの21テスト成功。日本時間・APIの厳密な解析・成功履歴・再起動後の待ち時間・同時取得1回・未設定・例外の秘密抑止・保存失敗を検証。
- うち5テストは実Chromiumに**合成フォームと合成APIだけ**を読み込み、同じ取得関数の画面操作・遅延API待ち合わせ・DOM/API照合・401停止・不一致POSTの送信前停止・複数のお子さまの停止を検証。ネットワークは全てフィクスチャで応答し、実サイトの認証は行っていない。
- Wranglerの実workerdランタイムでローカル起動。ルートHTML・health・dashboardが200。保存済みの162分と元の16:07取得日時を返す。別Originからの更新POSTは403。詳細は[cloudflare-local.json](verification-results/cloudflare-local.json)。
- 共通React画面をCloudflare版のAPIにつなぎ、実ブラウザでデスクトップ1440×1000・スマホ390×844と320×844を確認。画面・履歴・連打・失敗・空状態・null教科・日付変更の検査は模擬応答を使用。

Nodeの最初の合成ブラウザ検査は、日本語フィクスチャの文字コード指定がなくボタンを見つけられず失敗した。UTF-8指定を修正し、全21件が成功した。これはフィクスチャの問題で、実サイト認証の成功・失敗とは別。

## まだ成功していないこと

- この環境にはCloudflareを操作するアカウント認証・APIトークンがない。
- Cloudflare APIへの公開の読み取り確認は、外向きプロキシから503となった。APIトークン不足が503の原因だとは断定しない。
- ユーザー提示の既存URLは、このクラウドからのHTTP取得で403を返した。ユーザーのスマホから開けないという意味ではなく、既存サイトには変更していない。
- **Cloudflareへの実公開、公開URLの発行、公開先Browser Runでの接続・実認証・最新学習時間抽出は未検証。** ローカル成功やdry-runは公開成功ではない。

元のPython版は16:07に162分を実取得したが、Web版から16:30頃に再試行した際は認証確認に失敗した。そのため、Cloudflare版でも毎回ログインできるとは保証しない。公開先で最初に見える162分は、新たな取得結果ではなく保存済み実記録である。

次の具体的な操作は[CLOUDFLARE_README.md](CLOUDFLARE_README.md)の公開リンクから、ユーザーのCloudflareアカウントでGitHub連携と公開を行うこと。Cloudflareが返した実URLで画面とhealthを確認し、シークレットを設定後に1回だけ手動取得して各段階を検証する。
