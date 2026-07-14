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

## Tesseract + Ollama backend

Use this backend on Oracle Cloud A1 or another VM where Tesseract and Ollama can run locally.

```bash
export OCR_BACKEND=tesseract_ollama
export OLLAMA_BASE_URL=http://127.0.0.1:11434
export OLLAMA_MODEL=qwen2.5:3b
export TESSERACT_LANG=jpn+eng
python -m services.receipt_ocr.api
```

The API calls Ollama only through `127.0.0.1:11434`. Do not expose Ollama directly to the internet.

Required system packages:

```bash
sudo apt-get update
sudo apt-get install -y tesseract-ocr tesseract-ocr-jpn tesseract-ocr-eng
```

Useful runtime settings:

```text
TESSERACT_CMD=tesseract
TESSERACT_LANG=jpn+eng
TESSERACT_TIMEOUT=30
TESSERACT_PSM=6
TESSERACT_OEM=1
TESSERACT_MAX_SIDE=1800
TESSERACT_THRESHOLD=auto
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=qwen2.5:3b
OLLAMA_TIMEOUT=20
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
