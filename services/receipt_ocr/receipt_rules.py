"""Receipt field extraction rules shared by local OCR backends."""

import datetime as dt
import os
import re
from dataclasses import dataclass, asdict


REVIEW_THRESHOLD = float(os.environ.get("RECEIPT_OCR_REVIEW_THRESHOLD", "0.68"))
AMOUNT_TOLERANCE = int(os.environ.get("RECEIPT_OCR_AMOUNT_TOLERANCE", "1"))

TOTAL_LABELS = ("合計", "総合計", "税込合計", "お買上計", "ご請求額", "今回合計")
SUBTOTAL_LABELS = ("小計", "商品合計", "税抜合計")
TAX_LABELS = ("消費税", "内税", "外税", "税額")
DISCOUNT_LABELS = ("値引", "割引", "クーポン", "奉仕")
DEPOSIT_LABELS = ("お預り", "お預かり", "預り", "受取")
CHANGE_LABELS = ("お釣", "釣銭", "お返し")
PAYMENT_LABELS = ("支払", "クレジット", "カード", "電子マネー", "PayPay", "VISA")
EXCLUDED_AMOUNT_LABELS = ("ポイント", "残高", "会員番号", "会員No", "単価", "電話", "TEL", "FAX", "登録番号", "伝票番号", "レシート番号")
EXCLUDED_DATE_LABELS = ("有効期限", "賞味期限", "消費期限", "使用期限", "カード期限", "会員期限")
NON_ITEM_LABELS = TOTAL_LABELS + SUBTOTAL_LABELS + TAX_LABELS + DISCOUNT_LABELS + DEPOSIT_LABELS + CHANGE_LABELS + PAYMENT_LABELS + EXCLUDED_AMOUNT_LABELS


@dataclass(frozen=True)
class AmountCandidate:
    value: int
    kind: str
    source_index: int
    text: str
    confidence: float
    x: float
    y: float
    score: float = 0.0

    def public(self):
        return asdict(self)


def parse_receipt(lines):
    lines = sorted(lines, key=lambda line: (line.y, line.x))
    warnings = []
    candidates = extract_amount_candidates(lines, warnings)
    validations = validate_amounts(candidates, lines)
    ranked = score_candidates(candidates, validations, lines)
    total = select_amount(ranked, "total")
    subtotal = select_amount(ranked, "subtotal")
    tax = select_amount(ranked, "tax")
    paid_at, paid_time, date_warning = guess_datetime("\n".join(line.text for line in lines))
    if date_warning:
        warnings.append(date_warning)
    items = guess_items(lines)
    store_name = guess_store_name(lines)
    field_evidence = build_field_evidence(lines, store_name, total, subtotal, tax, paid_at, paid_time)
    field_confidence = field_confidences(store_name, total, subtotal, paid_at, paid_time, items, validations, field_evidence)
    priority_scores = [field_confidence[field] for field in ("store_name", "total_amount", "paid_at", "paid_time")]
    confidence = round(sum(priority_scores) / len(priority_scores), 3)
    if total is None:
        warnings.append("合計金額を特定できませんでした。")
    if validations["deposit_change_total"] is False:
        warnings.append("預り金・お釣り・合計の計算が一致しません。")
    if validations["subtotal_tax_discount_total"] is False:
        warnings.append("小計・税額・値引・合計の計算が一致しません。")
    if validations["item_sum_total"] is False:
        warnings.append("品目合計と合計金額が一致しません。")
    total_has_independent_evidence = bool(total and total.kind == "total" and any(value is True for value in validations.values()))
    if total is not None and not total_has_independent_evidence:
        warnings.append("合計金額を独立した根拠で確認できませんでした。")
    priority_fields_ready = bool(store_name) and bool(total and total.value > 0) and bool(paid_at) and bool(paid_time)
    needs_review = not priority_fields_ready or not total_has_independent_evidence or confidence < REVIEW_THRESHOLD or bool(warnings)
    notes = " ".join(warnings)
    result = {
        "store_name": store_name,
        "total_amount": total.value if total else None,
        "subtotal_amount": subtotal.value if subtotal else None,
        "tax_amount": tax.value if tax else None,
        "paid_at": paid_at,
        "paid_time": paid_time,
        "items": items,
        "confidence": confidence,
        "field_confidence": field_confidence,
        "field_evidence": field_evidence,
        "field_sources": {
            "store_name": "paddleocr_rule",
            "total_amount": "paddleocr_rule",
            "paid_at": "paddleocr_rule",
            "paid_time": "paddleocr_rule",
        },
        "total_candidates": [amount_candidate_evidence(candidate, lines) for candidate in ranked if candidate.kind in ("total", "subtotal", "tax", "discount", "deposit", "change", "unknown")][:20],
        "needs_review": needs_review,
        "warnings": warnings,
        "validations": validations,
        "notes": notes,
    }
    if debug_output_enabled():
        result["amount_candidates"] = [candidate.public() for candidate in ranked]
    return result


