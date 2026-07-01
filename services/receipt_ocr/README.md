# Receipt OCR service

Render Free では Gemini API へ画像を渡す中継サーバーとして使います。PaddleOCR はローカル実験用として同じ入口から切り替えられます。

## 起動

Gemini 中継として起動する場合:

```powershell
pip install -r services/receipt_ocr/requirements.txt
$env:OCR_BACKEND="gemini"
$env:GEMINI_API_KEY="..."
python -m services.receipt_ocr.api
```

PaddleOCR をローカルで試す場合:

```powershell
pip install -r services/receipt_ocr/requirements-local.txt
$env:OCR_BACKEND="local"
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
OCR_BACKEND=gemini
GEMINI_API_KEY=...
GEMINI_OCR_MODEL=gemini-2.5-flash
OCR_MAX_BODY_SIZE=10485760
OCR_CORS_ORIGIN=*
```

PaddleOCR 実験時の環境変数:

```text
OCR_BACKEND=local
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

Render Free では `OCR_BACKEND=gemini` を使います。PaddleOCR のモデル読み込みを Render 側で行わないため、起動時の負荷を抑えられます。

`GEMINI_API_KEY` は Render の環境変数として登録します。リポジトリには入れません。

## Render Free 用設定

ルートの `render.yaml` からこのディレクトリを `rootDir` として使います。

```yaml
rootDir: services/receipt_ocr
buildCommand: pip install -r requirements.txt
startCommand: python api.py
healthCheckPath: /health
```

RenderのWeb Serviceを手動作成する場合も、同じ値を設定してください。
