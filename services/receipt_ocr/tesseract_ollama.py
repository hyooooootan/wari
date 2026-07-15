import base64
import csv
import io
import json
import os
import re
import shutil
import subprocess
import tempfile
import unicodedata
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

from PIL import Image, ImageEnhance, ImageOps


OLLAMA_BASE_URL = os.environ.get("OLLAMA_BASE_URL", "http://127.0.0.1:11434")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "qwen2.5:3b")
OLLAMA_TIMEOUT = float(os.environ.get("OLLAMA_TIMEOUT", "25"))
TESSERACT_CMD = os.environ.get("TESSERACT_CMD", "tesseract")
TESSERACT_LANG = os.environ.get("TESSERACT_LANG", "jpn+eng")
TESSERACT_TIMEOUT = int(os.environ.get("TESSERACT_TIMEOUT", "20"))
TESSERACT_PSM = os.environ.get("TESSERACT_PSM", "6")
TESSERACT_OEM = os.environ.get("TESSERACT_OEM", "1")
TESSERACT_MAX_SIDE = int(os.environ.get("TESSERACT_MAX_SIDE", "1800"))
TESSERACT_THRESHOLD = os.environ.get("TESSERACT_THRESHOLD", "auto").lower()
MAX_ITEMS = int(os.environ.get("OCR_MAX_ITEMS", "40"))


def read_receipt_from_data_url(image_data_url):
    suffix, data = decode_data_url(image_data_url)
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        tmp.write(data)
        source_path = Path(tmp.name)
    try:
        return read_receipt_from_path(source_path)
    finally:
        safe_unlink(source_path)


def read_receipt_from_path(path):
    source_path = Path(path)
    warnings = []
    prepared_path = source_path.with_suffix(".tesseract.png")
    try:
        preprocess_image(source_path, prepared_path)
        ocr = run_tesseract(prepared_path)
        if not ocr["text"].strip():
            warnings.append("tesseract_empty_result")
        if not ocr["text"].strip():
            normalized = empty_receipt(["tesseract_empty_result"])
            add_wari_compat_fields(normalized)
            normalized["model"] = OLLAMA_MODEL
            normalized["ocr_backend"] = "tesseract_ollama"
            return normalized
        parsed = structure_with_ollama(ocr)
        normalized = normalize_receipt(parsed)
        normalized["warnings"] = merge_warnings(normalized.get("warnings", []), warnings)
        add_wari_compat_fields(normalized)
        normalized["model"] = OLLAMA_MODEL
        normalized["ocr_backend"] = "tesseract_ollama"
        return normalized
    except Exception as exc:
        failed = empty_receipt([f"tesseract_ollama_failed: {exc}"])
        add_wari_compat_fields(failed)
        failed["model"] = OLLAMA_MODEL
        failed["ocr_backend"] = "tesseract_ollama"
        return failed
    finally:
        safe_unlink(prepared_path)


def decode_data_url(image_data_url):
    match = re.match(r"^data:image/([a-zA-Z0-9.+-]+);base64,(.+)$", image_data_url or "")
    if not match:
        raise ValueError("invalid image data URL")
    ext = match.group(1).split("+", 1)[0].lower()
    if ext == "jpeg":
        ext = "jpg"
    return f".{ext}", base64.b64decode(match.group(2), validate=True)


def preprocess_image(source_path, output_path):
    image = Image.open(source_path).convert("RGB")
    image = ImageOps.exif_transpose(image)
    image.thumbnail((TESSERACT_MAX_SIDE, TESSERACT_MAX_SIDE), Image.Resampling.LANCZOS)
    image = ImageOps.grayscale(image)
    image = ImageEnhance.Contrast(image).enhance(1.6)
    if TESSERACT_THRESHOLD in ("1", "true", "yes", "auto"):
        image = image.point(lambda p: 255 if p > 170 else 0)
    image.save(output_path)


