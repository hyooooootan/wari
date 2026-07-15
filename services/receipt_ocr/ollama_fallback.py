import base64
import datetime as dt
import json
import os
import re
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

from PIL import Image

try:
    from services.receipt_ocr.feedback import digits, feature_enabled, normalize_store, string_similarity
except ImportError:
    from feedback import digits, feature_enabled, normalize_store, string_similarity


OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434").rstrip("/")
TEXT_MODEL = os.environ.get("RECEIPT_OCR_TEXT_MODEL") or os.environ.get("OCR_TEXT_LLM_MODEL", "qwen2.5:1.5b-instruct")
VISION_MODEL = os.environ.get("RECEIPT_OCR_VISION_MODEL") or os.environ.get("OCR_VISION_MODEL", "qwen3-vl:2b")
TEXT_TIMEOUT = max(1.0, min(20.0, float(os.environ.get("RECEIPT_OCR_TEXT_TIMEOUT") or os.environ.get("OCR_TEXT_LLM_TIMEOUT_SECONDS", "10"))))
VISION_TIMEOUT = max(5.0, min(45.0, float(os.environ.get("RECEIPT_OCR_VISION_TIMEOUT") or os.environ.get("OCR_VISION_TIMEOUT_SECONDS", "45"))))
MAX_LLM_CALLS = max(0, min(1, int(os.environ.get("RECEIPT_OCR_MAX_LLM_CALLS", "1"))))
MAX_VISION_CALLS = max(0, min(3, int(os.environ.get("RECEIPT_OCR_MAX_VISION_CALLS", "3"))))
FEEDBACK_MAX_EXAMPLES = max(0, min(5, int(os.environ.get("RECEIPT_OCR_FEEDBACK_MAX_EXAMPLES", "5"))))
VISION_MAX_SIDE = max(256, min(1024, int(os.environ.get("RECEIPT_OCR_VISION_MAX_SIDE", "1024"))))
OLLAMA_KEEP_ALIVE = os.environ.get("RECEIPT_OCR_OLLAMA_KEEP_ALIVE", "5m")
VISION_SEMAPHORE = threading.BoundedSemaphore(1)


def apply_text_correction(result, feedback, remaining_seconds=None):
    result = dict(result)
    if MAX_LLM_CALLS == 0 or not feature_enabled("RECEIPT_OCR_ENABLE_TEXT_CORRECTION", "OCR_TEXT_LLM_ENABLED") or not should_use_text_model(result):
        return result
    evidence = result.get("field_evidence", {}).get("store_name", {})
    source_id = str(evidence.get("source_id", ""))[:64]
    original = result.get("store_name")
    if not source_id or not isinstance(original, str) or not original.strip():
        return result
    timeout = TEXT_TIMEOUT if remaining_seconds is None else min(TEXT_TIMEOUT, remaining_seconds)
    if timeout < 1:
        return result
    past = result.get("store_name_candidates", [])[:FEEDBACK_MAX_EXAMPLES]
    payload = {
        "task": "OCR店名の軽微な誤字候補を確認する。数字、支店名、識別子を変更しない。JSON以外を返さない。",
        "current": {"source_id": source_id, "text": original, "confidence": evidence.get("confidence", 0)},
        "past_corrections": past,
        "character_confusions": feedback.get("character_confusions", [])[:30] if isinstance(feedback, dict) else [],
    }
    fallbacks = result.setdefault("fallbacks", {})
    fallbacks["text_llm_calls"] = 1
    try:
        output = ollama_generate(TEXT_MODEL, json.dumps(payload, ensure_ascii=False), timeout)
        corrected = validate_text_output(output, source_id, original, past)
    except (OSError, ValueError, TimeoutError, urllib.error.URLError):
        return result
    if not corrected or corrected == original:
        return result
    result["store_name"] = corrected
    result.setdefault("corrections", []).append({"field": "store_name", "original": original, "corrected": corrected, "source": "text_llm"})
    result.setdefault("field_sources", {})["store_name"] = "text_llm_candidate"
    result.setdefault("fallbacks", {})["text_llm_used"] = True
    result["needs_review"] = True
    return result


