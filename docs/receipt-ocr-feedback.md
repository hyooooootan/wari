# レシートOCRの訂正学習と補助読取

## 構成

通常経路はOracle A1上のPP-OCR、画像前処理、規則処理です。補助処理が停止していても通常経路は動作します。

```text
ブラウザ
  -> Cloudflare Pages Functions
  -> D1からログイン利用者の集約済み訂正候補を取得
  -> 画像と32KiB以下の候補をOracle OCRへ送信
  -> PP-OCRと規則処理
  -> 必要な場合に店名訂正、文字訂正LLM、局所VLM
  -> 確認画面
  -> 取引保存成功後に訂正結果をD1へ登録
```

匿名の共有トークンによるOCRには利用者別候補と訂正登録用トークンを付けません。OracleからD1へ接続せず、D1を訂正履歴の正本にします。

## OCR応答と根拠

優先項目は`store_name`、`total_amount`、`paid_at`、`paid_time`です。応答には既存項目に加えて次を含めます。

- `ocr_result_id`: 無作為な結果識別子。画像を取得できる識別子ではありません。
- `field_evidence`: 根拠行、0から1の正規化座標、信頼度、前処理方式、候補種別、採用理由。
- `total_candidates`: 合計、小計、税、預り、釣銭などを区別した金額候補。
- `field_sources`: PP-OCR、過去訂正、文字訂正LLM、VLM一致などの採用元。
- `fallbacks`: 補助処理の利用有無、呼出回数、局所領域。
- `processing_time_ms`: OCRサービス内の処理時間。

画像全体、切出し画像、Base64、OCR全文は応答後にサーバーへ残しません。一時ファイルは処理終了時に削除します。

## D1移行

移行ファイルは`db/migrations/0010_receipt_ocr_feedback.sql`と`db/migrations/0011_receipt_ocr_feedback_pending.sql`です。

`receipt_ocr_correction_events`は変更があった項目を保持します。`receipt_ocr_field_outcomes`は変更されなかった項目を含む確認結果を保持し、前処理方式とOCRモデルの成績を集計します。両表の一意条件は`user_id + ocr_result_id + field_name + source_id`です。同じ確認を再送しても件数は増えません。

`receipt_ocr_feedback_pending`は、取引保存後に訂正履歴の登録が失敗した場合に、署名検証済みの元値と確定値を再処理するため保持します。取込行、利用者、企画、取引、OCR結果を結び付け、再処理成功時または本人による履歴削除時に消去します。HMAC鍵、署名、画像、Base64、OCR全文は保持しません。

保存する情報:

- 利用者ID、保存済み取引ID、OCR結果識別子
- 項目名と項目内の情報源識別子
- OCRの元値と利用者の確定値
- 比較用の正規化値
- OCRモデル、前処理方式、信頼度
- 項目の根拠文字列と正規化座標
- 作成日時

保存しない情報:

- レシート画像、切出し画像、Base64
- OCR全文
- SSH鍵、OCI鍵、共有秘密値、API鍵
- Oracle側の利用者別ファイル
- メール本文、住所、電話番号の独立した記録

元のOCR値が空で利用者が補った場合は、空の元値と確定値を成績記録へ残します。確定値の空文字列は拒否します。空の元値は店名辞書の自動採用には使いません。

本番D1へこの作業から移行は適用しません。ローカル確認は次の順です。

```powershell
npm.cmd run db:migrate:local
npm.cmd test
```

本番反映時は、D1の退避とTime Travelの位置を記録し、移行を適用して表・索引・トリガーを確認してからPagesコードを反映します。既存表を削除する移行ではないため、障害時に新しい表を削除せず、機能設定を停止します。

## 訂正履歴API

```text
POST   /api/ocr-corrections  訂正と確認結果を登録
GET    /api/ocr-corrections  本人の訂正件数を取得
DELETE /api/ocr-corrections  本人の訂正と確認結果を全削除
```

ログイン、CSRF、同一生成元、企画の編集権限を既存認証経路で検査します。OCR応答には24時間有効のHMAC-SHA-256署名付き`feedback_token`を付けます。署名は利用者、企画、OCR結果、元値、根拠、モデルを結び付けます。画面から送られた元値を信用せず、サーバーが署名済み元値と利用者の確定値を比較します。

`feedback_token`はD1、端末の永続状態、Oracleへ保存しません。確認画面を開いている間の一時記憶に保持し、OCR結果識別子で取込行へ結び付けます。画面を再読込して署名情報が失われた場合は訂正欄を表示せず、OCR値のまま取引へ進めます。`OCR_FEEDBACK_TOKEN_KEY_V1`が未設定の場合も同じです。

