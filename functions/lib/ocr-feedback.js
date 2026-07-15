import { ApiError } from "./responses.js";

const FIELD_NAMES = new Set(["store_name", "total_amount", "paid_at", "paid_time", "item_name", "item_amount"]);
const NUMERIC_FIELDS = new Set(["total_amount", "item_amount"]);
const MAX_FIELDS = 84;
const MAX_FEEDBACK_BYTES = 32 * 1024;
const encoder = new TextEncoder();

export async function registerOcrCorrections(db, user, input, claims, timestamp = new Date().toISOString()) {
  assertObject(input);
  assertAllowed(input, ["transaction_id", "feedback_token", "confirmed"]);
  const transactionId = patternText(input.transaction_id, "transaction_id", /^[A-Za-z0-9_.:-]{1,128}$/u);
  const transaction = await db.prepare("SELECT id, project_id FROM transactions WHERE id = ?").bind(transactionId).first();
  if (!transaction || transaction.project_id !== claims.project_id) throw new ApiError(404, "not_found");
  const confirmed = confirmedValues(input.confirmed);
  const records = compareSignedValues(claims, confirmed);
  if (records.length === 0) throw new ApiError(400, "empty_ocr_feedback");

  const outcomeStatements = records.map((record) => db.prepare(`INSERT INTO receipt_ocr_field_outcomes (
    id, user_id, transaction_id, ocr_result_id, field_name, source_id, ocr_model,
    preprocessing, confidence, was_corrected, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(user_id, ocr_result_id, field_name, source_id) DO NOTHING`).bind(
    `ocro_${crypto.randomUUID()}`, user.id, transactionId, claims.ocr_result_id,
    record.field_name, record.source_id, claims.ocr_model, record.preprocessing,
    record.confidence, record.was_corrected ? 1 : 0, timestamp,
  ));
  const corrected = records.filter((record) => record.was_corrected);
  const correctionStatements = corrected.map((record) => db.prepare(`INSERT INTO receipt_ocr_correction_events (
    id, user_id, transaction_id, ocr_result_id, field_name, source_id, original_value,
    corrected_value, normalized_original_value, normalized_corrected_value, ocr_model,
    preprocessing, confidence, bounding_box_json, source_text, correction_source, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'user_confirmed', ?)
  ON CONFLICT(user_id, ocr_result_id, field_name, source_id) DO NOTHING`).bind(
    `ocrc_${crypto.randomUUID()}`, user.id, transactionId, claims.ocr_result_id,
    record.field_name, record.source_id, record.original_value, record.corrected_value,
    record.normalized_original_value, record.normalized_corrected_value, claims.ocr_model,
    record.preprocessing, record.confidence, record.bounding_box_json, record.source_text, timestamp,
  ));
  const results = await db.batch([...outcomeStatements, ...correctionStatements]);
  return {
    accepted_outcomes: changedCount(results.slice(0, outcomeStatements.length)),
    accepted_events: changedCount(results.slice(outcomeStatements.length)),
  };
}

export function validateConfirmedOcrValues(value) {
  return confirmedValues(value);
}

export async function countOcrCorrections(db, user) {
  const row = await db.prepare(`SELECT COUNT(*) AS correction_count, MAX(created_at) AS last_created_at
    FROM receipt_ocr_correction_events WHERE user_id = ?`).bind(user.id).first();
  return { correction_count: Number(row?.correction_count || 0), last_created_at: row?.last_created_at || null };
}

export async function deleteOcrCorrections(db, user) {
  const results = await db.batch([
    db.prepare("DELETE FROM receipt_ocr_correction_events WHERE user_id = ?").bind(user.id),
    db.prepare("DELETE FROM receipt_ocr_field_outcomes WHERE user_id = ?").bind(user.id),
  ]);
  return { deleted_corrections: resultChanges(results[0]), deleted_outcomes: resultChanges(results[1]) };
}

