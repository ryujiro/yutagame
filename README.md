# まなびノート — みまもるネット学習ダッシュボード

2026-10-13: 日付変更後、取得元に今日の記録がない場合を「今日の学習記録はまだありません」と案内します。前回の分数・取得日時は保持し、今日を0分で埋めません。APIは取得未達のHTTP502を維持し、固定の`error.code`と`last_attempt_at`で原因と試行日時を確認できます。実調査の結果は[HANDOFF.md](HANDOFF.md)を参照してください。現在の取得はCloudflareの手動ログインが主系統です。旧GitHub Actionsの定期取得はActions側の認証情報未設定で停止しており、Cloudflare側の認証設定とは別です。

2026-10-12: 過去の学習時間を「これまでの取り組み」に追加。学習時間の更新と同じログインで、日別履歴の「もっと見る」を取得元の終端までたどり、既存D1に日付ごとの最新分数を保存します。累計・月別時間・日別一覧と月選択を表示。再取得は置換なので二重加算しません。時間切れ/通信障害は取得済みと続きを保存し、次の手動更新で再開。現在の実取得範囲は中学生コースの2026/09/30〜10/12、記録12日・1,636分（27時間16分）。取得元が返さない日を0分にせず、以前のコースの記録まで取得できたとは扱いません。時間残高は昨日・今日だけのまま、月の実績カウントとM5Stackも変更なし。

2026-10-12: 月の取り組み記録を追加。「学習時間を更新」の同じログイン中に今月の実績・目安・5教科の数値も取得し、ホーム下部と取得履歴に表示します。これは完了した通常講座と達成したミッションの数で、学習分数や時間残高には加算しません。月の取得に失敗しても日別時間は更新でき、月の前回記録を保持。月ごとの最新値を既存D1のスナップショットに保存し、同じ月を二重加算しません。M5Stack側は変更なし。

2026-10-12: 保護者の指定で、残高は確認操作なしで推定付与も含めて表示します。当日・前日の「学習−付与（確認済み実分数＋未確認の推定分数）＋手動調整」。推定を含む数値には「推定」と表示し、原本を確認済みに変更しません。PC停止中は最終受信時点の保存記録を使用し、分数不明・学習欠損・読取障害は「—」のまま。表示中は30秒ごと・画面復帰時に残高を読み直します。残高横の更新アイコンも保存記録だけを読み、スマイルゼミへログインしません。M5Stack/Windows処理は変更なし。

2026-10-11: 手動調整を追加。「今日の学習」の同じ枠の「＋」から加算・減算・メモを登録し、日時付きの`+30分`などの履歴として残します。学習・PC付与の実記録は変更せず、今日・昨日の調整だけを残高に加算。取り消しは反対符号の履歴を残します。保護者の明示的な指定でパスワードなしのため、URLを知る人も調整可能です。

以下はそれぞれの実装時点の記録です。

2026-10-11: 「今日の学習」と「時間の残高」を1ページに統合。残高は日本時間の当日・前日2日分だけで計算し、過去の履歴は別タブに保持。今回は保護者の選択により、手動残高調整とパスワード設定は追加しません。

2026-10-11: 本番の更新ボタンはログインして最新学習を取得します。保護者の依頼で10分の待機・1日5回の上限は撤廃し、取得中の同時実行防止だけを維持します。Family Safetyとの独立連携は維持。[連携仕様・配備](FAMILY_SAFETY_README.md)と[現在の状態・検証・残作業](HANDOFF.md)を参照してください。以下の説明は元の学習取得機能の説明です。

合計学習時間・教科別の内訳・取得履歴を見られるWebサイトを追加しました。手動更新で下記の取得関数を呼び出します。スマートフォン対応、取得中の表示、失敗時の前回結果保持、10分間の連続更新抑止を備えています。

**[Webサイトの設定・起動方法](WEB_README.md)** ／ **[Web版の実行結果](WEB_VERIFICATION_REPORT.md)**

スマートフォンから開くための **[無料版のCloudflare公開手順](CLOUDFLARE_README.md)** を追加しました。Cloudflare Workersで表示し、GitHub ActionsのPython + Playwrightで日本時間15〜22時に取得します。有料Browser Rendering・Durable Objects・Cloudflareの認証情報は不要です。閲覧ログインは設けません。[無料版の検証結果](CLOUDFLARE_VERIFICATION_REPORT.md)を参照してください。

