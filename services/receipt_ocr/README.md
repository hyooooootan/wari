# Receipt OCR service

OpenAI APIを使わず、PaddleOCRでレシート画像から店名・合計金額・日付を推測する実験用サービスです。

## 起動

リポジトリのルートから起動する場合:

```powershell
pip install -r services/receipt_ocr/requirements.txt
python -m services.receipt_ocr.api
```

`services/receipt_ocr` をカレントディレクトリにして起動する場合:

```powershell
pip install -r requirements.txt
python api.py
```

環境変数:

```text
PORT=4190
OCR_HOST=0.0.0.0
OCR_MAX_BODY_SIZE=10485760
OCR_CORS_ORIGIN=*
LOCAL_OCR_MAX_SIDE=720
LOCAL_OCR_DET_LIMIT=480
LOCAL_OCR_DET_MODEL=PP-OCRv6_tiny_det
LOCAL_OCR_REC_MODEL=PP-OCRv6_small_rec
```

## エンドポイント

```text
GET  /health
POST /ocr
POST /api/ocr-receipt
```

`POST` は以下の形式を受け取れます。

- `multipart/form-data` の `image` または `file`
- `image/*` の生バイナリ
- JSON `{ "image_data_url": "data:image/..." }`
- JSON `{ "image_path": "C:/..." }`（ローカル検証用）

## 注意

Render Freeではスリープ復帰時にモデル読み込みが走るため、初回レスポンスがかなり遅くなる可能性があります。まずはローカルで精度と起動時間を確認してからデプロイしてください。

## Render Free 用設定

ルートの `render.yaml` からこのディレクトリを `rootDir` として使います。

```yaml
rootDir: services/receipt_ocr
buildCommand: pip install -r requirements.txt
startCommand: python api.py
healthCheckPath: /health
```

RenderのWeb Serviceを手動作成する場合も、同じ値を設定してください。