export async function buildReceiptFeedback(db, userId) {
  if (!userId) return emptyFeedback();
  const [correctionResult, statsResult] = await Promise.all([
    db.prepare(`SELECT normalized_original_value AS original, corrected_value AS corrected, COUNT(*) AS count
      FROM receipt_ocr_correction_events
      WHERE user_id = ? AND field_name = 'store_name'
      GROUP BY normalized_original_value, corrected_value
      ORDER BY count DESC, MAX(created_at) DESC LIMIT 20`).bind(userId).all(),
    db.prepare(`SELECT field_name, ocr_model, preprocessing, COUNT(*) AS confirmed_count,
        SUM(CASE WHEN was_corrected = 0 THEN 1 ELSE 0 END) AS correct_count,
        SUM(CASE WHEN was_corrected = 1 THEN 1 ELSE 0 END) AS corrected_count
      FROM receipt_ocr_field_outcomes
      WHERE user_id = ?
      GROUP BY field_name, ocr_model, preprocessing
      HAVING COUNT(*) >= 5
      ORDER BY field_name, confirmed_count DESC LIMIT 30`).bind(userId).all(),
  ]);
  const storeCorrections = rows(correctionResult).map((row) => ({
    original: boundedText(row.original, 200),
    corrected: boundedText(row.corrected, 200),
    count: boundedInteger(row.count, 1, 1_000_000),
  })).filter((row) => row.original && row.corrected && row.original !== normalizeOcrValue(row.corrected, "store_name"));
  const feedback = {
    version: 1,
    store_corrections: storeCorrections,
    character_confusions: collectCharacterConfusions(storeCorrections).slice(0, 30),
    preprocessing_stats: rows(statsResult).map((row) => ({
      field_name: FIELD_NAMES.has(row.field_name) ? row.field_name : "",
      ocr_model: boundedText(row.ocr_model, 100),
      preprocessing: boundedText(row.preprocessing, 100),
      confirmed_count: boundedInteger(row.confirmed_count, 0, 1_000_000),
      correct_count: boundedInteger(row.correct_count, 0, 1_000_000),
      corrected_count: boundedInteger(row.corrected_count, 0, 1_000_000),
    })).filter((row) => row.field_name && row.ocr_model && row.preprocessing),
  };
  return encoder.encode(JSON.stringify(feedback)).byteLength <= MAX_FEEDBACK_BYTES ? feedback : emptyFeedback();
}

export function normalizeOcrValue(value, fieldName) {
  const text = String(value ?? "").normalize("NFKC").replace(/[\u0000-\u001f\u007f]/gu, "").trim();
  if (NUMERIC_FIELDS.has(fieldName)) return text.replace(/[^0-9-]/gu, "");
  return text.replace(/[‐‑‒–—―]/gu, "-").replace(/\s+/gu, " ").toLocaleLowerCase("ja-JP");
}

export function storeCorrectionCandidates(currentValue, feedback) {
  const current = normalizeOcrValue(currentValue, "store_name");
  if (!current || !Array.isArray(feedback?.store_corrections)) return [];
  return feedback.store_corrections.map((entry) => {
    const original = normalizeOcrValue(entry?.original, "store_name");
    const corrected = boundedText(entry?.corrected, 200);
    const count = boundedInteger(entry?.count, 0, 1_000_000);
    return { original, corrected, count, similarity: stringSimilarity(current, original) };
  }).filter((entry) => entry.original && entry.corrected && entry.similarity >= 0.72)
    .sort((left, right) => right.similarity - left.similarity || right.count - left.count).slice(0, 5);
}

export function stringSimilarity(left, right) {
  const a = Array.from(String(left || ""));
  const b = Array.from(String(right || ""));
  if (a.length === 0 || b.length === 0) return 0;
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const above = previous[j];
      previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return 1 - previous[b.length] / Math.max(a.length, b.length);
}

function compareSignedValues(claims, confirmed) {
  const records = [];
  for (const fieldName of ["store_name", "total_amount", "paid_at", "paid_time"]) {
    const signed = claims.original[fieldName];
    if (!signed || confirmed[fieldName] == null || confirmed[fieldName] === "") continue;
    records.push(comparisonRecord(fieldName, "root", signed.value, confirmed[fieldName], signed.evidence));
  }
  const confirmedItems = new Map(confirmed.items.map((item) => [item.source_id, item]));
  for (const original of Array.isArray(claims.original.items) ? claims.original.items : []) {
    const item = confirmedItems.get(original.source_id);
    if (!item) continue;
    records.push(comparisonRecord("item_name", original.source_id, original.name, item.name, {}));
    records.push(comparisonRecord("item_amount", original.source_id, original.amount, item.amount, {}));
  }
  if (records.length > MAX_FIELDS) throw new ApiError(400, "too_many_ocr_feedback_fields");
  return records;
}

function comparisonRecord(fieldName, sourceId, originalValue, correctedValue, evidence) {
  const original = originalValue == null || originalValue === "" ? "" : fieldValue(originalValue, fieldName, "original_value");
  const corrected = fieldValue(correctedValue, fieldName, "corrected_value");
  const normalizedOriginal = normalizeOcrValue(original, fieldName);
  const normalizedCorrected = normalizeOcrValue(corrected, fieldName);
  const box = evidence?.bounding_box == null ? null : boundingBox(evidence.bounding_box);
  return {
    field_name: fieldName,
    source_id: patternText(sourceId || "root", "source_id", /^[A-Za-z0-9_.:-]{1,64}$/u),
    original_value: original,
    corrected_value: corrected,
    normalized_original_value: normalizedOriginal,
    normalized_corrected_value: normalizedCorrected,
    preprocessing: textValue(evidence?.preprocessing || "default", "preprocessing", 100),
    confidence: numberValue(evidence?.confidence ?? 0, "confidence", 0, 1),
    bounding_box_json: box ? JSON.stringify(box) : null,
    source_text: evidence?.source_text ? textValue(evidence.source_text, "source_text", 500) : null,
    was_corrected: normalizedOriginal !== normalizedCorrected,
  };
}