def debug_output_enabled():
    return os.environ.get("OCR_DEBUG_OUTPUT", "").lower() in ("1", "true", "yes")


def extract_amount_candidates(lines, warnings):
    candidates = []
    correction_warnings = set()
    for index, line in enumerate(lines):
        row = row_text(lines, line)
        if contains_any(row, EXCLUDED_AMOUNT_LABELS):
            continue
        kind = classify_amount_row(row)
        product_code_spans = product_code_ranges(row)
        for match in re.finditer(r"(?:[¥￥]\s*)?([0-9OIl]{1,3}(?:,[0-9OIl]{3})+|[0-9OIl]{2,7})", row):
            raw = match.group(1)
            if any(start <= match.start(1) < end for start, end in product_code_spans):
                continue
            normalized = normalize_amount_token(raw)
            if normalized is None:
                continue
            value, corrected = normalized
            if corrected:
                correction_warnings.add(f"金額候補 {raw} を {value:,} 円として扱いました。")
            if is_identifier_row(row, value):
                continue
            candidate_kind = "item" if kind == "unknown" and product_code_spans else kind
            candidates.append(AmountCandidate(value, candidate_kind, index, row, float(line.confidence), float(line.x), float(line.y)))
    warnings.extend(sorted(correction_warnings))
    return unique_candidates(candidates)


def normalize_amount_token(raw):
    raw = raw.strip()
    corrected = bool(re.search(r"[OIl]", raw))
    normalized = raw.translate(str.maketrans({"O": "0", "I": "1", "l": "1"})).replace(",", "")
    if not normalized.isdigit():
        return None
    value = int(normalized)
    if not 1 <= value <= 9_999_999:
        return None
    return value, corrected


def is_identifier_row(text, value):
    if re.search(r"(?:TEL|FAX|電話|登録番号|適格請求書|No\.?|http|www)", text, re.I):
        return True
    if re.search(r"\d{4}[/-]\d{1,2}[/-]\d{1,2}|\d{4}年\d{1,2}月\d{1,2}日", text):
        return True
    return value >= 100000 and re.search(r"[A-Z]\d{8,}|\d{10,}", text)


def product_code_ranges(text):
    return [match.span(1) for match in re.finditer(r"(?<!\d)(\d{5,8})(?=\s*[*＊])", text)]


def classify_amount_row(text):
    text = re.sub(r"\s+", "", text)
    if contains_any(text, DEPOSIT_LABELS):
        return "deposit"
    if contains_any(text, CHANGE_LABELS):
        return "change"
    if contains_any(text, DISCOUNT_LABELS):
        return "discount"
    if contains_any(text, TAX_LABELS):
        return "tax"
    if contains_any(text, SUBTOTAL_LABELS):
        return "subtotal"
    if contains_any(text, TOTAL_LABELS):
        return "total"
    return "unknown"


def contains_any(text, labels):
    lowered = text.lower()
    return any(label.lower() in lowered for label in labels)


def unique_candidates(candidates):
    seen = set()
    result = []
    for candidate in candidates:
        key = (candidate.value, candidate.kind, round(candidate.y / 8))
        if key not in seen:
            seen.add(key)
            result.append(candidate)
    return result


def validate_amounts(candidates, lines):
    by_kind = group_by_kind(candidates)
    total = best_labeled(by_kind["total"])
    subtotal = best_labeled(by_kind["subtotal"])
    tax = best_labeled(by_kind["tax"])
    discount = best_labeled(by_kind["discount"])
    deposit = best_labeled(by_kind["deposit"])
    change = best_labeled(by_kind["change"])
    item_sum = sum(item["amount"] for item in guess_items(lines))
    return {
        "deposit_change_total": matches(deposit.value - change.value, total.value) if deposit and change and total else None,
        "subtotal_tax_discount_total": matches(subtotal.value + (tax.value if tax else 0) - (discount.value if discount else 0), total.value) if subtotal and total else None,
        "item_sum_total": matches(item_sum, total.value) if item_sum and total else None,
    }


def matches(left, right):
    return abs(left - right) <= AMOUNT_TOLERANCE


def group_by_kind(candidates):
    result = {kind: [] for kind in ("total", "subtotal", "tax", "discount", "deposit", "change", "item", "unknown")}
    for candidate in candidates:
        result[candidate.kind].append(candidate)
    return result


def best_labeled(candidates):
    return max(candidates, key=lambda candidate: candidate.confidence, default=None)