def run_tesseract(image_path):
    ensure_tesseract_available()
    text = run_tesseract_command(image_path, extra_args=[])
    tsv = run_tesseract_command(image_path, extra_args=["tsv"])
    lines = parse_tsv_lines(tsv)
    return {
        "text": text,
        "tsv": tsv,
        "lines": lines,
        "lang": TESSERACT_LANG,
    }


def ensure_tesseract_available():
    if shutil.which(TESSERACT_CMD) or Path(TESSERACT_CMD).exists():
        return
    raise RuntimeError(f"tesseract_not_found: {TESSERACT_CMD}")


def run_tesseract_command(image_path, extra_args):
    cmd = [
        TESSERACT_CMD,
        str(image_path),
        "stdout",
        "-l",
        TESSERACT_LANG,
        "--oem",
        TESSERACT_OEM,
        "--psm",
        TESSERACT_PSM,
    ]
    tessdata_dir = os.environ.get("TESSERACT_TESSDATA_DIR")
    if tessdata_dir:
        cmd.extend(["--tessdata-dir", tessdata_dir])
    cmd.extend(extra_args)
    try:
        completed = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=TESSERACT_TIMEOUT,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError("tesseract_timeout") from exc
    if completed.returncode != 0:
        stderr = completed.stderr.decode("utf-8", errors="replace")[-1000:]
        raise RuntimeError(f"tesseract_failed: {stderr}")
    return completed.stdout.decode("utf-8", errors="replace")


def parse_tsv_lines(tsv_text):
    reader = csv.DictReader(io.StringIO(tsv_text), delimiter="\t")
    grouped = {}
    for row in reader:
        text = (row.get("text") or "").strip()
        if not text:
            continue
        try:
            conf = float(row.get("conf", "-1"))
        except ValueError:
            conf = -1
        if conf < 0:
            continue
        key = (
            row.get("page_num"),
            row.get("block_num"),
            row.get("par_num"),
            row.get("line_num"),
        )
        item = {
            "text": text,
            "conf": conf,
            "left": to_int(row.get("left")),
            "top": to_int(row.get("top")),
            "width": to_int(row.get("width")),
            "height": to_int(row.get("height")),
        }
        grouped.setdefault(key, []).append(item)

    lines = []
    for words in grouped.values():
        words.sort(key=lambda x: x["left"])
        left = min(w["left"] for w in words)
        top = min(w["top"] for w in words)
        right = max(w["left"] + w["width"] for w in words)
        bottom = max(w["top"] + w["height"] for w in words)
        lines.append(
            {
                "text": " ".join(w["text"] for w in words),
                "confidence": round(sum(w["conf"] for w in words) / len(words) / 100, 3),
                "x": left,
                "y": top,
                "w": right - left,
                "h": bottom - top,
            }
        )
    return sorted(lines, key=lambda x: (x["y"], x["x"]))


def structure_with_ollama(ocr):
    if not valid_loopback_ollama_url(OLLAMA_BASE_URL):
        raise ValueError("ollama_url_not_loopback")
    prompt = build_ollama_prompt(ocr)
    payload = {
        "model": OLLAMA_MODEL,
        "prompt": prompt,
        "stream": False,
        "format": "json",
        "options": {
            "temperature": 0,
            "top_p": 0.9,
            "num_ctx": 8192,
        },
    }
    req = urllib.request.Request(
        f"{OLLAMA_BASE_URL.rstrip('/')}/api/generate",
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=OLLAMA_TIMEOUT) as response:
            response_json = json.loads(response.read().decode("utf-8"))
    except urllib.error.URLError as exc:
        raise RuntimeError(f"ollama_unreachable: {exc}") from exc
    raw = response_json.get("response", "")
    parsed = parse_json_lenient(raw)
    if parsed is None:
        return empty_receipt(["ollama_invalid_json"])
    return parsed


def valid_loopback_ollama_url(value):
    try:
        parsed = urlparse(value)
    except ValueError:
        return False
    return parsed.scheme in ("http", "https") and parsed.hostname in ("localhost", "127.0.0.1", "::1") and not parsed.username and not parsed.password


