import argparse
import json
import os
import re
from pathlib import Path

os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")
os.environ.setdefault("PADDLE_PDX_ENABLE_MKLDNN_BYDEFAULT", "0")

from paddleocr import PaddleOCR


RECEIPT_KEYWORDS = [
    "領収",
    "レシート",
    "合計",
    "小計",
    "消費税",
    "税込",
    "税抜",
    "お預り",
    "お釣",
    "TEL",
    "電話",
]


def flatten_ocr_result(result):
    lines = []
    for page in result:
        if isinstance(page, dict) or hasattr(page, "get"):
            texts = page.get("rec_texts", [])
            scores = page.get("rec_scores", [])
            for text, score in zip(texts, scores):
                lines.append({"text": text, "confidence": float(score)})
            continue

        for item in page:
            if len(item) >= 2 and isinstance(item[1], (list, tuple)):
                lines.append({"text": item[1][0], "confidence": float(item[1][1])})
    return lines


def receipt_score(lines, image_path):
    text = "\n".join(line["text"] for line in lines)
    keyword_hits = [word for word in RECEIPT_KEYWORDS if word.lower() in text.lower()]
    money_hits = re.findall(r"(?:￥|¥)?\s*\d{2,3}(?:,\d{3})+|(?:￥|¥)\s*\d+", text)
    date_hits = re.findall(r"\d{4}[/-]\d{1,2}[/-]\d{1,2}|\d{1,2}[/-]\d{1,2}", text)
    digit_line_count = sum(1 for line in lines if re.search(r"\d", line["text"]))

    score = 0.0
    score += min(len(keyword_hits), 4) * 0.16
    score += min(len(money_hits), 4) * 0.08
    score += min(len(date_hits), 2) * 0.08
    score += min(digit_line_count, 8) * 0.025
    score += 0.08 if len(lines) >= 8 else 0
    score = min(score, 0.98)

    return {
        "is_receipt": score >= 0.45,
        "confidence": round(score, 3),
        "signals": {
            "keywords": keyword_hits,
            "money_count": len(money_hits),
            "date_count": len(date_hits),
            "digit_line_count": digit_line_count,
            "line_count": len(lines),
            "file": str(image_path),
        },
    }


def main():
    parser = argparse.ArgumentParser(description="Run PaddleOCR and estimate whether an image is a receipt.")
    parser.add_argument("image", type=Path, help="Path to a receipt image.")
    parser.add_argument("--lang", default="japan", help="PaddleOCR language, e.g. japan, en, ch.")
    args = parser.parse_args()

    if not args.image.exists():
        raise SystemExit(f"Image not found: {args.image}")

    ocr = PaddleOCR(use_textline_orientation=True, lang=args.lang)
    raw_result = ocr.predict(str(args.image))
    lines = flatten_ocr_result(raw_result)

    output = {
        **receipt_score(lines, args.image),
        "text": "\n".join(line["text"] for line in lines),
        "lines": lines,
    }
    print(json.dumps(output, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