## Python取得処理の技術検証

Codex Cloud の Python + Playwright から、実サイトへの接続・ログイン・中学生コースの日別学習記録取得に成功しました。記録APIの待ち合わせを修正後、引数なしの統合CLIで162分を取得し、画面の合計・教科別表示を照合しました。ただし、約1分後の新規ブラウザでの再実行は401で拒否されました。毎回安定して再認証できる状態とは確認できていません。[検証レポート](VERIFICATION_REPORT.md)を参照してください。

以下は元のPython技術検証の説明です。追加依頼による無料公開版ではGitHub Actionsによる定期取得を追加しました。Family Safety連携は含みません。

## インストール

この環境は Python 3.12、Chromium `/usr/bin/chromium`、専用venvを準備済みです。

```bash
cd /workspace/yutagame
python3 -m venv /workspace/.venvs/yutagame
PIP_CACHE_DIR=/workspace/.cache/pip /workspace/.venvs/yutagame/bin/python -m pip install -r requirements.txt
/workspace/.venvs/yutagame/bin/python -m pip check
/workspace/.venvs/yutagame/bin/python -m unittest discover -s tests -v
```

別のLinux環境ではPython 3.10以上とChromiumが必要です。標準のブラウザ導入は `python -m playwright install --with-deps chromium`。別の実行ファイルを使う場合は `SMILE_ZEMI_CHROMIUM_PATH` に絶対パスを設定します。

## 認証情報の安全な設定

1. Codex Cloud環境設定の「シークレットを管理」で、`SMILE_ZEMI_LOGIN_ID` と `SMILE_ZEMI_PASSWORD` の値を設定します。
2. **両方のシークレットの送信先を `smile-zemi.jp` と `m.smile-zemi.jp` にします。** 各ドメイン欄で「完了」、管理画面で「保存」、外側の環境設定で保存・公開します。既存項目を編集し、同名項目を増やしません。
3. ネットワークでも両ホストへのHTTPS通信を許可します。

今回、両方の保存済み紐付けと送信先の公開反映を確認しました。値をチャット・コード・Git・コマンド引数に書く必要はありません。プロキシに置換用の値が注入される場合も、設定済み送信先への正規HTTPS要求で利用します。

値を表示せず設定の有無だけを確認するには:

```bash
/workspace/.venvs/yutagame/bin/python - <<'CHECK'
import os
for name in ('SMILE_ZEMI_LOGIN_ID', 'SMILE_ZEMI_PASSWORD'):
    print(name, 'set' if os.environ.get(name) else 'missing')
CHECK
```

未設定の場合、取得関数・通常CLIはブラウザを起動せず、不足した変数名を報告します。

## 実行

```bash
cd /workspace/yutagame
/workspace/.venvs/yutagame/bin/python smile_zemi.py
```

引数なしで実画面で確認した中学生コースの取得処理を使います。毎回、正規ログイン画面から1回だけ認証します。複数の子どもがいる場合は取り違えを防ぐため停止します。小学生・幼児・高校生コース、複数の子どもの選択は未対応です。

公開画面だけを検査する `--probe-login` は認証情報を使いません。`--probe-auth` はログインまでの検査であり、学習記録取得は行いません。取得前に認証probeを繰り返す必要はありません。

```bash
/workspace/.venvs/yutagame/bin/python smile_zemi.py --probe-login
# 認証だけを切り分ける必要がある場合に限る:
/workspace/.venvs/yutagame/bin/python smile_zemi.py --probe-auth
```

CAPTCHA・認証コード・多要素認証が必要なら `manual_authentication_required` で停止します。自動検出は完全ではありません。回避は行いません。401を含む認証失敗時の自動再試行もありません。サイトには一時的なログイン制限時に10分後の再試行を案内する文言がありますが、今回の401がその制限だったかは不明です。連続試行を避け、正規画面での状態確認と必要な手動対応を行ってください。

## 他の処理から呼び出す

```python
import asyncio
import json
from smile_zemi import fetch_today_learning_time

result = asyncio.run(fetch_today_learning_time())
print(json.dumps(result, ensure_ascii=False))
```