def build_ollama_prompt(ocr):
    compact_lines = ocr["lines"][:160]
    return (
        "You convert Japanese receipt OCR output into JSON.\n"
        "Return JSON only. No prose. No markdown.\n\n"
        "Required JSON shape:\n"
        "{\n"
        '  "store_name": string|null,\n'
        '  "purchased_at": "YYYY-MM-DDTHH:MM"| "YYYY-MM-DD" | null,\n'
        '  "total_amount": number|null,\n'
        '  "items": [\n'
        '    {"name": string|null, "amount": number|null, "quantity": number|null, "confidence": number|null}\n'
        "  ],\n"
        '  "warnings": string[]\n'
        "}\n\n"
        "Rules:\n"
        "- Do not invent products that are not present in OCR text.\n"
        "- Use null for unreadable fields.\n"
        "- Amounts must be numeric yen values. Remove currency symbols and commas.\n"
        "- If product-name and amount pairing is unclear, add a warning.\n"
        "- If total_amount and item sum do not match, add a warning.\n"
        "- Ignore payment method, received cash, change, points, card balance, receipt number, phone number, and address as items.\n"
        "- JSON only.\n\n"
        "Tesseract full text:\n"
        f"{ocr['text'][:12000]}\n\n"
        "Tesseract TSV lines as JSON:\n"
        f"{json.dumps(compact_lines, ensure_ascii=False)}"
    )


def parse_json_lenient(raw_text):
    if not raw_text:
        return None
    for candidate in (raw_text, strip_markdown_fence(raw_text), extract_balanced_json(raw_text)):
        if not candidate:
            continue
        try:
            return json.loads(candidate)
        except json.JSONDecodeError:
            continue
    return None


def strip_markdown_fence(text):
    stripped = text.strip()
    if stripped.startswith("```"):
        stripped = re.sub(r"^```(?:json)?\s*", "", stripped, flags=re.I)
        stripped = re.sub(r"\s*```$", "", stripped)
    return stripped


def extract_balanced_json(text):
    start = text.find("{")
    if start < 0:
        return None
    depth = 0
    in_string = False
    escape = False
    for index in range(start, len(text)):
        char = text[index]
        if in_string:
            if escape:
                escape = False
            elif char == "\\":
                escape = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return text[start : index + 1]
    return None


def normalize_receipt(data):
    if not isinstance(data, dict):
        return empty_receipt(["ollama_response_not_object"])
    purchased_at = clean_string(data.get("purchased_at"))
    result = {
        "store_name": clean_string(data.get("store_name")),
        "purchased_at": normalize_purchased_at(purchased_at),
        "total_amount": clean_amount(data.get("total_amount")),
        "items": normalize_items(data.get("items")),
        "warnings": normalize_warnings(data.get("warnings")),
    }
    if result["total_amount"] is not None:
        item_sum = sum(item["amount"] or 0 for item in result["items"])
        if result["items"] and item_sum != result["total_amount"]:
            result["warnings"] = merge_warnings(result["warnings"], ["明細合計と合計金額が一致しません"])
    return result


def add_wari_compat_fields(result):
    purchased_at = result.get("purchased_at")
    paid_at = None
    paid_time = None
    if isinstance(purchased_at, str):
        if "T" in purchased_at:
            paid_at, paid_time = purchased_at.split("T", 1)
        else:
            paid_at = purchased_at
    result["paid_at"] = paid_at
    result["paid_time"] = paid_time
    result["confidence"] = estimate_confidence(result)
    result["notes"] = "; ".join(result.get("warnings", []))
    return result


def estimate_confidence(result):
    score = 0.2
    if result.get("store_name"):
        score += 0.2
    if result.get("purchased_at"):
        score += 0.2
    if result.get("total_amount") is not None:
        score += 0.25
    if result.get("items"):
        score += 0.15
    return round(min(score, 0.95), 3)


