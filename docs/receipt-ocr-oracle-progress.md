# Wari Receipt OCR Oracle A1 Progress

## 目的

Wariのレシート読み取りを、Oracle Cloud A1上で動く `Tesseract + Ollama` 構成へ移す。

この構成では、レシート画像をPython APIが受け取り、Tesseractで文字列を抽出し、OllamaでWari用JSONへ整形する。Wari本体は読み取り結果をDBへ直接保存せず、画面上の候補として表示し、利用者が修正してから保存する。

## 到達点

### OCRサービス

`services/receipt_ocr/api.py` に `OCR_BACKEND=tesseract_ollama` を追加した。

利用できる入口は既存と同じ。

```text
GET  /health
POST /ocr
POST /api/ocr-receipt
```

`services/receipt_ocr/tesseract_ollama.py` を追加し、次の処理を行う。

```text
1. 画像を一時ファイルとして受ける
2. EXIF向き補正
3. グレースケール化
4. コントラスト調整
5. しきい値処理
6. Tesseractで全文OCR
7. TesseractでTSV OCR
8. TSVから行・単語・信頼度を抽出
9. OCR結果をOllamaへ渡す
10. Ollama返答からJSONを抽出
11. Python側で型、金額、日時、品目、警告を検査
12. Wari用の統一形式で返す
```

返却形式は以下。

```json
{
  "store_name": null,
  "purchased_at": null,
  "total_amount": null,
  "items": [
    {
      "name": null,
      "amount": null,
      "quantity": null,
      "confidence": null
    }
  ],
  "warnings": []
}
```

既存画面との互換用に、`paid_at`、`paid_time`、`confidence`、`notes` も返す。

### Ollamaへの指示

Ollamaには、日本のレシートOCR文字列からJSONを作るよう指示している。

入れている制約は次の通り。

```text
存在しない商品を推測で追加しない
読めない項目はnullにする
金額は数値にする
商品名と金額の対応が不明な場合はwarningsへ入れる
合計金額と明細合計が合わない場合はwarningsへ入れる
JSON以外の文章を返さない
```

Ollamaの返答がJSONとして壊れている場合は、Python側でJSON部分の抽出を試す。復元できない場合は、空の品目と警告を返す。

### Oracle A1配備物

Oracle A1用に以下を追加した。

```text
services/receipt_ocr/deploy/oracle-a1-setup.sh
services/receipt_ocr/deploy/wari-receipt-ocr.service
services/receipt_ocr/deploy/README.md
services/receipt_ocr/deploy/ORACLE_A1_ADD.md
services/receipt_ocr/.env.example
services/receipt_ocr/check_env.py
```

`oracle-a1-setup.sh` が扱う内容。

```text
python3
python3-venv
python3-pip
tesseract-ocr
tesseract-ocr-jpn
tesseract-ocr-eng
curl
Ollama
qwen2.5:3b
Python仮想環境
Pillow
```

`wari-receipt-ocr.service` は `systemd` 用の常駐設定。Ollamaは `http://127.0.0.1:11434` を使い、外部公開しない。

### Wari本体との接続

Wari画面は従来通り、相対パスの `/api/ocr-receipt` へ画像を送る。

```text
public/app.js
  -> POST /api/ocr-receipt
functions/api/[[path]].js
  -> Oracle A1上の receipt_ocr API
```

`functions/api/[[path]].js` に、Oracle OCRへ転送する経路を追加した。

Cloudflare Pages側で以下を設定すると、Wari画面からOracle A1上のOCRへ流れる。

```text
OCR_BACKEND=tesseract_ollama
RECEIPT_OCR_API_URL=https://<Oracle OCR APIの公開URL>
```

`RECEIPT_OCR_API_URL` には `/api/ocr-receipt` を含めない。

## Oracle A1で実行する手順

リポジトリを `/opt/wari` に置く。

```bash
cd /opt/wari/services/receipt_ocr
chmod +x deploy/oracle-a1-setup.sh
APP_DIR=/opt/wari/services/receipt_ocr OLLAMA_MODEL=qwen2.5:3b ./deploy/oracle-a1-setup.sh
```

常駐登録。

```bash
sudo cp /opt/wari/services/receipt_ocr/deploy/wari-receipt-ocr.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now wari-receipt-ocr
sudo systemctl status wari-receipt-ocr
```

健全性確認。

```bash
curl http://127.0.0.1:4190/health
```

期待する状態。

```text
tesseract.available=true
tesseract.configured_langs_available=true
ollama.available=true
```

画像読み取り確認。

```bash
curl -X POST \
  -F "image=@/path/to/receipt.jpg;type=image/jpeg" \
  http://127.0.0.1:4190/ocr
```

## 検査済み

手元環境で以下を確認した。

```text
Python構文検査: 成功
Cloudflare Functions JavaScript構文検査: 成功
```

手元のWindows環境にはTesseractとOllamaが入っていないため、実OCRはOracle A1配置後に確認する。

## 残作業

```text
Oracle A1へリポジトリ配置
Oracle A1でセットアップ実行
systemd登録
/health確認
実レシート画像で/ocr確認
Oracle OCR APIのHTTPS公開
Cloudflare Pages環境変数の設定
Wari画面から読み取り確認
OCR誤字補正表の追加
実レシートで前処理とOllama指示の調整
```

## 判断

Oracle A1へ追加するコードと配備手順は用意できている。次の作業は、Oracle A1へ実際に置いて実行結果を見る段階。