def score_candidates(candidates, validations, lines):
    scored = []
    for candidate in candidates:
        score = min(max(candidate.confidence, 0.0), 1.0) * 0.5
        if candidate.kind == "total":
            score += 0.32
            if validations["deposit_change_total"] is True:
                score += 0.1
            if validations["subtotal_tax_discount_total"] is True:
                score += 0.08
            if validations["item_sum_total"] is True:
                score += 0.05
        elif candidate.kind == "subtotal":
            score += 0.28
        elif candidate.kind in ("tax", "discount", "deposit", "change"):
            score += 0.2
        elif candidate.value > 0:
            score += 0.04
        scored.append(AmountCandidate(**{**candidate.public(), "score": round(min(score, 0.99), 3)}))
    return sorted(scored, key=lambda candidate: candidate.score, reverse=True)


def select_amount(candidates, kind):
    matches_for_kind = [candidate for candidate in candidates if candidate.kind == kind]
    if matches_for_kind:
        return matches_for_kind[0]
    return None


def field_confidences(store_name, total, subtotal, paid_at, paid_time, items, validations, evidence):
    total_score = total.score if total else 0.0
    if validations["deposit_change_total"] is False or validations["subtotal_tax_discount_total"] is False:
        total_score *= 0.65
    return {
        "store_name": round(evidence.get("store_name", {}).get("confidence", 0.0) if store_name else 0.0, 3),
        "total_amount": round(total_score, 3),
        "subtotal_amount": round(subtotal.score if subtotal else 0.0, 3),
        "paid_at": 0.85 if paid_at else 0.0,
        "paid_time": 0.85 if paid_time else 0.0,
        "items": round(min(0.9, 0.2 + len(items) * 0.12), 3),
    }


def build_field_evidence(lines, store_name, total, subtotal, tax, paid_at, paid_time):
    evidence = {}
    store_lines = matching_store_lines(lines, store_name)
    if store_lines:
        evidence["store_name"] = lines_evidence("store_name", store_name, store_lines, "store_region", "store_rule")
    for field, candidate in (("total_amount", total), ("subtotal_amount", subtotal), ("tax_amount", tax)):
        if candidate is not None and 0 <= candidate.source_index < len(lines):
            evidence[field] = lines_evidence(field, candidate.value, [lines[candidate.source_index]], candidate.kind, "label_and_rule_score")
    date_lines = [line for line in lines if re.search(r"20\d{2}.?\d{1,2}.?\d{1,2}|R\s*\d{1,2}.?\d{1,2}.?\d{1,2}|\d{1,2}[:：]\d{2}", line.text, re.I)]
    if paid_at and date_lines:
        evidence["paid_at"] = lines_evidence("paid_at", paid_at, [date_lines[0]], "datetime", "valid_date_pattern")
    if paid_time and date_lines:
        evidence["paid_time"] = lines_evidence("paid_time", paid_time, [date_lines[0]], "datetime", "valid_time_pattern")
    return evidence


def matching_store_lines(lines, store_name):
    if not store_name:
        return []
    compact = re.sub(r"\s+", "", store_name)
    matches = []
    for line in lines[:12]:
        text = re.sub(r"\s+", "", line.text)
        if text and len(text) >= 2 and (text in compact or compact in text):
            matches.append(line)
    return matches


def lines_evidence(field, value, source_lines, candidate_type, selection_reason):
    left = min(line.x for line in source_lines)
    top = min(line.y for line in source_lines)
    right = max(line.x + line.w for line in source_lines)
    bottom = max(line.y + line.h for line in source_lines)
    width = max(1.0, max(float(getattr(line, "image_width", line.x + line.w or 1.0)) for line in source_lines))
    height = max(1.0, max(float(getattr(line, "image_height", line.y + line.h or 1.0)) for line in source_lines))
    return {
        "field": field,
        "value": value,
        "source_text": " ".join(line.text for line in source_lines)[:500],
        "source_line_ids": [getattr(line, "source_id", "") or str(index) for index, line in enumerate(source_lines)],
        "source_id": getattr(source_lines[0], "source_id", "") or "0",
        "bounding_box": [round(max(0.0, min(1.0, left / width)), 5), round(max(0.0, min(1.0, top / height)), 5), round(max(0.0, min(1.0, right / width)), 5), round(max(0.0, min(1.0, bottom / height)), 5)],
        "confidence": round(sum(float(line.confidence) for line in source_lines) / len(source_lines), 3),
        "ocr_model": os.environ.get("LOCAL_OCR_REC_MODEL", "PP-OCRv6_small_rec"),
        "preprocessing": getattr(source_lines[0], "preprocessing", "default"),
        "candidate_type": candidate_type,
        "selection_reason": selection_reason,
    }