function confirmedValues(value) {
  assertObject(value);
  assertAllowed(value, ["store_name", "total_amount", "paid_at", "paid_time", "items"]);
  const result = {
    store_name: value.store_name == null ? null : textValue(value.store_name, "store_name", 200),
    total_amount: value.total_amount == null ? null : positiveInteger(value.total_amount, "total_amount"),
    paid_at: value.paid_at == null ? null : dateValue(value.paid_at),
    paid_time: value.paid_time == null ? null : timeValue(value.paid_time),
    items: [],
  };
  if (value.items != null) {
    if (!Array.isArray(value.items) || value.items.length > 40) throw new ApiError(400, "invalid_items");
    result.items = value.items.map((item) => {
      assertObject(item);
      assertAllowed(item, ["source_id", "name", "amount"]);
      return {
        source_id: patternText(item.source_id, "source_id", /^[A-Za-z0-9_.:-]{1,64}$/u),
        name: textValue(item.name, "item_name", 200),
        amount: positiveInteger(item.amount, "item_amount"),
      };
    });
  }
  return result;
}

function collectCharacterConfusions(corrections) {
  const counts = new Map();
  for (const entry of corrections) {
    const original = Array.from(entry.original);
    const corrected = Array.from(entry.corrected);
    if (original.length !== corrected.length) continue;
    for (let index = 0; index < original.length; index += 1) {
      if (original[index] === corrected[index]) continue;
      const key = `${original[index]}\u0000${corrected[index]}`;
      counts.set(key, (counts.get(key) || 0) + entry.count);
    }
  }
  return [...counts.entries()].map(([key, count]) => {
    const [observed, confirmed] = key.split("\u0000");
    return { observed, confirmed, count };
  }).sort((left, right) => right.count - left.count);
}

function fieldValue(value, fieldName, name) {
  if (NUMERIC_FIELDS.has(fieldName)) return String(positiveInteger(value, name));
  if (fieldName === "paid_at") return dateValue(value);
  if (fieldName === "paid_time") return timeValue(value);
  return textValue(value, name, 200);
}

function dateValue(value) {
  const text = textValue(value, "paid_at", 10);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) throw new ApiError(400, "invalid_paid_at");
  const [year, month, day] = text.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) throw new ApiError(400, "invalid_paid_at");
  return text;
}

function timeValue(value) {
  const text = textValue(value, "paid_time", 5);
  const match = /^(\d{2}):(\d{2})$/u.exec(text);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) throw new ApiError(400, "invalid_paid_time");
  return text;
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0 || number > 9_999_999) throw new ApiError(400, `invalid_${name}`);
  return number;
}

function boundingBox(value) {
  if (!Array.isArray(value) || value.length !== 4) throw new ApiError(400, "invalid_bounding_box");
  const result = value.map((entry) => numberValue(entry, "bounding_box", 0, 1));
  if (result[0] > result[2] || result[1] > result[3]) throw new ApiError(400, "invalid_bounding_box");
  return result;
}

function emptyFeedback() {
  return { version: 1, store_corrections: [], character_confusions: [], preprocessing_stats: [] };
}

function rows(result) { return Array.isArray(result?.results) ? result.results : []; }
function changedCount(results) { return results.reduce((sum, result) => sum + resultChanges(result), 0); }
function resultChanges(result) { return Number(result?.meta?.changes ?? result?.changes ?? result?.meta?.rows_written ?? 0); }

function assertObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(400, "invalid_request");
}

function assertAllowed(value, allowed) {
  const fields = new Set(allowed);
  const invalid = Object.keys(value).find((key) => !fields.has(key));
  if (invalid) throw new ApiError(400, "invalid_field", { field: invalid });
}

function textValue(value, name, maximum) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) throw new ApiError(400, `invalid_${name}`);
  return value.trim();
}

function patternText(value, name, pattern) {
  const text = textValue(value, name, 128);
  if (!pattern.test(text)) throw new ApiError(400, `invalid_${name}`);
  return text;
}

function numberValue(value, name, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) throw new ApiError(400, `invalid_${name}`);
  return number;
}

function boundedText(value, maximum) { return typeof value === "string" && value.length <= maximum ? value : ""; }
function boundedInteger(value, minimum, maximum) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= minimum && number <= maximum ? number : minimum;
}
