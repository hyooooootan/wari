# Oracle A1へ追加するもの

想定配置です。

```text
/opt/wari
/opt/wari/services/receipt_ocr
```

## 1. Oracle A1へ配置するリポジトリ

Wariのリポジトリ全体を `/opt/wari` に置きます。OCRサービスは `services/receipt_ocr` から起動しますが、Pythonのモジュール参照はリポジトリ直下を基準にしています。

追加対象の中心は以下です。

```text
services/receipt_ocr/api.py
services/receipt_ocr/tesseract_ollama.py
services/receipt_ocr/check_env.py
services/receipt_ocr/requirements.txt
services/receipt_ocr/.env.example
services/receipt_ocr/deploy/oracle-a1-setup.sh
services/receipt_ocr/deploy/wari-receipt-ocr.service
services/receipt_ocr/deploy/README.md
services/receipt_ocr/deploy/ORACLE_A1_ADD.md
functions/api/[[path]].js
```

`functions/api/[[path]].js` はWari画面から `/api/ocr-receipt` を呼んだとき、Cloudflare側からOracle OCRへ中継するために使います。

## 2. Oracle A1で入れるOS側のもの

セットアップ実行文です。

```bash
cd /opt/wari/services/receipt_ocr
chmod +x deploy/oracle-a1-setup.sh
APP_DIR=/opt/wari/services/receipt_ocr OLLAMA_MODEL=qwen2.5:3b ./deploy/oracle-a1-setup.sh
```

この実行で入るものです。

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

## 3. Oracle A1で常駐させるもの

```bash
sudo cp /opt/wari/services/receipt_ocr/deploy/wari-receipt-ocr.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now wari-receipt-ocr
sudo systemctl status wari-receipt-ocr
```

常駐時の主要設定です。

```text
OCR_BACKEND=tesseract_ollama
OCR_HOST=0.0.0.0
PORT=4190
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=qwen2.5:3b
TESSERACT_LANG=jpn+eng
```

Ollamaは外部へ公開しません。外部から呼ぶ対象はPython OCR APIです。

## 4. Oracle A1で確認すること

```bash
curl http://127.0.0.1:4190/health
```

見る値です。

```text
tesseract.available=true
tesseract.configured_langs_available=true
ollama.available=true
```

画像確認です。

```bash
curl -X POST \
  -F "image=@/path/to/receipt.jpg;type=image/jpeg" \
  http://127.0.0.1:4190/ocr
```

返却形です。

```json
{
  "store_name": null,
  "purchased_at": null,
  "total_amount": null,
  "items": [],
  "warnings": []
}
```

## 5. Cloudflare側へ追加する環境変数

Wari画面をCloudflare Pagesで動かす場合、Pages Functionsへ以下を設定します。

```text
OCR_BACKEND=tesseract_ollama
RECEIPT_OCR_API_URL=https://<Oracle OCR APIの公開URL>
```

`RECEIPT_OCR_API_URL` は `/api/ocr-receipt` を含めず、基点URLを入れます。

例です。

```text
RECEIPT_OCR_API_URL=https://ocr.example.com
```

この設定にすると、Wari画面の `/api/ocr-receipt` はCloudflare関数を経由し、Oracle A1上の `services/receipt_ocr/api.py` へ転送されます。

## 6. 公開方法

推奨順です。

```text
Cloudflare Tunnel
CaddyまたはnginxのHTTPS中継
Oracleの固定IP + 4190番の限定公開
```

Ollamaの `11434` 番は開けません。

## 7. 作業完了の判定

以下が通れば、WariからOracle OCRを使える状態です。

```bash
curl https://<Oracle OCR APIの公開URL>/health
curl -X POST -H "content-type: application/json" \
  --data '{"image_path":"/opt/wari/test-receipt.jpg"}' \
  http://127.0.0.1:4190/ocr
```

Cloudflare側は、Wari画面からレシート画像を選び、店名・合計・品目候補が確認欄へ入ることを見ます。