async環境では `await fetch_today_learning_time()`。成功時は取得結果のdict、失敗時は固定の診断コードを持つ `VerificationError` を返します。他のアプリから呼ぶ際も例外の内部原因や認証環境変数をログに保存しないでください。

## 取得方式と照合

正規画面が取得した `/api/chu/timeline/v2/daily-report/…` の応答から、年付き日付・合計・教科時間のみをメモリ内で取り出します。子どもの識別子を要求URLからコピーして直接APIを呼ぶ処理はありません。

記録APIの応答完了を待ち合わせてから抽出します。画面の枠の表示だけでデータ到着を判断しません。ログインPOSTは環境変数と送信内容が一致することを確認し、一致しない場合は送信前に停止します。

実画面は日付を `M/D(曜日)` で表示します。APIの年付き日付がJSTの今日であることを確認し、同じ月日・曜日のDOMカードを一意に特定します。合計と教科別時間はそのカードから取得し、APIと一致すること、教科合計が合計時間と一致すること、DOMの再読込で値が変わらないことを確認します。日付またぎ、重複、表示変更、未確認形式、当日記録なしは失敗です。当日記録がない場合に0分を補いません。

| 対象 | 実DOMで確認したセレクタ |
| --- | --- |
| メールアドレス | `input[type="email"][name="userId"]` |
| パスワード | `input[type="password"][name="password"]` |
| ログイン | `role=button[name="ログイン"]` |
| 日別記録画面 | `.dailyLogRoot__J7L4P` |
| 日別カード | `.dailyRoot__a754V` |
| 月日・曜日 | `.date__FKSSm` |
| 日別合計 | `.studyDateInner__s0Jtj > div:last-child` |
| 教科行 | `.subject__bWHro` |
| 教科名 | `.summary__raEvD .name__TRpmJ` |
| 教科時間の数値 | `.summary__raEvD .time__Pn3gb` |

CSSモジュール名はサイト更新で変わり得ます。固定座標やOCRは使いません。別の画面に適応するための `--selectors PATH` / `fetch_today_learning_time(selectors)` も残していますが、その設定は実画面で別途確認が必要です。カスタム設定の必須キーは `authenticated_marker`, `records_marker`, `record_scope`, `date`, `total`。ログイン3項目は既定値あり。任意キーは `records_link`, `subjects`, `subject_name`, `subject_minutes`, `manual_challenge`。カスタム日付要素は年付き形式が必要です。

## 実取得JSON

以下はサンプル値ではなく、2026-10-10に実ログインしたブラウザから取得し画面と照合した結果です。最新値として使う場合は再取得してください。

```json
{
  "date": "2026-10-10",
  "total_minutes": 162,
  "subjects": {
    "数学": 2,
    "国語": 83,
    "理科": 4,
    "社会": 73
  },
  "fetched_at": "2026-10-10T16:07:15+09:00"
}
```

同じ結果は [verification-results/today.json](verification-results/today.json)。`subjects` は取得できない場合 `null`、`fetched_at` は日本時間で `+09:00` 付きです。

## 通信・保存・終了コード

この環境の既存 `NODE_EXTRA_CA_CERTS` でTLSを検証するPlaywright `route.fetch` を使い、実HTTPS応答を `route.fulfill` でChromiumに渡します。証明書検証を無効化せず、OS/Chromiumの信頼ストアも変更しません。リダイレクトは一段ずつ評価します。圧縮された計測タグの本文はバイナリとして扱い、未確認ホストへのPOSTを止めます。

ブラウザは非永続コンテキストで、Cookie・セッショントークン・ID・パスワード・認証後HTML・スクリーンショット・HAR・動画・トレースをファイルやログに保存しません。CLIと通信コールバックは例外の生文字列を抑制します。学習記録の出力も必要な範囲で管理してください。

- `0`: 指定モードが成功。通常実行は実データJSON、probeはその段階の診断JSON。
- `2`: 通信・認証・画面移動・抽出の失敗、設定不足、手動操作が必要。
- `3`: 想定外エラー。詳細は抑制。

標準出力はJSONです。パイプ使用時は元の終了コードを保持してください。33件のテストは合成DOM・解析・通信制約の検査であり、実ログインの証拠とは区別します。
