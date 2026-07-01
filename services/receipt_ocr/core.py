import base64
import json
import os
import re
import tempfile
import unicodedata
from dataclasses import dataclass
from pathlib import Path

os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")
os.environ.setdefault("PADDLE_PDX_ENABLE_MKLDNN_BYDEFAULT", "0")

from PIL import Image, ImageEnhance, ImageOps
from paddleocr import PaddleOCR


MAX_OCR_SIDE = int(os.environ.get("LOCAL_OCR_MAX_SIDE", "720"))
TEXT_DET_LIMIT = int(os.environ.get("LOCAL_OCR_DET_LIMIT", "480"))
TEXT_DET_MODEL = os.environ.get("LOCAL_OCR_DET_MODEL", "PP-OCRv6_tiny_det")
TEXT_REC_MODEL = os.environ.get("LOCAL_OCR_REC_MODEL", "PP-OCRv6_small_rec")
_OCR = None

TEXT_CORRECTIONS = {
    "=FamilyMart": "FamilyMart",
    "/EON STYLE": "AEON STYLE",
    "值": "値",
    "领収": "領収",
    "額収": "領収",
    "对象": "対象",
    "消费": "消費",
    "ホ°": "ポ",
    "ハ°": "パ",
}


PAYMENT_BOUNDARY_WORDS = (
    "お預り",
    "お預かり",
    "預り",
    "お釣",
    "釣銭",
    "支払",
    "PayPay",
    "AEON Pay",
    "クレジット",
    "カード",
    "VISA",
    "電子マネー",
    "交通系",
)
TOTAL_WORDS = ("合計", "総合計", "税込合計", "お買上計", "小計")
IGNORE_AMOUNT_WORDS = ("税", "対象", "内消費", "外税", "内税", "お預り", "お釣", "支払")


@dataclass
class OcrLine:
    text: str
    confidence: float
    x: float
    y: float
    w: float
    h: float


def read_receipt_from_data_url(image_data_url):
    suffix, data = decode_data_url(image_data_url)
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        tmp.write(data)
        source_path = Path(tmp.name)

    try:
        return read_receipt_from_path(source_path)
    finally:
        try:
            source_path.unlink(missing_ok=True)
        except OSError:
            pass


def read_receipt_from_path(source_path):
    prepared_path = source_path.with_suffix(".prepared.png")
    try:
        prepare_image(source_path, prepared_path, vertical_range=(0.0, 0.72))
        lines = run_paddle(prepared_path)
        parsed = parse_receipt(lines)
        if parsed.get("total_amount") is None:
            band_path = source_path.with_suffix(".total-band.png")
            prepare_image(source_path, band_path, vertical_range=(0.42, 0.9))
            band_lines = run_paddle(band_path)
            parsed = merge_receipt_results(parsed, parse_receipt(band_lines))
            lines.extend(band_lines)
        parsed["model"] = "paddleocr-local"
        parsed["ocr_lines"] = [
            {"text": line.text, "confidence": line.confidence, "x": line.x, "y": line.y, "w": line.w, "h": line.h}
            for line in lines
        ]
        return parsed
    finally:
        for path in (prepared_path, source_path.with_suffix(".total-band.png")):
            try:
                path.unlink(missing_ok=True)
            except OSError:
                pass


def decode_data_url(image_data_url):
    match = re.match(r"^data:image/([a-zA-Z0-9.+-]+);base64,(.+)$", image_data_url)
    if not match:
        raise ValueError("画像データが正しくありません。")
    ext = match.group(1).split("+", 1)[0].lower()
    if ext == "jpeg":
        ext = "jpg"
    return f".{ext}", base64.b64decode(match.group(2), validate=True)


def prepare_image(source_path, output_path, vertical_range=(0.0, 0.72)):
    image = Image.open(source_path).convert("RGB")
    image = ImageOps.exif_transpose(image)
    image = crop_likely_receipt(image)
    top_ratio, bottom_ratio = vertical_range
    top = max(0, min(image.height - 1, int(image.height * top_ratio)))
    bottom = max(top + 1, min(image.height, int(image.height * bottom_ratio)))
    image = image.crop((0, top, image.width, bottom))
    image.thumbnail((MAX_OCR_SIDE, MAX_OCR_SIDE), Image.Resampling.LANCZOS)
    image = ImageEnhance.Contrast(image).enhance(1.2)
    image.save(output_path)


