# Oracle A1 のレシート OCR

Oracle A1 では `OCR_BACKEND=local` を使います。PaddleOCR が文字列と位置情報を出し、`services/receipt_ocr/receipt_rules.py` が金額、日付、品目候補を判定します。Ollama はこの構成で起動しません。

HEIC/HEIF は `pillow-heif` で開きます。ブラウザから送る元画像、A1 側の画像データ URL、画像本体の各経路で同じ形式を扱えます。

EXIF 回転、横向き写真の向き補正、紙面四隅の射影補正、コントラスト調整、局所コントラスト補正、適応的二値化を使います。紙の折れ目で隠れた文字は復元せず、確認表示に回します。

## 実行環境

`scripts/oracle_a1_bootstrap_wari_ocr.sh` は Ubuntu または Oracle Linux で Python 仮想環境、PP-OCR の ONNX モデル実行環境、Pillow を準備し、`wari-receipt-ocr` を登録します。サービスは `127.0.0.1:4190` で待ち受けます。外部公開には Cloudflare Tunnel を使い、Oracle の受信規則で 4190 番を公開しません。

Cloudflare Pages Functions と A1 の双方に同じ `RECEIPT_OCR_SHARED_SECRET` を設定します。秘密値、OCI API 鍵、SSH 秘密鍵をリポジトリや出力へ入れません。

Oracle A1 では `/etc/wari/receipt-ocr.env` に次を設定し、`sudo systemctl restart wari-receipt-ocr` を実行します。

```text
RECEIPT_OCR_SHARED_SECRET=<Cloudflare と同じ秘密値>
```

## 判定内容

- `total`、`subtotal`、`tax`、`discount`、`deposit`、`change`、`unknown` の金額候補を記録します。
- 合計ラベル、OCR 信頼度、預り金と釣銭、小計・税・値引、品目合計を使って候補を採点します。
- 令和表記を西暦へ換算し、成立しない日付は返しません。
- 同じ名称の品目も、別の印字行であれば残します。
- 不一致、低い信頼度、補正した金額候補は `warnings` と `needs_review` で返します。画面では自動登録せず、利用者が確認します。

`OCR_DEBUG_OUTPUT=true` のときは `ocr_lines` と `amount_candidates` も API 応答へ含めます。実画像や認識行には購入情報が含まれるため、通常運用では有効にしません。

## 調整値

```text
LOCAL_OCR_MAX_SIDE=1600
LOCAL_OCR_DET_LIMIT=1280
LOCAL_OCR_BATCH_SIZE=4
LOCAL_OCR_MAX_ATTEMPTS=3
RECEIPT_OCR_REVIEW_THRESHOLD=0.68
RECEIPT_OCR_AMOUNT_TOLERANCE=1
```

再試行は初回結果で合計が取れない、または確認表示になった場合に限り、合計欄の画像帯域、局所コントラスト補正、適応的二値化を順に試します。連続的な OCR 実行は行いません。

## 確認

```bash
sudo systemctl status wari-receipt-ocr
curl http://127.0.0.1:4190/health
```

実画像の試験では、正解の店名、合計、日付、品目数を別表で記録し、各画像の `needs_review` と `warnings` も確認します。画像自体と API 応答は個人情報を含むため、公開リポジトリへ追加しません。