取引の新規作成または既存取引への紐付けでは、同じ署名をサーバーで検証してから、店名、合計、日付、時刻、明細の確定値を取込行へ反映します。店名、合計、日付は保存先の取引にも反映し、取込行、取引、訂正履歴の食い違いを防ぎます。取引確定用の署名は学習履歴の書込設定と分離して発行するため、`RECEIPT_OCR_ENABLE_FEEDBACK_WRITE=false`でも画面の訂正値は取引へ保存されます。書込が有効な場合は、取引保存と未送信訂正の作成を同じD1処理へ含めます。照合APIの内部で取引保存と家計簿同期が成功した後に訂正履歴を登録し、一時的な登録失敗はサーバーで1回再試行します。取引保存に失敗した場合は履歴登録へ進みません。再試行後も失敗した場合は保存済み取引と未送信訂正を維持して`ocr_feedback.status=failed`を返し、画面から未送信訂正の再処理を1回要求します。再処理にも失敗した場合は「取引は保存されましたが、OCR修正履歴の保存に失敗しました」と表示し、D1の未送信訂正を後から再処理できます。

`OCR_FEEDBACK_TOKEN_KEY_V1`は32文字以上の独立した秘密値とし、OCR共有秘密値やGmail暗号鍵を流用しません。値をGit、記録、画面へ出しません。

## Oracleへ渡す訂正候補

Pages Functionsが本人のD1行を集約し、次の範囲でOracleへ渡します。

- 店名訂正候補: 20件
- 文字の誤認識傾向: 30件
- 前処理成績: 全体30行、各集計は確認5件以上
- JSON: UTF-8で32KiB以下

利用者ID、企画ID、取引ID、金額と日時の過去値、根拠文字列、画像、OCR全文、署名トークンはOracleへ渡しません。取得失敗、形式不正、容量超過時は候補なしで通常OCRを続けます。

## 店名候補の採用

店名はNFKC、前後空白、連続空白、英字の大文字小文字、ハイフン類を比較用に揃えます。日本語の長音記号は残します。

自動採用には全条件を使います。

- 正規化後のOCR元値が過去の元値と完全一致
- 同じ`original -> corrected`が2回以上
- 訂正後候補が一つ
- 店名信頼度が0.60以上
- 元値と訂正値に含まれる数字が同じ

近い文字列、1回の訂正、低い信頼度、別支店、競合候補は候補一覧へ追加し、`needs_review=true`を維持します。利用者ごとに集約するため、他の利用者の訂正は混ざりません。

文字の誤認識傾向は項目名、OCRモデル、前処理方式、信頼度帯、文字種、前後文字とともに集計し、候補順位、別前処理、LLM説明、VLM発動の判断に使います。一括置換辞書として使いません。数字の誤認識傾向は、同じ誤認識が2回以上あり、合計の根拠行に該当文字が含まれ、合計信頼度が0.95未満の場合に局所再読取を要求できますが、値の直接置換には使いません。

## 前処理成績

`field_name + ocr_model + preprocessing`ごとに確認件数、正答件数、訂正件数を集計します。確認5件未満、別モデル版、利用者データなしの場合は従来の固定順序を維持します。十分な件数がある場合も、安全な既定前処理を削除せず、成績のよい方式を先に試します。

## 文字訂正LLM

`qwen2.5:1.5b-instruct`は店名の軽微な文字訂正候補に使います。Ollama公式登録ではQ4_K_Mが986MBです。入力は現在の店名、情報源識別子、類似する過去例5件、店名項目の文字混同30件以内です。合計、日付、時刻、商品明細、他項目の文字混同は送りません。

次を検査してから候補へ反映します。

- 情報源識別子と元文字列が入力と一致
- 200文字以内
- 数字列が変わらない
- 過去の確定候補に含まれる、または空白・ハイフン正規化後に元文字列と同一
- JSONとして解釈できる

金額、日付、時刻、数量、座標、OCR信頼度はLLMに変更させません。壊れたJSON、時間切れ、Ollama停止時は通常OCR結果を返します。LLM候補を採用しても`needs_review`を解除しません。

## 局所VLM

候補モデルは`qwen3-vl:2b`です。Ollama公式登録ではQ4_K_Mが1.9GBで、Ollama 0.12.7以上が必要です。A1で速度とメモリを実測するまで有効にしません。