def crop_likely_receipt(image):
    # Fast center-biased crop: receipts are usually the bright vertical object near center.
    small = image.resize((max(1, image.width // 8), max(1, image.height // 8)), Image.Resampling.BILINEAR)
    pixels = small.load()
    xs = []
    ys = []
    for y in range(small.height):
        for x in range(small.width):
            r, g, b = pixels[x, y]
            bright = (r + g + b) / 3
            sat = max(r, g, b) - min(r, g, b)
            if bright > 185 and sat < 55:
                xs.append(x)
                ys.append(y)
    if len(xs) < 80:
        return image

    scale_x = image.width / small.width
    scale_y = image.height / small.height
    left = max(0, int((min(xs) - 2) * scale_x))
    top = max(0, int((min(ys) - 2) * scale_y))
    right = min(image.width, int((max(xs) + 3) * scale_x))
    bottom = min(image.height, int((max(ys) + 3) * scale_y))
    if (right - left) < image.width * 0.2 or (bottom - top) < image.height * 0.2:
        return image
    return image.crop((left, top, right, bottom))


def get_ocr():
    global _OCR
    if _OCR is None:
        _OCR = PaddleOCR(
            lang="japan",
            use_doc_orientation_classify=False,
            use_doc_unwarping=False,
            use_textline_orientation=False,
            text_detection_model_name=TEXT_DET_MODEL,
            text_recognition_model_name=TEXT_REC_MODEL,
            text_det_limit_side_len=TEXT_DET_LIMIT,
            text_det_limit_type="max",
            text_recognition_batch_size=16,
        )
    return _OCR


def run_paddle(image_path):
    result = get_ocr().predict(str(image_path))
    lines = []
    for page in result:
        texts = page.get("rec_texts", [])
        scores = page.get("rec_scores", [])
        boxes = page.get("rec_boxes", [])
        polys = page.get("rec_polys", [])
        for i, text in enumerate(texts):
            text = normalize_text(text)
            if not text:
                continue
            x, y, w, h = box_metrics(boxes[i] if i < len(boxes) else None, polys[i] if i < len(polys) else None)
            lines.append(OcrLine(text=text, confidence=float(scores[i]), x=x, y=y, w=w, h=h))
    return sorted(lines, key=lambda line: (line.y, line.x))


def box_metrics(box, poly):
    if box is not None and len(box) >= 4:
        left, top, right, bottom = [float(v) for v in box[:4]]
        return left, top, right - left, bottom - top
    if poly is not None:
        xs = [float(point[0]) for point in poly]
        ys = [float(point[1]) for point in poly]
        return min(xs), min(ys), max(xs) - min(xs), max(ys) - min(ys)
    return 0.0, 0.0, 0.0, 0.0


def normalize_text(text):
    text = str(text or "").strip()
    text = unicodedata.normalize("NFKC", text)
    text = text.replace("￥", "¥").replace("：", ":").replace("／", "/")
    text = text.replace("−", "-").replace("‐", "-")
    text = text.replace("言十", "計")
    for wrong, right in TEXT_CORRECTIONS.items():
        text = text.replace(wrong, right)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def parse_receipt(lines):
    active = lines_before_payment(lines)
    text = "\n".join(line.text for line in active)
    store_name = guess_store_name(active)
    paid_at, paid_time = guess_datetime(text)
    subtotal_amount, total_amount = guess_amounts(active)
    items = guess_items(active)
    confidence = score_result(store_name, paid_at, total_amount, items)

    return {
        "store_name": store_name,
        "total_amount": total_amount,
        "subtotal_amount": subtotal_amount,
        "paid_at": paid_at,
        "paid_time": paid_time,
        "items": items,
        "confidence": confidence,
        "notes": "",
    }


def merge_receipt_results(primary, fallback):
    merged = dict(primary)
    for key in ("total_amount", "subtotal_amount", "paid_at", "paid_time"):
        if merged.get(key) is None and fallback.get(key) is not None:
            merged[key] = fallback[key]
    if not merged.get("items") and fallback.get("items"):
        merged["items"] = fallback["items"]
    merged["confidence"] = max(primary.get("confidence", 0), fallback.get("confidence", 0))
    return merged


def lines_before_payment(lines):
    boundary_y = None
    for index, line in enumerate(lines):
        if index < 8:
            continue
        if any(word.lower() in line.text.lower() for word in PAYMENT_BOUNDARY_WORDS):
            boundary_y = line.y
            break
    if boundary_y is None:
        return lines
    return [line for line in lines if line.y < boundary_y]


def guess_store_name(lines):
    candidates = []
    for line in lines[:8]:
        if re.search(r"\d{2,}|TEL|FAX|登録番号|領収|レシート|www|http", line.text, re.I):
            continue
        if len(line.text) < 2:
            continue
        candidates.append(line)
    if not candidates:
        return None
    return max(candidates, key=store_name_score).text


def store_name_score(line):
    score = line.w * line.h * max(line.confidence, 0.1)
    if re.search(r"[\u3040-\u30ff\u3400-\u9fff]", line.text):
        score *= 1.5
    if re.search(r"店|阪急|スタイル|ガーデン|百貨店|ストア|マーケット", line.text):
        score *= 1.35
    if line.text.startswith(("/", "\\", "|")):
        score *= 0.4
    return score


def guess_datetime(text):
    date_patterns = [
        r"(20\d{2})年\s*(\d{1,2})月\s*(\d{1,2})日(?:\([^)]*\))?\s*(\d{1,2})[:：](\d{2})",
        r"(20\d{2})[/-](\d{1,2})[/-](\d{1,2})\s*(\d{1,2})[:：](\d{2})",
        r"(20\d{2})年\s*(\d{1,2})月\s*(\d{1,2})日",
        r"(20\d{2})[/-](\d{1,2})[/-](\d{1,2})",
    ]
    for pattern in date_patterns:
        match = re.search(pattern, text)
        if match:
            year, month, day = [int(match.group(i)) for i in range(1, 4)]
            paid_time = None
            if match.lastindex and match.lastindex >= 5:
                paid_time = f"{int(match.group(4)):02d}:{int(match.group(5)):02d}"
            return f"{year:04d}-{month:02d}-{day:02d}", paid_time
    time_match = re.search(r"(\d{1,2})[:：](\d{2})", text)
    return None, f"{int(time_match.group(1)):02d}:{int(time_match.group(2)):02d}" if time_match else None


def guess_amounts(lines):
    subtotal = amount_near_words(lines, ("小計",))
    total = amount_near_words(lines, ("合計", "総合計", "税込合計", "お買上計"))
    if total is None:
        total = subtotal
    if total is None:
        candidates = []
        for line in lines:
            if is_noise_item_line(line.text):
                continue
            candidates.extend(extract_amounts(line.text))
        if candidates:
            total = max(candidates)
    return subtotal, total


def amount_near_words(lines, words):
    for i, line in enumerate(lines):
        label_text = row_text(lines, line)
        if not any(word in label_text for word in words):
            continue
        if any(word in label_text for word in ("商品合計", "値引合計")):
            continue
        same_row_amounts = extract_amounts(label_text)
        if same_row_amounts:
            return max(same_row_amounts)
        window = lines[max(0, i - 3) : min(i + 4, len(lines))]
        amounts = []
        for candidate in window:
            if any(word in candidate.text for word in IGNORE_AMOUNT_WORDS) and candidate is not line:
                continue
            amounts.extend(extract_amounts(candidate.text))
        if amounts:
            return max(amounts)
    return None


def row_text(lines, target):
    row = [line for line in lines if abs(line.y - target.y) <= max(10, target.h * 0.8)]
    return "".join(line.text for line in sorted(row, key=lambda line: line.x))


def extract_amounts(text):
    values = []
    for raw in re.findall(r"(?:[¥￥]\s*)?(\d{1,3}(?:,\d{3})+|\d{2,6})", text):
        value = int(raw.replace(",", ""))
        if 1 <= value <= 9_999_999:
            values.append(value)
    return values


def guess_items(lines):
    start_index = 0
    for i, line in enumerate(lines):
        if re.search(r"\d{4}年\d{1,2}月\d{1,2}日|\d{4}[/-]\d{1,2}[/-]\d{1,2}", line.text):
            start_index = i + 1
            break
    if start_index == 0:
        for i, line in enumerate(lines):
            if re.search(r"領収|领収|額収", row_text(lines, line)):
                start_index = i + 1
                break

    stop_index = len(lines)
    for i, line in enumerate(lines):
        if any(word in row_text(lines, line) for word in TOTAL_WORDS):
            stop_index = i
            break

    items = []
    item_lines = lines[start_index:stop_index]
    for index, line in enumerate(item_lines):
        text = line.text
        if is_noise_item_line(text):
            continue
        amounts = extract_amounts(text)
        if not amounts:
            same_row_amounts = []
            for candidate in item_lines:
                if candidate is line:
                    continue
                if is_noise_item_line(candidate.text) and not re.fullmatch(r"[¥￥]?\s*\d{1,3}(?:,\d{3})+|[¥￥]?\s*\d{2,6}", candidate.text):
                    continue
                if re.search(r"小計|合計|消費|外税|内税|対象|对象|お預り|お釣|Pay|クレジット|支払|税\s*\d+%", candidate.text, re.I):
                    continue
                if candidate.x > line.x and abs(candidate.y - line.y) <= max(12, line.h):
                    for amount in extract_amounts(candidate.text):
                        same_row_amounts.append((abs(candidate.y - line.y), amount))
            plausible_same_row = [(distance, amount) for distance, amount in same_row_amounts if amount >= 20]
            if plausible_same_row:
                items.append({"name": text, "amount": min(plausible_same_row)[1]})
                continue

            nearby = item_lines[index + 1 : min(index + 7, len(item_lines))]
            nearby_amounts = []
            for candidate in nearby:
                if is_noise_item_line(candidate.text):
                    continue
                nearby_amounts.extend(extract_amounts(candidate.text))
            plausible = [amount for amount in nearby_amounts if amount >= 50]
            if plausible and len(text) >= 3:
                items.append({"name": text, "amount": max(plausible)})
            continue
        name = re.sub(r"[¥￥]?\s*\d{1,3}(?:,\d{3})+|[¥￥]?\s*\d{2,6}|※|軽", "", text).strip()
        name = re.sub(r"\s{2,}", " ", name)
        if len(name) >= 2:
            items.append({"name": name, "amount": amounts[-1]})
    return dedupe_items(items)[:20]


def is_noise_item_line(text):
    if re.fullmatch(r"[\s=ー\-＿_・･.。]+", text):
        return True
    if re.search(r"TEL|FAX|電話|登録番号|領収|领収|額収|レシート|会員|レジ|レシ[\"”]?\s*\d|レ[;:]|責|责|貴No|取\d|No\.|www|http|決済|明細", text, re.I):
        return True
    if re.search(r"年.*月.*日|\d{4}[/-]\d{1,2}[/-]\d{1,2}", text):
        return True
    if len(text) <= 2:
        return True
    if len(text) <= 3 and re.search(r"[^A-Za-z0-9\u3040-\u30ff\u3400-\u9fff]", text):
        return True
    if re.search(r"小計|合計|商品合計|値引|消費|外税|内税|対象|对象|お預り|お釣|Pay|クレジット|支払|税\s*\d+%", text, re.I):
        return True
    if re.fullmatch(r"[A-Z]?\d[\d\- ]+", text):
        return True
    if re.search(r"単価|单価|\d+\s*点", text):
        return True
    return False


def dedupe_items(items):
    seen = set()
    unique = []
    for item in items:
        key = item["name"]
        if key in seen:
            continue
        seen.add(key)
        unique.append(item)
    return unique


def score_result(store_name, paid_at, total_amount, items):
    score = 0.15
    if store_name:
        score += 0.25
    if paid_at:
        score += 0.2
    if total_amount:
        score += 0.25
    if items:
        score += 0.1
    return round(min(score, 0.95), 3)


if __name__ == "__main__":
    import sys

    image_path = Path(sys.argv[1])
    print(json.dumps(read_receipt_from_path(image_path), ensure_ascii=False, indent=2))