def apply_vision_reread(result, image_path, remaining_seconds=None):
    result = dict(result)
    if MAX_VISION_CALLS == 0 or not feature_enabled("RECEIPT_OCR_ENABLE_VISION_REREAD", "OCR_VISION_ENABLED"):
        return result
    regions = required_regions(result)[:MAX_VISION_CALLS]
    if not regions or not VISION_SEMAPHORE.acquire(timeout=0.1):
        return result
    budget = VISION_TIMEOUT if remaining_seconds is None else min(VISION_TIMEOUT, remaining_seconds)
    if budget < 1:
        VISION_SEMAPHORE.release()
        return result
    deadline = time.monotonic() + budget
    used = []
    try:
        for region in regions:
            timeout = deadline - time.monotonic()
            if timeout < 1:
                break
            result.setdefault("fallbacks", {})["vision_calls"] = result.get("fallbacks", {}).get("vision_calls", 0) + 1
            try:
                output = read_region(image_path, result, region, timeout)
                apply_vision_output(result, region, output)
                used.append(region)
            except (OSError, ValueError, TimeoutError, urllib.error.URLError):
                continue
    finally:
        VISION_SEMAPHORE.release()
    if used:
        result.setdefault("fallbacks", {})["vision_reread_used"] = True
        result["fallbacks"]["vision_regions"] = used
    return result


def should_use_text_model(result):
    confidence = float(result.get("field_confidence", {}).get("store_name", 0.0))
    return not result.get("store_name") or confidence < 0.72 or bool(result.get("store_name_candidates"))


def validate_text_output(output, source_id, original, past):
    if not isinstance(output, dict) or output.get("source_id") != source_id or output.get("original") != original:
        return None
    corrected = output.get("corrected")
    if not isinstance(corrected, str) or not corrected.strip() or len(corrected) > 200:
        return None
    corrected = corrected.strip()
    if digits(original) != digits(corrected):
        return None
    allowed = {entry.get("corrected") for entry in past if isinstance(entry, dict)}
    if corrected not in allowed and string_similarity(normalize_store(original), normalize_store(corrected)) < 0.75:
        return None
    return corrected


def required_regions(result):
    fields = result.get("field_confidence", {})
    regions = []
    if not result.get("store_name") or float(fields.get("store_name", 0)) < 0.72:
        regions.append("store_region")
    validations = result.get("validations", {})
    if result.get("total_amount") is None or any(value is False for value in validations.values()):
        regions.append("total_region")
    if not result.get("paid_at") or not result.get("paid_time"):
        regions.append("datetime_region")
    return regions


def read_region(image_path, result, region, timeout=VISION_TIMEOUT):
    box = region_box(result, region)
    with Image.open(image_path).convert("RGB") as image:
        left, top, right, bottom = box
        crop = image.crop((int(left * image.width), int(top * image.height), int(right * image.width), int(bottom * image.height)))
        crop.thumbnail((VISION_MAX_SIDE, VISION_MAX_SIDE), Image.Resampling.LANCZOS)
        with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as handle:
            temporary = Path(handle.name)
        try:
            crop.save(temporary, format="JPEG", quality=90)
            encoded = base64.b64encode(temporary.read_bytes()).decode("ascii")
        finally:
            temporary.unlink(missing_ok=True)
    return ollama_generate(VISION_MODEL, region_prompt(region, result), timeout, [encoded])