def amount_candidate_evidence(candidate, lines):
    result = candidate.public()
    if 0 <= candidate.source_index < len(lines):
        evidence = lines_evidence("total_amount", candidate.value, [lines[candidate.source_index]], candidate.kind, "amount_candidate")
        result.update({key: evidence[key] for key in ("source_line_ids", "source_id", "bounding_box", "ocr_model", "preprocessing")})
    return result


def guess_datetime(text):
    text = text.replace("令和", "R").replace("平成", "H")
    patterns = (
        r"(20\d{2})年\s*(\d{1,2})月\s*(\d{1,2})日(?:\([^)]*\))?\s*(\d{1,2})[:：](\d{2})",
        r"(20\d{2})[/-](\d{1,2})[/-](\d{1,2})\s*(\d{1,2})[:：](\d{2})",
        r"(20\d{2})年\s*(\d{1,2})月\s*(\d{1,2})日",
        r"(20\d{2})[/-](\d{1,2})[/-](\d{1,2})",
        r"R\s*(\d{1,2})[年./-]\s*(\d{1,2})[月./-]\s*(\d{1,2})日?",
    )
    for row in text.splitlines():
        if contains_any(row, EXCLUDED_DATE_LABELS):
            continue
        for pattern in patterns:
            match = re.search(pattern, row, re.I)
            if not match:
                continue
            year, month, day = (int(match.group(i)) for i in range(1, 4))
            if pattern.startswith("R"):
                year += 2018
            try:
                parsed_date = dt.date(year, month, day)
            except ValueError:
                return None, None, "日付として成立しない値を読み取りました。"
            if parsed_date > dt.date.today():
                return None, None, "未来の日付を読み取りました。"
            date = parsed_date.isoformat()
            if match.lastindex and match.lastindex >= 5:
                hour, minute = int(match.group(4)), int(match.group(5))
                if hour <= 23 and minute <= 59:
                    return date, f"{hour:02d}:{minute:02d}", None
                return date, None, "時刻として成立しない値を読み取りました。"
            return date, None, None
    return None, None, None


def row_text(lines, target):
    heights = sorted(max(1.0, line.h) for line in lines)
    median_height = heights[len(heights) // 2] if heights else 10
    tolerance = max(4.0, median_height * 0.45)
    target_center = target.y + target.h / 2
    row = [line for line in lines if abs((line.y + line.h / 2) - target_center) <= tolerance]
    return " ".join(line.text for line in sorted(row, key=lambda line: line.x))


def guess_store_name(lines):
    for index, line in enumerate(lines[:12]):
        match = re.search(r"([^\s\d]{2,}店)", line.text)
        if not match:
            continue
        location = match.group(1)
        brands = [candidate.text.strip() for candidate in lines[max(0, index - 4) : index] if 2 <= len(candidate.text.strip()) <= 24 and not re.search(r"\d|TEL|FAX", candidate.text, re.I) and (re.search(r"[\u3040-\u30ff\u3400-\u9fff]", candidate.text) or len(candidate.text.strip()) >= 4)]
        if brands:
            return f"{brands[-1]} {location}"
        return location
    candidates = []
    for line in lines[:10]:
        text = line.text.strip()
        if len(text) < 2 or re.search(r"\d{2,}|TEL|FAX|登録番号|領収|レシート|www|http", text, re.I):
            continue
        candidates.append(line)
    if not candidates:
        return None
    return max(candidates, key=lambda line: line.w * line.h * max(line.confidence, 0.1)).text


def guess_items(lines):
    stop_y = next((line.y for line in lines if contains_any(row_text(lines, line), TOTAL_LABELS)), float("inf"))
    items = []
    processed_rows = set()
    for index, line in enumerate(lines):
        row = row_text(lines, line)
        row_key = round((line.y + line.h / 2) / max(6, line.h * 0.45))
        if row_key in processed_rows:
            continue
        processed_rows.add(row_key)
        if line.y >= stop_y or contains_any(row, NON_ITEM_LABELS) or is_identifier_row(row, 0):
            continue
        amounts = [token[0] for token in (normalize_amount_token(raw) for raw in re.findall(r"(?:[¥￥]\s*)?([0-9OIl]{1,3}(?:,[0-9OIl]{3})+|[0-9OIl]{2,7})", row)) if token]
        name = re.sub(r"(?:[¥￥]\s*)?[0-9OIl]{1,3}(?:,[0-9OIl]{3})+|(?:[¥￥]\s*)?[0-9OIl]{2,7}", "", row).strip(" ※*＊")
        if amounts and len(name) >= 2:
            items.append({"name": name, "amount": amounts[-1], "source_index": index})
    return [{"name": item["name"], "amount": item["amount"]} for item in items[:30]]