VLMへ送る画像は店名、合計、日時の局所領域です。PP-OCRの前処理画像上の座標を元画像上へ戻し、余白を付け、最大1024画素へ縮小します。候補行がない場合は上部30%、下部40%、上部から中央の既定領域を使います。一時画像は要求後に削除します。

合計はPP-OCRの既存候補に一致する値しか候補へ追加しません。VLM単独の金額を確定しません。ポイント、残高、会員番号、単価、電話番号、登録番号、伝票番号、レシート番号を含む行は合計候補から除外します。日付は実在日と未来日を検査し、有効期限、賞味期限、消費期限、使用期限などの行を購入日から除外します。時刻は0時から23時・0分から59分を処理側で検査します。VLMは最大3領域、1並列、全補助処理を含むOCRサービスの処理予算は55秒です。欠落または規則不一致の領域を先にし、過去の数字混同による追加の合計再読取は後にします。数字混同の前処理方式、信頼度帯、前後文字が現在の根拠と一致しない場合は追加読取を要求しません。

## `needs_review`

店名、正整数の合計、実在する日付、正しい時刻の4項目がすべてあり、合計ラベルに加えて小計・税・値引き・品目合計などの独立した計算根拠があり、金額と日時が規則で検査され、重大な候補矛盾がなく、4項目の平均信頼度が基準を満たす場合に確認解除を検討します。合計の独立根拠がない場合は`needs_review=true`を維持します。小計と商品明細は平均信頼度へ含めません。規則処理版は`receipt-rules-3`です。

過去の金額・日時訂正、LLM単独値、VLM単独値、競合店名候補、重大な警告がある場合は確認解除しません。速さを理由に不明な値を確定しません。

## 環境変数

Pages Functions:

```text
RECEIPT_OCR_ENABLE_FEEDBACK_READ=false
RECEIPT_OCR_ENABLE_FEEDBACK_WRITE=false
OCR_FEEDBACK_TOKEN_KEY_V1=<独立した秘密値>
```

ブラウザはA1へ直接接続せず、Pages FunctionsがHTTPSでA1へ接続します。A1側の`OCR_CORS_ORIGIN`は通常は空欄にし、異なる接続元からのブラウザ呼出しを許可しません。Pages側の`RECEIPT_OCR_API_URL`は本番では`https://`を使用し、暗号化されていない`http://`はループバック開発時に限り受け付けます。

Oracle OCR:

```text
RECEIPT_OCR_ENABLE_FEEDBACK=false
RECEIPT_OCR_ENABLE_TEXT_CORRECTION=false
RECEIPT_OCR_ENABLE_VISION_REREAD=false
RECEIPT_OCR_TEXT_MODEL=qwen2.5:1.5b-instruct
RECEIPT_OCR_VISION_MODEL=qwen3-vl:2b
RECEIPT_OCR_TEXT_TIMEOUT=10
RECEIPT_OCR_VISION_TIMEOUT=45
RECEIPT_OCR_TOTAL_TIMEOUT=55
RECEIPT_OCR_MAX_LLM_CALLS=1
RECEIPT_OCR_MAX_VISION_CALLS=3
RECEIPT_OCR_FEEDBACK_MAX_EXAMPLES=5
RECEIPT_OCR_VISION_MAX_SIDE=1024
RECEIPT_OCR_OLLAMA_KEEP_ALIVE=5m
OCR_MAX_CONCURRENCY=1
OLLAMA_URL=http://127.0.0.1:11434
```

三つの`RECEIPT_OCR_ENABLE_*`を`false`にすると、補助処理を停止してPP-OCRと規則処理へ戻せます。

## A1配備と復旧

反映前にCPU、メモリ、ディスク、待受ポート、サービス、環境変数名、Ollama版とモデル一覧を確認します。環境ファイルの値は出力しません。`/opt/wari`と`/etc/wari/receipt-ocr.env`はアクセス制限された日時付き退避先へ保存します。

Ollamaは公式のARM64パッケージを使い、`127.0.0.1:11434`へ限定します。既存モデルを削除せず、ディスクとメモリ確認後に次を取得します。

OCR処理は`OLLAMA_URL`と`OLLAMA_BASE_URL`を解析し、`localhost`、`127.0.0.1`、`::1`以外の接続先、利用者情報を含むURL、HTTPまたはHTTPS以外の方式を拒否します。

```bash
ollama pull qwen2.5:1.5b-instruct
ollama pull qwen3-vl:2b
```

反映後は構文検査、OCR試験、`systemctl daemon-reload`、再起動、`/health`、認証なし401、認証付きOCR、待受ポート、直近エラー、OOMと再起動回数を確認します。Oracleの受信規則とOS防火壁は変更しません。