def region_box(result, region):
    field = {"store_region": "store_name", "total_region": "total_amount", "datetime_region": "paid_at"}[region]
    box = result.get("field_evidence", {}).get(field, {}).get("bounding_box")
    if isinstance(box, list) and len(box) == 4 and all(isinstance(value, (int, float)) and 0 <= value <= 1 for value in box):
        preprocessing = result.get("field_evidence", {}).get(field, {}).get("preprocessing", "contrast")
        top, bottom = {"contrast": (0.0, 0.78), "total-band": (0.42, 0.98), "clahe": (0.0, 0.98), "adaptive": (0.0, 0.98)}.get(preprocessing, (0.0, 1.0))
        mapped_top = top + box[1] * (bottom - top)
        mapped_bottom = top + box[3] * (bottom - top)
        return [max(0, box[0] - 0.05), max(0, mapped_top - 0.04), min(1, box[2] + 0.05), min(1, mapped_bottom + 0.04)]
    return {"store_region": [0.0, 0.0, 1.0, 0.3], "total_region": [0.0, 0.6, 1.0, 1.0], "datetime_region": [0.0, 0.18, 1.0, 0.58]}[region]


def region_prompt(region, result):
    if region == "store_region":
        return '店名と支店名を画像から読み、JSONで {"store_name":文字列またはnull,"confidence":0から1} を返す。'
    if region == "total_region":
        candidates = [entry.get("value") for entry in result.get("total_candidates", [])[:20] if isinstance(entry, dict)]
        return f'税込の最終支払合計を読む。小計、税、預り、釣銭は除外する。候補は{candidates}。JSONで {{"read_amount":整数またはnull,"label":文字列またはnull,"confidence":0から1}} を返す。'
    return '購入日と時刻を読む。JSONで {"read_date":"YYYY-MM-DD"またはnull,"read_time":"HH:MM"またはnull,"confidence":0から1} を返す。'


def apply_vision_output(result, region, output):
    if not isinstance(output, dict):
        return
    confidence = output.get("confidence")
    if not isinstance(confidence, (int, float)) or not 0 <= confidence <= 1:
        return
    if region == "store_region":
        value = output.get("store_name")
        if isinstance(value, str) and 0 < len(value.strip()) <= 200:
            result.setdefault("vision_candidates", {})["store_name"] = value.strip()
        return
    if region == "total_region":
        amount = output.get("read_amount")
        candidates = {entry.get("value") for entry in result.get("total_candidates", []) if isinstance(entry, dict)}
        if isinstance(amount, int) and 0 < amount <= 9_999_999 and amount in candidates:
            result.setdefault("vision_candidates", {})["total_amount"] = amount
            if result.get("total_amount") == amount:
                result.setdefault("field_sources", {})["total_amount"] = "paddleocr_rule_vision_agreement"
        return
    date = valid_date(output.get("read_date"))
    time_value = valid_time(output.get("read_time"))
    if date:
        result.setdefault("vision_candidates", {})["paid_at"] = date
    if time_value:
        result.setdefault("vision_candidates", {})["paid_time"] = time_value


def valid_date(value):
    if not isinstance(value, str):
        return None
    try:
        parsed = dt.date.fromisoformat(value)
    except ValueError:
        return None
    return value if parsed <= dt.date.today() + dt.timedelta(days=1) else None


def valid_time(value):
    if not isinstance(value, str) or not re.fullmatch(r"\d{2}:\d{2}", value):
        return None
    hour, minute = map(int, value.split(":"))
    return value if 0 <= hour <= 23 and 0 <= minute <= 59 else None


def ollama_generate(model, prompt, timeout, images=None):
    body = {"model": model, "prompt": prompt, "stream": False, "format": "json", "keep_alive": OLLAMA_KEEP_ALIVE, "options": {"temperature": 0, "num_ctx": 2048, "num_predict": 160}}
    if images:
        body["images"] = images
    request = urllib.request.Request(f"{OLLAMA_URL}/api/generate", data=json.dumps(body).encode("utf-8"), headers={"content-type": "application/json"}, method="POST")
    with urllib.request.urlopen(request, timeout=timeout) as response:
        payload = json.loads(response.read().decode("utf-8"))
    text = payload.get("response")
    if not isinstance(text, str) or len(text) > 20_000:
        raise ValueError("invalid Ollama response")
    parsed = json.loads(text)
    if not isinstance(parsed, dict):
        raise ValueError("invalid Ollama JSON")
    return parsed
