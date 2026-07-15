# Receipt OCR Service

This service exposes the same OCR entry points used by Wari:

```text
GET  /health
POST /ocr
POST /api/ocr-receipt
```

`POST` accepts:

- `multipart/form-data` field `image` or `file`
- raw `image/*` request body
- JSON `{ "image_data_url": "data:image/..." }`
- JSON `{ "image_path": "/path/to/image" }` for local testing

## Oracle A1のPP-OCR経路

運用構成は`OCR_BACKEND=local`です。PP-OCRと規則処理を通常経路にし、利用者別訂正候補、文字訂正LLM、局所VLMは個別の環境変数で停止できます。詳細は`docs/receipt-ocr-feedback.md`を参照してください。

## Tesseract + Ollama backend

Use this backend on Oracle Cloud A1 or another VM where Tesseract and Ollama can run locally.

```bash
export OCR_BACKEND=tesseract_ollama
export OLLAMA_BASE_URL=http://127.0.0.1:11434
export OLLAMA_MODEL=qwen2.5:3b
export OLLAMA_TIMEOUT=25
export TESSERACT_LANG=jpn+eng
export TESSERACT_TIMEOUT=20
export RECEIPT_OCR_SHARED_SECRET='同じ秘密値をCloudflareにも登録'
python -m services.receipt_ocr.api
```

The API calls Ollama only through `127.0.0.1:11434`. Do not expose Ollama directly to the internet.
`POST /ocr` and `POST /api/ocr-receipt` require `Authorization: Bearer <RECEIPT_OCR_SHARED_SECRET>`. Keep the value identical to the Cloudflare Secret and do not print or commit it.

Required system packages:

```bash
sudo apt-get update
sudo apt-get install -y tesseract-ocr tesseract-ocr-jpn tesseract-ocr-eng
```

Useful runtime settings:

```text
TESSERACT_CMD=tesseract
TESSERACT_LANG=jpn+eng
TESSERACT_TIMEOUT=20
TESSERACT_PSM=6
TESSERACT_OEM=1
TESSERACT_MAX_SIDE=1800
TESSERACT_THRESHOLD=auto
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=qwen2.5:3b
OLLAMA_TIMEOUT=25
RECEIPT_OCR_SHARED_SECRET=<Cloudflareと同じ秘密値>
```

Environment check:

```bash
python -m services.receipt_ocr.check_env
python -m services.receipt_ocr.check_env --json
```

The command checks Python, Pillow, Tesseract, the configured `jpn` and `eng` languages, the local Ollama endpoint and model, temporary file cleanup, and the `/health` response shape. Exit status `0` means ready, `1` means one or more runtime requirements are unavailable, and `2` means the check itself could not run.

Expected result:

```json
{
  "tesseract": {
    "available": true,
    "configured_langs_available": true
  },
  "ollama": {
    "available": true
  }
}
```

## Response shape

The canonical response is:

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

For existing Wari compatibility, the service also includes:

```json
{
  "paid_at": null,
  "paid_time": null,
  "confidence": 0.0,
  "notes": ""
}
```

## Other backends

PaddleOCR local backend on Oracle A1:

```bash
pip install -r services/receipt_ocr/requirements-local.txt
export OCR_BACKEND=local
export OCR_HOST=127.0.0.1
export RECEIPT_OCR_SHARED_SECRET='Cloudflare と同じ秘密値'
python -m services.receipt_ocr.api
```

See `docs/receipt-ocr-local.md` for the rule parser, review fields, and A1 settings.

Gemini image OCR:

```bash
export OCR_BACKEND=gemini
export GEMINI_API_KEY=...
export GEMINI_OCR_MODEL=gemini-2.5-flash
python -m services.receipt_ocr.api
```

PaddleOCR local test backend:

```bash
pip install -r services/receipt_ocr/requirements-local.txt
export OCR_BACKEND=local
python -m services.receipt_ocr.api
```

## Deployment recommendation

For `tesseract_ollama`, prefer Oracle Cloud A1 or another VM. Render Free is suitable for the Gemini relay backend, but it is not a good target for Ollama model residency. Cloudflare Workers should remain an API edge/storage layer, not the OCR/Ollama execution host.

WariのA1運用ではPP-OCRローカル経路を使用し、Cloudflare Pages Functionsを認証、D1、候補集約の境界にします。本番D1移行とA1反映は`docs/receipt-ocr-feedback.md`の順序で行います。
