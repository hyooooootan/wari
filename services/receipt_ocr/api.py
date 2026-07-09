import base64
import json
import os
import re
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse


HOST = os.environ.get("OCR_HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", os.environ.get("OCR_PORT", "4190")))
MAX_BODY_SIZE = int(os.environ.get("OCR_MAX_BODY_SIZE", str(10 * 1024 * 1024)))
OCR_BACKEND = os.environ.get("OCR_BACKEND", "gemini").lower()
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY")
GEMINI_OCR_MODEL = os.environ.get("GEMINI_OCR_MODEL", "gemini-2.5-flash")


class ReceiptOcrHandler(BaseHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", os.environ.get("OCR_CORS_ORIGIN", "*"))
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "content-type")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/health":
            payload = {"ok": True, "service": "receipt-ocr", "backend": OCR_BACKEND}
            if use_tesseract_ollama_backend():
                try:
                    from services.receipt_ocr.tesseract_ollama import health as tesseract_ollama_health
                except ImportError:
                    from tesseract_ollama import health as tesseract_ollama_health
                payload["tesseract_ollama"] = tesseract_ollama_health()
            self.send_json(200, payload)
            return
        if path == "/":
            self.send_json(
                200,
                {
                    "service": "receipt-ocr",
                    "backend": OCR_BACKEND,
                    "endpoints": {
                        "POST /ocr": "multipart image, raw image body, or JSON image_path/image_data_url",
                        "GET /health": "health check",
                    },
                },
            )
            return
        self.send_json(404, {"error": "not_found"})

    def do_POST(self):
        path = urlparse(self.path).path
        if path not in ("/ocr", "/api/ocr-receipt"):
            self.send_json(404, {"error": "not_found"})
            return

        try:
            result = self.read_ocr_request()
            result.pop("ocr_lines", None)
            self.send_json(200, result)
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            self.send_json(502, {"error": "ocr_provider_error", "message": detail[:1000]})
        except Exception as exc:
            self.send_json(400, {"error": "ocr_failed", "message": str(exc)})

    def read_ocr_request(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0:
            raise ValueError("empty request body")
        if length > MAX_BODY_SIZE:
            raise ValueError("image is too large")

        content_type = self.headers.get("Content-Type", "")
        body = self.rfile.read(length)

        if content_type.startswith("application/json"):
            payload = json.loads(body.decode("utf-8"))
            if payload.get("image_data_url"):
                return read_receipt_from_data_url(payload["image_data_url"])
            if payload.get("image_path"):
                return read_receipt_from_path(Path(payload["image_path"]))
            raise ValueError("JSON must include image_path or image_data_url")

        if content_type.startswith("multipart/form-data"):
            image_bytes, media_type, suffix = parse_multipart_image(body, content_type)
            if use_gemini_backend():
                return read_receipt_from_data_url(to_data_url_from_bytes(image_bytes, media_type))
            return read_temp_image(image_bytes, suffix)

        if content_type.startswith("image/") or content_type == "application/octet-stream":
            suffix = suffix_from_content_type(content_type)
            if use_gemini_backend():
                return read_receipt_from_data_url(to_data_url_from_bytes(body, content_type))
            return read_temp_image(body, suffix)

        raise ValueError(f"unsupported content type: {content_type}")

    def send_json(self, status, payload):
        data = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def parse_multipart_image(body, content_type):
    match = re.search(r"boundary=(?P<boundary>[^;]+)", content_type)
    if not match:
        raise ValueError("multipart boundary is missing")

    boundary = match.group("boundary").strip('"').encode("utf-8")
    marker = b"--" + boundary
    for part in body.split(marker):
        part = part.strip(b"\r\n")
        if not part or part == b"--":
            continue
        header_blob, sep, content = part.partition(b"\r\n\r\n")
        if not sep:
            continue
        headers = header_blob.decode("utf-8", errors="replace")
        if 'name="image"' not in headers and 'name="file"' not in headers:
            continue
        content = content.rstrip(b"\r\n")
        suffix = suffix_from_headers(headers)
        media_type = media_type_from_headers(headers)
        return content, media_type, suffix

    raise ValueError("multipart field named image or file is required")


def media_type_from_headers(headers):
    type_match = re.search(r"Content-Type:\s*([^\r\n;]+)", headers, re.I)
    if type_match:
        return type_match.group(1).strip()
    return "image/jpeg"


def suffix_from_headers(headers):
    filename_match = re.search(r'filename="[^"]+\.([A-Za-z0-9]+)"', headers)
    if filename_match:
        ext = filename_match.group(1).lower()
        if ext == "jpeg":
            ext = "jpg"
        return f".{ext}"

    type_match = re.search(r"Content-Type:\s*([^\r\n;]+)", headers, re.I)
    if type_match:
        return suffix_from_content_type(type_match.group(1).strip())
    return ".img"


def suffix_from_content_type(content_type):
    media_type = content_type.split(";", 1)[0].lower()
    mapping = {
        "image/jpeg": ".jpg",
        "image/jpg": ".jpg",
        "image/png": ".png",
        "image/webp": ".webp",
        "image/avif": ".avif",
        "image/bmp": ".bmp",
        "image/tiff": ".tiff",
        "application/octet-stream": ".img",
    }
    return mapping.get(media_type, ".img")


def read_temp_image(image_bytes, suffix):
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        tmp.write(image_bytes)
        path = Path(tmp.name)
    try:
        return read_receipt_from_path(path)
    finally:
        try:
            path.unlink(missing_ok=True)
        except OSError:
            pass


def read_receipt_from_data_url(image_data_url):
    if use_tesseract_ollama_backend():
        return read_receipt_from_data_url_tesseract_ollama(image_data_url)
    if use_gemini_backend():
        return read_receipt_with_gemini(image_data_url)
    if OCR_BACKEND not in ("local", "auto"):
        raise RuntimeError("OCR_BACKEND must be gemini, local, tesseract_ollama, or auto.")
    return read_receipt_from_data_url_local(image_data_url)


def read_receipt_from_path(path):
    if use_tesseract_ollama_backend():
        return read_receipt_from_path_tesseract_ollama(path)
    if use_gemini_backend():
        return read_receipt_with_gemini(to_data_url(path))
    if OCR_BACKEND not in ("local", "auto"):
        raise RuntimeError("OCR_BACKEND must be gemini, local, tesseract_ollama, or auto.")
    return read_receipt_from_path_local(path)


def use_gemini_backend():
    if OCR_BACKEND == "gemini":
        return True
    if OCR_BACKEND == "auto" and GEMINI_API_KEY:
        return True
    return False


def use_tesseract_ollama_backend():
    return OCR_BACKEND == "tesseract_ollama"


def read_receipt_from_data_url_tesseract_ollama(image_data_url):
    try:
        from services.receipt_ocr.tesseract_ollama import read_receipt_from_data_url as read_ocr
    except ImportError:
        from tesseract_ollama import read_receipt_from_data_url as read_ocr
    return read_ocr(image_data_url)


def read_receipt_from_path_tesseract_ollama(path):
    try:
        from services.receipt_ocr.tesseract_ollama import read_receipt_from_path as read_ocr
    except ImportError:
        from tesseract_ollama import read_receipt_from_path as read_ocr
    return read_ocr(path)


def read_receipt_from_data_url_local(image_data_url):
    try:
        from services.receipt_ocr.core import read_receipt_from_data_url as read_local
    except ImportError:
        from core import read_receipt_from_data_url as read_local
    return read_local(image_data_url)


def read_receipt_from_path_local(path):
    try:
        from services.receipt_ocr.core import read_receipt_from_path as read_local
    except ImportError:
        from core import read_receipt_from_path as read_local
    return read_local(path)


def read_receipt_with_gemini(image_data_url):
    if not GEMINI_API_KEY:
        raise RuntimeError("GEMINI_API_KEY is not set")
    mime_type, base64_data = split_data_url(image_data_url)
    request_payload = {
        "contents": [
            {
                "parts": [
                    {"text": receipt_prompt()},
                    {"inlineData": {"mimeType": mime_type, "data": base64_data}},
                ]
            }
        ],
        "generationConfig": {
            "responseMimeType": "application/json",
            "responseSchema": receipt_schema(),
        },
    }
    model = urllib.parse.quote(GEMINI_OCR_MODEL, safe="")
    api_key = urllib.parse.quote(GEMINI_API_KEY, safe="")
    req = urllib.request.Request(
        f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}",
        data=json.dumps(request_payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as response:
        response_json = json.loads(response.read().decode("utf-8"))

    parsed = json.loads(extract_gemini_text(response_json))
    return {
        "store_name": parsed.get("store_name"),
        "total_amount": parsed.get("total_amount"),
        "subtotal_amount": parsed.get("subtotal_amount"),
        "paid_at": parsed.get("paid_at"),
        "paid_time": parsed.get("paid_time"),
        "items": parsed.get("items", []),
        "confidence": parsed.get("confidence", 0),
        "notes": parsed.get("notes", ""),
        "model": GEMINI_OCR_MODEL,
    }


def receipt_prompt():
    return (
        "日本のレシート画像から、店名、購入日時、小計または合計、商品名を読み取ってください。"
        "合計より下、支払い方法、お預り、お釣り、ポイント、カード控えは無視してください。"
        "total_amountには、支払い情報ではなくレシート上部の合計または小計を入れてください。"
        "読めない項目はnullまたは空配列にしてください。"
    )


def receipt_schema():
    return {
        "type": "object",
        "properties": {
            "store_name": {"type": "string", "nullable": True},
            "total_amount": {"type": "integer", "nullable": True},
            "subtotal_amount": {"type": "integer", "nullable": True},
            "paid_at": {"type": "string", "nullable": True},
            "paid_time": {"type": "string", "nullable": True},
            "items": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "name": {"type": "string"},
                        "amount": {"type": "integer", "nullable": True},
                    },
                    "required": ["name", "amount"],
                },
            },
            "confidence": {"type": "number"},
            "notes": {"type": "string"},
        },
        "required": [
            "store_name",
            "total_amount",
            "subtotal_amount",
            "paid_at",
            "paid_time",
            "items",
            "confidence",
            "notes",
        ],
    }


