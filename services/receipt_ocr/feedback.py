import os
import re
import unicodedata


def apply_feedback(result, feedback):
    result = dict(result)
    result.setdefault("field_sources", {
        "store_name": "paddleocr_rule",
        "total_amount": "paddleocr_rule",
        "paid_at": "paddleocr_rule",
        "paid_time": "paddleocr_rule",
    })
    result.setdefault("corrections", [])
    result.setdefault("fallbacks", {
        "past_feedback_used": False,
        "text_llm_used": False,
        "vision_reread_used": False,
        "vision_regions": [],
    })
    if not feature_enabled("RECEIPT_OCR_ENABLE_FEEDBACK"):
        return result
    current = result.get("store_name")
    candidates = store_correction_candidates(current, feedback)
    if not candidates:
        return result
    result["store_name_candidates"] = candidates
    exact = [entry for entry in candidates if entry["similarity"] == 1.0 and entry["count"] >= 2]
    corrected_values = {entry["corrected"] for entry in exact}
    confidence = float(result.get("field_confidence", {}).get("store_name", 0.0))
    if len(corrected_values) != 1 or confidence < 0.6:
        result["needs_review"] = True
        return result
    corrected = next(iter(corrected_values))
    if digits(current) != digits(corrected):
        result["needs_review"] = True
        return result
    result["store_name"] = corrected
    result["field_sources"]["store_name"] = "past_user_correction"
    result["corrections"].append({
        "field": "store_name",
        "original": current,
        "corrected": corrected,
        "source": "past_user_correction",
    })
    result["fallbacks"]["past_feedback_used"] = True
    return result


def store_correction_candidates(current, feedback):
    normalized = normalize_store(current)
    if not normalized or not isinstance(feedback, dict):
        return []
    entries = feedback.get("store_corrections")
    if not isinstance(entries, list):
        return []
    candidates = []
    for entry in entries[:20]:
        if not isinstance(entry, dict):
            continue
        original = normalize_store(entry.get("original"))
        corrected = bounded_text(entry.get("corrected"), 200)
        count = entry.get("count")
        if not original or not corrected or not isinstance(count, int) or not 1 <= count <= 1_000_000:
            continue
        similarity = string_similarity(normalized, original)
        if similarity >= 0.72:
            candidates.append({
                "original": original,
                "corrected": corrected,
                "count": count,
                "similarity": round(similarity, 3),
            })
    return sorted(candidates, key=lambda entry: (-entry["similarity"], -entry["count"]))[:5]


def preprocessing_order(feedback, field_name, model, default_order):
    if not feature_enabled("RECEIPT_OCR_ENABLE_FEEDBACK"):
        return list(default_order)
    if not isinstance(feedback, dict) or not isinstance(feedback.get("preprocessing_stats"), list):
        return list(default_order)
    scores = {}
    for entry in feedback["preprocessing_stats"][:30]:
        if not isinstance(entry, dict) or entry.get("field_name") != field_name or entry.get("ocr_model") != model:
            continue
        confirmed = entry.get("confirmed_count")
        correct = entry.get("correct_count")
        if not isinstance(confirmed, int) or not isinstance(correct, int) or confirmed < 5 or correct < 0:
            continue
        scores[entry.get("preprocessing")] = (correct + 1) / (confirmed + 2)
    indexed = {name: index for index, name in enumerate(default_order)}
    return sorted(default_order, key=lambda name: (-scores.get(name, -1), indexed[name]))


def normalize_store(value):
    text = unicodedata.normalize("NFKC", str(value or ""))
    text = re.sub(r"[\x00-\x1f\x7f]", "", text).strip().lower()
    text = re.sub(r"[‐‑‒–—―]", "-", text)
    return re.sub(r"\s+", " ", text)


def string_similarity(left, right):
    if not left or not right:
        return 0.0
    previous = list(range(len(right) + 1))
    for index, left_char in enumerate(left, 1):
        current = [index]
        for other_index, right_char in enumerate(right, 1):
            current.append(min(
                current[-1] + 1,
                previous[other_index] + 1,
                previous[other_index - 1] + (left_char != right_char),
            ))
        previous = current
    return 1.0 - previous[-1] / max(len(left), len(right))


def digits(value):
    return "".join(re.findall(r"\d", str(value or "")))


def bounded_text(value, maximum):
    return value.strip() if isinstance(value, str) and 0 < len(value.strip()) <= maximum else ""


def feature_enabled(name, legacy_name=None):
    value = os.environ.get(name)
    if value is None and legacy_name:
        value = os.environ.get(legacy_name)
    return str(value or "").lower() in ("1", "true", "yes")
