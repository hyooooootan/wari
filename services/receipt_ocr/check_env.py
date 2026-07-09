import json

try:
    from services.receipt_ocr.tesseract_ollama import health
except ImportError:
    from tesseract_ollama import health


if __name__ == "__main__":
    print(json.dumps(health(), ensure_ascii=False, indent=2))