def normalize_items(items):
    if not isinstance(items, list):
        return []
    normalized = []
    for item in items[:MAX_ITEMS]:
        if not isinstance(item, dict):
            continue
        name = clean_string(item.get("name"))
        amount = clean_amount(item.get("amount"))
        quantity = clean_amount(item.get("quantity"))
        confidence = clean_confidence(item.get("confidence"))
        if name is None and amount is None:
            continue
        normalized.append(
            {
                "name": name,
                "amount": amount,
                "quantity": quantity,
                "confidence": confidence,
            }
        )
    return normalized


def normalize_warnings(warnings):
    if not isinstance(warnings, list):
        return []
    result = []
    for warning in warnings:
        value = clean_string(warning)
        if value and value not in result:
            result.append(value)
    return result


def empty_receipt(warnings=None):
    return {
        "store_name": None,
        "purchased_at": None,
        "total_amount": None,
        "items": [],
        "warnings": normalize_warnings(warnings or []),
    }


def clean_string(value):
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def clean_amount(value):
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        amount = int(value)
    else:
        text = unicodedata.normalize("NFKC", str(value))
        text = re.sub(r"[^\d-]", "", text)
        if not text or text == "-":
            return None
        amount = int(text)
    if amount < 0 or amount > 9_999_999:
        return None
    return amount


def clean_confidence(value):
    if value is None or value == "":
        return None
    try:
        confidence = float(value)
    except (TypeError, ValueError):
        return None
    return max(0.0, min(1.0, confidence))


def normalize_purchased_at(value):
    if not value:
        return None
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        return value
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}", value):
        return value
    return None


def merge_warnings(left, right):
    merged = []
    for warning in [*(left or []), *(right or [])]:
        if warning and warning not in merged:
            merged.append(warning)
    return merged


def to_int(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def safe_unlink(path):
    try:
        Path(path).unlink(missing_ok=True)
    except OSError:
        pass


def health():
    available = bool(shutil.which(TESSERACT_CMD) or Path(TESSERACT_CMD).exists())
    langs = list_tesseract_langs() if available else []
    return {
        "backend": "tesseract_ollama",
        "tesseract": {
            "available": available,
            "cmd": TESSERACT_CMD,
            "lang": TESSERACT_LANG,
            "langs": langs,
            "configured_langs_available": configured_tesseract_langs_available(langs),
        },
        "ollama": {
            "base_url": OLLAMA_BASE_URL,
            "model": OLLAMA_MODEL,
            "timeout_seconds": OLLAMA_TIMEOUT,
            "available": ollama_available(),
            "model_present": ollama_model_present(),
        },
    }


def list_tesseract_langs():
    try:
        completed = subprocess.run(
            [TESSERACT_CMD, "--list-langs"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=10,
            check=False,
        )
    except Exception:
        return []
    if completed.returncode != 0:
        return []
    lines = completed.stdout.decode("utf-8", errors="replace").splitlines()
    return [line.strip() for line in lines[1:] if line.strip()]


def configured_tesseract_langs_available(installed_langs):
    if not installed_langs:
        return False
    required = [lang.strip() for lang in TESSERACT_LANG.split("+") if lang.strip()]
    return all(lang in installed_langs for lang in required)


def ollama_available():
    return ollama_status()["available"]


def ollama_model_present():
    return ollama_status()["model_present"]


def ollama_status():
    try:
        req = urllib.request.Request(f"{OLLAMA_BASE_URL.rstrip('/')}/api/tags", method="GET")
        with urllib.request.urlopen(req, timeout=3) as response:
            if response.status != 200:
                return {"available": False, "model_present": False}
            payload = json.loads(response.read().decode("utf-8"))
            names = {
                str(tag.get("name"))
                for tag in payload.get("models", [])
                if isinstance(tag, dict) and tag.get("name")
            }
            return {"available": True, "model_present": OLLAMA_MODEL in names}
    except Exception:
        return {"available": False, "model_present": False}