障害時はOracleの三機能を停止し、Pagesの読取・書込を停止します。通常OCRを確認してから、必要な場合に退避したコードとsystemd設定へ戻します。0010から0012の表とトリガーは削除せず、後続移行で修復します。

## 実画像評価

`services/receipt_ocr/benchmark.py`は画像と正解値をリポジトリ外の一覧から読みます。出力は項目ごとの正答数、`needs_review`、誤った自動確定数、平均、p50、p95、最大時間、LLM・VLM呼出回数、最大RSSです。画像、店名、金額、日時、OCR全文は出力しません。

一覧例:

```json
{
  "images": [
    {
      "path": "/home/ubuntu/receipt-samples/example.jpg",
      "expected": {
        "store_name": "正解店名",
        "total_amount": 1234,
        "paid_at": "2026-07-11",
        "paid_time": "13:16"
      },
      "feedback": {
        "version": 1,
        "store_corrections": [],
        "character_confusions": [],
        "preprocessing_stats": []
      }
    }
  ]
}
```

```bash
python -m services.receipt_ocr.benchmark \
  --manifest /home/ubuntu/private/receipt-ground-truth.json \
  --modes A,B,C,D --repeat 3 --concurrency 1 \
  --output /home/ubuntu/private/receipt-benchmark.json
```

同時要求は`--concurrency 2`でも確認します。OCRとVLMはアプリケーション内で1並列に制限されます。

## 現在の測定状態

基点版の既存A1測定では2 OCPU、約12GB、`IMG_1243.jpg`の通常経路が約11.8秒から12.4秒でした。優先4項目のうち合計5382、日付2026-07-11、時刻13:16は正答し、店名は1文字誤り、`needs_review=true`でした。

2026年7月15日にコミット`08836b4`をA1へ反映しました。A1は2 OCPU、約11 GiBのメモリー、48 GiBのルートディスクで、反映後の空きは約35 GiBです。反映前のコード、systemd設定、環境設定は日時付きの非公開領域へ退避し、書庫の検査値を照合しました。

A1上のPython試験55件、構文検査、OCRモジュールの読込みは成功しました。`wari-receipt-ocr`は`127.0.0.1:4190`、Ollamaは`127.0.0.1:11434`で稼働しています。`/health`は200、認証なしOCRは401、認証付きOCRは200でした。認証付き実画像1枚は約16.9秒、`needs_review=true`、処理時の最大RSSは約751 MiBでした。サービスの再起動回数は0で、OOMの記録はありません。

Ollama 0.32.0へ`qwen2.5:1.5b-instruct`と`qwen3-vl:2b`を取得しました。非公開画像12枚を対象に、AからDを各3回、同時実行数1で測定しました。画像、正解値、OCR全文、結果JSONはリポジトリへ保存しません。

| 条件 | 店名 | 合計 | 日付 | 時刻 | 確認要求 | 誤確定 | 平均 | p50 | p95 | 最大 | 文字LLM | 局所VLM | 最大RSS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| A | 3/36 | 12/36 | 18/36 | 18/36 | 36/36 | 0 | 10.9秒 | 11.0秒 | 16.6秒 | 16.6秒 | 0 | 0 | 845.0 MiB |
| B | 9/36 | 12/36 | 18/36 | 18/36 | 36/36 | 0 | 10.8秒 | 11.0秒 | 16.6秒 | 16.9秒 | 0 | 0 | 845.0 MiB |
| C | 9/36 | 12/36 | 18/36 | 18/36 | 36/36 | 0 | 13.9秒 | 14.7秒 | 18.7秒 | 19.1秒 | 30 | 0 | 845.0 MiB |
| D | 9/36 | 12/36 | 18/36 | 18/36 | 36/36 | 0 | 54.4秒 | 55.2秒 | 55.3秒 | 55.3秒 | 30 | 38 | 845.9 MiB |

Bは店名の正答数を3件から9件へ増やし、処理時間はAと同程度でした。Cは今回の画像群で正答数を増やさず、平均時間が約3.1秒増えました。Dも正答数を増やさず、平均54.4秒でした。全条件で`needs_review=true`が維持され、誤った自動確定は0件です。現在の測定結果ではBを採用候補とし、CとDは無効の状態を維持します。

モデル情報:

- `qwen2.5:1.5b-instruct`: https://ollama.com/library/qwen2.5:1.5b-instruct
- `qwen3-vl:2b`: https://ollama.com/library/qwen3-vl:2b
- Ollama Linux ARM64: https://docs.ollama.com/linux
