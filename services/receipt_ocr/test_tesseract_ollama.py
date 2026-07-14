import base64
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image

from services.receipt_ocr import api
from services.receipt_ocr import tesseract_ollama as ocr


class TesseractOllamaTests(unittest.TestCase):
    def test_shared_bearer_authorization(self):
        class Handler:
            def __init__(self, authorization):
                self.headers = {"Authorization": authorization} if authorization is not None else {}
                self.response = None

            def send_json(self, status, payload):
                self.response = (status, payload)

        with patch.object(api, "RECEIPT_OCR_SHARED_SECRET", "shared-secret"):
            self.assertTrue(api.authorize_ocr_request(Handler("Bearer shared-secret")))
            missing = Handler(None)
            self.assertFalse(api.authorize_ocr_request(missing))
            self.assertEqual(missing.response, (401, {"error": "unauthorized"}))
            malformed = Handler("Basic shared-secret")
            self.assertFalse(api.authorize_ocr_request(malformed))
            self.assertEqual(malformed.response[0], 401)
            mismatch = Handler("Bearer other-secret")
            self.assertFalse(api.authorize_ocr_request(mismatch))
            self.assertEqual(mismatch.response[0], 401)

        unavailable = Handler("Bearer shared-secret")
        with patch.object(api, "RECEIPT_OCR_SHARED_SECRET", ""):
            self.assertFalse(api.authorize_ocr_request(unavailable))
        self.assertEqual(unavailable.response, (503, {"error": "ocr_auth_unavailable"}))

    def test_public_health_does_not_expose_secret_or_configuration(self):
        with patch.object(api, "OCR_BACKEND", "gemini"), patch.object(api, "RECEIPT_OCR_SHARED_SECRET", "secret-value"):
            payload = api.public_health_payload()
        serialized = str(payload)
        self.assertNotIn("secret-value", serialized)
        self.assertNotIn("127.0.0.1", serialized)

    def test_decode_rejects_broken_base64(self):
        with self.assertRaises(ValueError):
            ocr.decode_data_url("data:image/png;base64,***")

    def test_normalize_warns_when_item_sum_is_zero(self):
        result = ocr.normalize_receipt({
            "store_name": "店",
            "total_amount": 1200,
            "items": [{"name": "商品", "amount": 0}],
            "warnings": [],
        })
        self.assertIn("明細合計と合計金額が一致しません", result["warnings"])

    def test_json_with_surrounding_text_is_extracted(self):
        parsed = ocr.parse_json_lenient('結果はこちらです: {"store_name":"店","total_amount":1200}')
        self.assertEqual(parsed["total_amount"], 1200)

    def test_empty_tesseract_result_returns_shape_without_ollama(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "receipt.png"
            Image.new("RGB", (2, 2), "white").save(source)
            with patch.object(ocr, "run_tesseract", return_value={"text": "", "tsv": "", "lines": []}), patch.object(ocr, "structure_with_ollama") as ollama:
                result = ocr.read_receipt_from_path(source)
            self.assertEqual(result["store_name"], None)
            self.assertEqual(result["total_amount"], None)
            self.assertEqual(result["items"], [])
            self.assertIn("tesseract_empty_result", result["warnings"])
            ollama.assert_not_called()
            self.assertFalse((source.with_suffix(".tesseract.png")).exists())

    def test_tesseract_timeout_is_reported(self):
        with patch.object(ocr.subprocess, "run", side_effect=ocr.subprocess.TimeoutExpired("tesseract", 1)):
            with self.assertRaisesRegex(RuntimeError, "tesseract_timeout"):
                ocr.run_tesseract_command(Path("receipt.png"), [])

    def test_tesseract_nonzero_exit_is_reported(self):
        completed = type("Completed", (), {"returncode": 1, "stderr": b"failed", "stdout": b""})()
        with patch.object(ocr.subprocess, "run", return_value=completed):
            with self.assertRaisesRegex(RuntimeError, "tesseract_failed"):
                ocr.run_tesseract_command(Path("receipt.png"), [])

    def test_tesseract_failure_keeps_compatibility_fields(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "receipt.png"
            Image.new("RGB", (2, 2), "white").save(source)
            with patch.object(ocr, "run_tesseract", side_effect=RuntimeError("tesseract_failed")):
                result = ocr.read_receipt_from_path(source)
        self.assertIn("paid_at", result)
        self.assertIn("paid_time", result)
        self.assertIn("confidence", result)
        self.assertIn("notes", result)

    def test_ollama_unavailable_is_reported(self):
        with patch.object(ocr.urllib.request, "urlopen", side_effect=ocr.urllib.error.URLError("offline")):
            with self.assertRaisesRegex(RuntimeError, "ollama_unreachable"):
                ocr.structure_with_ollama({"text": "店 1200", "lines": []})

    def test_ollama_broken_json_returns_warning_shape(self):
        response = type("Response", (), {
            "read": lambda self: b'{"response":"not json"}',
            "__enter__": lambda self: self,
            "__exit__": lambda self, *args: None,
        })()
        with patch.object(ocr.urllib.request, "urlopen", return_value=response):
            result = ocr.structure_with_ollama({"text": "店 1200", "lines": []})
        self.assertEqual(result["items"], [])
        self.assertIn("ollama_invalid_json", result["warnings"])

    def test_cleanup_and_response_shape(self):
        encoded = base64.b64encode(b"not-an-image").decode("ascii")
        result = ocr.read_receipt_from_data_url(f"data:image/png;base64,{encoded}")
        self.assertIn("store_name", result)
        self.assertIn("total_amount", result)
        self.assertIn("items", result)
        self.assertIn("warnings", result)


if __name__ == "__main__":
    unittest.main()
