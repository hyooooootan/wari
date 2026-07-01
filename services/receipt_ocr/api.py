import base64
import json
import os
import re
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

try:
    from services.receipt_ocr.core import read_receipt_from_data_url, read_receipt_from_path
except ImportError:
    from core import read_receipt_from_data_url, read_receipt_from_path


HOST = os.environ.get("OCR_HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", os.environ.get("OCR_PORT", "4190")))
MAX_BODY_SIZE = int(os.environ.get("OCR_MAX_BODY_SIZE", str(10 * 1024 * 1024)))


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
            self.send_json(200, {"ok": True, "service": "receipt-ocr"})
            return
        if path == "/":
            self.send_json(
                200,
                {
                    "service": "receipt-ocr",
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
            image_bytes, suffix = parse_multipart_image(body, content_type)
            return read_temp_image(image_bytes, suffix)

        if content_type.startswith("image/") or content_type == "application/octet-stream":
            suffix = suffix_from_content_type(content_type)
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
        return content, suffix

    raise ValueError("multipart field named image or file is required")


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


def to_data_url(path):
    suffix = Path(path).suffix.lower().lstrip(".")
    if suffix == "jpg":
        suffix = "jpeg"
    data = base64.b64encode(Path(path).read_bytes()).decode("ascii")
    return f"data:image/{suffix};base64,{data}"


def main():
    server = ThreadingHTTPServer((HOST, PORT), ReceiptOcrHandler)
    print(f"Receipt OCR server running at http://{HOST}:{PORT}/")
    print("POST an image to /ocr as multipart field 'image', raw image body, or JSON image_path/image_data_url.")
    server.serve_forever()


if __name__ == "__main__":
    main()