def split_data_url(image_data_url):
    header, _, base64_data = image_data_url.partition(",")
    if not base64_data or ";base64" not in header:
        raise ValueError("invalid image data URL")
    mime_type = header.removeprefix("data:").split(";")[0] or "image/jpeg"
    return mime_type, base64_data


def extract_gemini_text(response_json):
    for candidate in response_json.get("candidates", []):
        for part in candidate.get("content", {}).get("parts", []):
            if part.get("text"):
                return part["text"]
    raise ValueError("Gemini response has no text")


def to_data_url_from_bytes(image_bytes, media_type):
    media_type = media_type.split(";", 1)[0].strip().lower()
    if media_type == "application/octet-stream":
        media_type = "image/jpeg"
    data = base64.b64encode(image_bytes).decode("ascii")
    return f"data:{media_type};base64,{data}"


def to_data_url(path):
    suffix = Path(path).suffix.lower().lstrip(".")
    if suffix == "jpg":
        suffix = "jpeg"
    data = base64.b64encode(Path(path).read_bytes()).decode("ascii")
    return f"data:image/{suffix};base64,{data}"


def main():
    server = ThreadingHTTPServer((HOST, PORT), ReceiptOcrHandler)
    print(f"Receipt OCR server running at http://{HOST}:{PORT}/")
    print(f"OCR backend: {OCR_BACKEND}")
    print("POST an image to /ocr as multipart field 'image', raw image body, or JSON image_path/image_data_url.")
    server.serve_forever()


if __name__ == "__main__":
    main()
