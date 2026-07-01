import json
import os
import urllib.error
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


PORT = int(os.environ.get("PORT", "4181"))
HOST = os.environ.get("HOST", "127.0.0.1")
PUBLIC_DIR = Path(__file__).parent / "public"
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY")
OPENAI_OCR_MODEL = os.environ.get("OPENAI_OCR_MODEL", "gpt-5.4-mini")
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY")
GEMINI_OCR_MODEL = os.environ.get("GEMINI_OCR_MODEL", "gemini-2.5-flash")
OCR_BACKEND = os.environ.get("OCR_BACKEND", "local").lower()
MAX_BODY_SIZE = 8 * 1024 * 1024


class WariHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(PUBLIC_DIR), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_POST(self):
        if self.path != "/api/ocr-receipt":
            self.send_json(404, {"error": "not_found"})
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self.send_json(400, {"error": "invalid_content_length"})
            return

        if length <= 0 or length > MAX_BODY_SIZE:
            self.send_json(413, {"error": "image_too_large", "message": "画像は8MB以下にしてください。"})
            return

        try:
            body = self.rfile.read(length).decode("utf-8")
            payload = json.loads(body)
            image_data_url = payload["image_data_url"]
        except Exception:
            self.send_json(400, {"error": "invalid_request", "message": "画像データを読み取れませんでした。"})
            return

        if not isinstance(image_data_url, str) or not image_data_url.startswith("data:image/"):
            self.send_json(400, {"error": "invalid_image", "message": "画像ファイルを選択してください。"})
            return

        try:
            self.send_json(200, read_receipt(image_data_url))
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            self.send_json(502, {"error": "ocr_provider_error", "message": detail[:1000]})
        except Exception as exc:
            self.send_json(500, {"error": "server_error", "message": str(exc)})

    def send_json(self, status, payload):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def read_receipt(image_data_url):
    if OCR_BACKEND == "openai":
        if not OPENAI_API_KEY:
            raise RuntimeError("OPENAI_API_KEY が未設定です。OCR_BACKEND=local でローカルOCRを使えます。")
        return read_receipt_with_openai(image_data_url)
    if OCR_BACKEND == "gemini":
        if not GEMINI_API_KEY:
            raise RuntimeError("GEMINI_API_KEY が未設定です。OCR_BACKEND=local でローカルOCRを使えます。")
        return read_receipt_with_gemini(image_data_url)
    if OCR_BACKEND == "auto" and OPENAI_API_KEY:
        return read_receipt_with_openai(image_data_url)
    if OCR_BACKEND == "auto" and GEMINI_API_KEY:
        return read_receipt_with_gemini(image_data_url)
    from services.receipt_ocr.core import read_receipt_from_data_url

    return read_receipt_from_data_url(image_data_url)


def openai_receipt_schema():
    return {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "store_name": {"type": ["string", "null"]},
            "total_amount": {"type": ["integer", "null"]},
            "subtotal_amount": {"type": ["integer", "null"]},
            "paid_at": {"type": ["string", "null"]},
            "paid_time": {"type": ["string", "null"]},
            "items": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "name": {"type": "string"},
                        "amount": {"type": ["integer", "null"]},
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


def gemini_receipt_schema():
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


def receipt_prompt():
    return (
        "日本のレシート画像から、店名、購入日時、小計または合計、商品名を読み取ってください。"
        "合計より下、支払い方法、お預り、お釣り、ポイント、カード控えは無視してください。"
        "total_amountには、支払い情報ではなくレシート上部の合計または小計を入れてください。"
        "読めない項目はnullまたは空配列にしてください。"
    )


def read_receipt_with_openai(image_data_url):
    request_payload = {
        "model": OPENAI_OCR_MODEL,
        "store": False,
        "input": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "input_text",
                        "text": receipt_prompt(),
                    },
                    {"type": "input_image", "image_url": image_data_url, "detail": "high"},
                ],
            }
        ],
        "text": {
            "format": {
                "type": "json_schema",
                "name": "receipt_ocr",
                "schema": openai_receipt_schema(),
                "strict": True,
            }
        },
    }
    req = urllib.request.Request(
        "https://api.openai.com/v1/responses",
        data=json.dumps(request_payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {OPENAI_API_KEY}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as response:
        response_json = json.loads(response.read().decode("utf-8"))

    parsed = json.loads(extract_output_text(response_json))
    return {
        "store_name": parsed.get("store_name"),
        "total_amount": parsed.get("total_amount"),
        "subtotal_amount": parsed.get("subtotal_amount"),
        "paid_at": parsed.get("paid_at"),
        "paid_time": parsed.get("paid_time"),
        "items": parsed.get("items", []),
        "confidence": parsed.get("confidence", 0),
        "notes": parsed.get("notes", ""),
        "model": response_json.get("model", OPENAI_OCR_MODEL),
    }


def read_receipt_with_gemini(image_data_url):
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
            "responseSchema": gemini_receipt_schema(),
        },
    }
    model = urllib.parse.quote(GEMINI_OCR_MODEL, safe="")
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={urllib.parse.quote(GEMINI_API_KEY, safe='')}"
    req = urllib.request.Request(
        url,
        data=json.dumps(request_payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as response:
        response_json = json.loads(response.read().decode("utf-8"))

    parsed = json.loads(extract_gemini_output_text(response_json))
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


def split_data_url(image_data_url):
    header, _, base64_data = image_data_url.partition(",")
    if not base64_data or ";base64" not in header:
        raise ValueError("画像データの形式が不正です。")
    mime_type = header.removeprefix("data:").split(";")[0] or "image/jpeg"
    return mime_type, base64_data


def extract_gemini_output_text(response_json):
    for candidate in response_json.get("candidates", []):
        for part in candidate.get("content", {}).get("parts", []):
            if part.get("text"):
                return part["text"]
    raise ValueError("Geminiの応答からテキストを取り出せませんでした。")


def extract_output_text(response_json):
    if response_json.get("output_text"):
        return response_json["output_text"]
    for item in response_json.get("output", []):
        for content in item.get("content", []):
            if content.get("type") == "output_text" and content.get("text"):
                return content["text"]
    raise ValueError("OpenAIの応答からテキストを取り出せませんでした。")


if __name__ == "__main__":
    server = ThreadingHTTPServer((HOST, PORT), WariHandler)
    print(f"Wari server running at http://{HOST}:{PORT}/")
    print(f"OCR backend: {OCR_BACKEND}")
    server.serve_forever()
