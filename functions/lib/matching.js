import {
  isBroadMarketplace,
  normalizeAccountLabel,
  normalizeAmount,
  normalizeDate,
  normalizeMerchantName,
  normalizePaymentMethod,
} from "./normalization.js";

export const MATCH_SCORES = Object.freeze({
  external_transaction_id: 100,
  paid_amount: 45,
  explainable_amount: 20,
  merchant_exact: 30,
  merchant_similar: 15,
  time_1h: 25,
  time_6h: 20,
  time_24h: 10,
  time_3d: 5,
  payment_method: 15,
  account_label: 20,
  complementary_source: 10,
  same_source: -20,
  refund_mismatch: -100,
  ambiguous_confirmed_duplicate: -20,
});

export const MATCH_THRESHOLDS = Object.freeze({
  auto_link: 85,
  review: 55,
  unique_margin: 10,
});

const DAY = 24 * 60 * 60 * 1000;
const CONFIRMED_SOURCES = new Set(["card_csv", "paypay_csv", "bank_csv"]);
const SOURCE_GROUPS = Object.freeze({
  manual: "manual",
  receipt: "receipt",
  gmail_notification: "notification",
  card_csv: "statement",
  paypay_csv: "statement",
  bank_csv: "statement",
});

export const FIELD_SOURCE_PRIORITIES = Object.freeze({
  paid_amount: Object.freeze({ manual: 100, card_csv: 80, paypay_csv: 80, bank_csv: 80, receipt: 60, gmail_notification: 40 }),
  gross_amount: Object.freeze({ manual: 100, receipt: 80, card_csv: 60, paypay_csv: 60, bank_csv: 60, gmail_notification: 40 }),
  status: Object.freeze({ manual: 100, card_csv: 85, bank_csv: 85, paypay_csv: 80, receipt: 55, gmail_notification: 35 }),
  settled_at: Object.freeze({ manual: 100, card_csv: 85, bank_csv: 85, paypay_csv: 80, gmail_notification: 35, receipt: 20 }),
  merchant_name: Object.freeze({ manual: 100, receipt: 80, card_csv: 60, paypay_csv: 60, bank_csv: 60, gmail_notification: 40 }),
  occurred_at: Object.freeze({ manual: 100, receipt: 80, gmail_notification: 65, card_csv: 55, paypay_csv: 55, bank_csv: 55 }),
  transaction_items: Object.freeze({ manual: 100, receipt: 80 }),
  payment_method: Object.freeze({ manual: 100, card_csv: 80, paypay_csv: 80, bank_csv: 80, receipt: 60, gmail_notification: 40 }),
  category: Object.freeze({ manual: 100, receipt: 65, card_csv: 30, paypay_csv: 30, bank_csv: 30, gmail_notification: 20 }),
});

export function getCandidateWindowMs(sourceA, sourceB, options = {}) {
  const a = String(sourceA || "manual");
  const b = String(sourceB || "manual");
  const pair = new Set([a, b]);
  if (pair.has("receipt") && pair.has("gmail_notification")) return options.extended ? DAY : 6 * 60 * 60 * 1000;
  if (pair.has("gmail_notification") && [...pair].some((source) => CONFIRMED_SOURCES.has(source))) return 7 * DAY;
  if (pair.has("receipt") && [...pair].some((source) => CONFIRMED_SOURCES.has(source))) return 7 * DAY;
  if (a === b) return DAY;
  return 7 * DAY;
}

export function scoreMatch(incoming, candidate, context = {}) {
  const reasons = [];
  const strongConditions = [];
  let score = 0;
  const add = (code, points, strong = false) => {
    score += points;
    reasons.push({ code, points });
    if (strong && points > 0) strongConditions.push(code);
  };
  const incomingExternal = textValue(incoming.external_transaction_id ?? incoming.external_payment_id);
  const candidateExternal = textValue(candidate.external_transaction_id ?? candidate.external_payment_id);
  if (incomingExternal && candidateExternal && incomingExternal === candidateExternal) {
    add("external_transaction_id", MATCH_SCORES.external_transaction_id, true);
  }
  const incomingPaid = normalizeAmount(incoming.paid_amount_raw ?? incoming.paid_amount);
  const candidatePaid = normalizeAmount(candidate.paid_amount_raw ?? candidate.paid_amount);
  if (incomingPaid !== null && candidatePaid !== null && incomingPaid === candidatePaid) {
    add("paid_amount", MATCH_SCORES.paid_amount, true);
  } else if (amountRelationshipExplained(incoming, candidate)) {
    add("explainable_amount", MATCH_SCORES.explainable_amount);
  }
  const incomingMerchant = normalizeMerchantName(incoming.merchant_raw ?? incoming.merchant_name ?? incoming.merchant_normalized);
  const candidateMerchant = normalizeMerchantName(candidate.merchant_raw ?? candidate.merchant_name ?? candidate.merchant_normalized);
  if (incomingMerchant && candidateMerchant && incomingMerchant === candidateMerchant) {
    const broad = isBroadMarketplace(incomingMerchant);
    add(broad ? "merchant_broad" : "merchant_exact", broad ? MATCH_SCORES.merchant_similar : MATCH_SCORES.merchant_exact, !broad);
  } else if (merchantSimilarity(incomingMerchant, candidateMerchant) >= 0.72) {
    add("merchant_similar", MATCH_SCORES.merchant_similar);
  }
  const incomingTime = timestamp(incoming.occurred_at_raw ?? incoming.occurred_at);
  const candidateTime = timestamp(candidate.occurred_at_raw ?? candidate.occurred_at);
  if (incomingTime !== null && candidateTime !== null) {
    const difference = Math.abs(incomingTime - candidateTime);
    if (difference <= 60 * 60 * 1000) add("time_1h", MATCH_SCORES.time_1h, true);
    else if (difference <= 6 * 60 * 60 * 1000) add("time_6h", MATCH_SCORES.time_6h, true);
    else if (difference <= DAY) add("time_24h", MATCH_SCORES.time_24h);
    else if (difference <= 3 * DAY) add("time_3d", MATCH_SCORES.time_3d);
  }
  const incomingMethod = normalizePaymentMethod(incoming.payment_method_raw ?? incoming.payment_method);
  const candidateMethod = normalizePaymentMethod(candidate.payment_method_raw ?? candidate.payment_method);
  if (incomingMethod && candidateMethod && incomingMethod === candidateMethod) add("payment_method", MATCH_SCORES.payment_method, true);
  const incomingAccount = normalizeAccountLabel(incoming.account_label);
  const candidateAccount = normalizeAccountLabel(candidate.account_label);
  if (incomingAccount && candidateAccount && incomingAccount === candidateAccount) add("account_label", MATCH_SCORES.account_label, true);
  const incomingSource = String(incoming.source_type || "manual");
  const candidateSource = String(candidate.source_type || context.candidate_source_type || "manual");
  if (incomingSource === candidateSource) add("same_source", MATCH_SCORES.same_source);
  else if (SOURCE_GROUPS[incomingSource] !== SOURCE_GROUPS[candidateSource]) add("complementary_source", MATCH_SCORES.complementary_source);
  if (refundMismatch(incoming, candidate)) add("refund_mismatch", MATCH_SCORES.refund_mismatch);
  if (Number(context.confirmed_same_amount_count || 0) > 1) add("ambiguous_confirmed_duplicate", MATCH_SCORES.ambiguous_confirmed_duplicate);
  return {
    score,
    reasons,
    strong_conditions: strongConditions,
    strong: Boolean(incomingExternal && candidateExternal && incomingExternal === candidateExternal) || strongConditions.length >= 2,
  };
}

export function classifyMatchCandidates(candidates) {
  const sorted = [...(Array.isArray(candidates) ? candidates : [])]
    .map((entry) => entry && typeof entry.score === "number" ? entry : { ...entry, ...scoreMatch(entry.incoming || {}, entry.candidate || entry, entry.context || {}) })
    .sort((left, right) => right.score - left.score);
  const top = sorted[0] || null;
  const runnerUp = sorted[1] || null;
  if (!top || top.score < MATCH_THRESHOLDS.review) return { action: "create", top, candidates: sorted };
  const unique = !runnerUp || top.score - runnerUp.score >= MATCH_THRESHOLDS.unique_margin;
  if (top.score >= MATCH_THRESHOLDS.auto_link && top.strong && unique) return { action: "link", top, candidates: sorted };
  return { action: "review", top, candidates: sorted };
}

export function resolveTransactionFields(existingOrSources, maybeSources) {
  const existing = Array.isArray(existingOrSources) ? {} : { ...(existingOrSources || {}) };
  const sources = Array.isArray(existingOrSources) ? existingOrSources : Array.isArray(maybeSources) ? maybeSources : [];
  const resolved = { ...existing };
  const fieldSources = {};
  for (const field of Object.keys(FIELD_SOURCE_PRIORITIES)) {
    const candidates = sources
      .map((source, index) => ({ source, index, value: fieldValue(source, field), priority: sourcePriority(field, source.source_type) }))
      .filter((entry) => entry.value !== null && entry.value !== undefined && entry.value !== "")
      .sort((left, right) => right.priority - left.priority || right.index - left.index);
    if (!candidates.length) continue;
    resolved[field] = candidates[0].value;
    fieldSources[field] = candidates[0].source.source_type || "manual";
  }
  if (resolved.merchant_name) resolved.merchant_normalized = normalizeMerchantName(resolved.merchant_name);
  return { fields: resolved, field_sources: fieldSources };
}

export function merchantSimilarity(left, right) {
  const a = normalizeMerchantName(left);
  const b = normalizeMerchantName(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const aPairs = bigrams(a);
  const bPairs = bigrams(b);
  if (!aPairs.length || !bPairs.length) return a.includes(b) || b.includes(a) ? 0.75 : 0;
  const remaining = [...bPairs];
  let intersection = 0;
  for (const pair of aPairs) {
    const index = remaining.indexOf(pair);
    if (index < 0) continue;
    intersection += 1;
    remaining.splice(index, 1);
  }
  return (2 * intersection) / (aPairs.length + bPairs.length);
}

function sourcePriority(field, sourceType) {
  return FIELD_SOURCE_PRIORITIES[field]?.[sourceType || "manual"] ?? 0;
}

function fieldValue(source, field) {
  const payload = parsePayload(source.raw_payload);
  if (field === "paid_amount") return normalizeAmount(source.paid_amount ?? source.paid_amount_raw ?? payload.paid_amount ?? payload.total_amount);
  if (field === "gross_amount") return normalizeAmount(source.gross_amount ?? source.gross_amount_raw ?? payload.gross_amount ?? payload.total_amount);
  if (field === "merchant_name") return source.merchant_name ?? source.merchant_raw ?? payload.merchant_name ?? payload.store_name ?? null;
  if (field === "occurred_at") return normalizeDate(source.occurred_at ?? source.occurred_at_raw ?? payload.occurred_at ?? payload.paid_at);
  if (field === "settled_at") return normalizeDate(source.settled_at ?? source.settled_at_raw ?? payload.settled_at);
  if (field === "payment_method") return normalizePaymentMethod(source.payment_method ?? source.payment_method_raw ?? payload.payment_method);
  if (field === "status") return source.status ?? payload.status ?? (CONFIRMED_SOURCES.has(source.source_type) ? "confirmed" : "provisional");
  if (field === "category") return source.category ?? payload.category ?? null;
  if (field === "transaction_items") return source.transaction_items ?? source.items ?? payload.items ?? null;
  return source[field] ?? payload[field] ?? null;
}

function parsePayload(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function textValue(value) {
  return value === null || value === undefined ? "" : String(value).trim().toLowerCase();
}

function timestamp(value) {
  const normalized = normalizeDate(value);
  if (!normalized) return null;
  const time = Date.parse(normalized.length === 10 ? `${normalized}T00:00:00+09:00` : normalized);
  return Number.isFinite(time) ? time : null;
}

function amountRelationshipExplained(incoming, candidate) {
  const incomingGross = normalizeAmount(incoming.gross_amount_raw ?? incoming.gross_amount);
  const incomingPaid = normalizeAmount(incoming.paid_amount_raw ?? incoming.paid_amount);
  const candidateGross = normalizeAmount(candidate.gross_amount_raw ?? candidate.gross_amount);
  const candidatePaid = normalizeAmount(candidate.paid_amount_raw ?? candidate.paid_amount);
  if (incomingGross !== null && candidatePaid !== null && incomingGross === candidatePaid) return true;
  if (incomingPaid !== null && candidateGross !== null && incomingPaid === candidateGross) return true;
  const discount = normalizeAmount(incoming.discount_amount) ?? 0;
  const points = normalizeAmount(incoming.point_amount) ?? 0;
  return incomingGross !== null && candidatePaid !== null && incomingGross - discount - points === candidatePaid;
}

function refundMismatch(left, right) {
  const leftRefund = ["cancelled", "refunded"].includes(String(left.status || "").toLowerCase()) || normalizeAmount(left.paid_amount_raw ?? left.paid_amount) < 0;
  const rightRefund = ["cancelled", "refunded"].includes(String(right.status || "").toLowerCase()) || normalizeAmount(right.paid_amount_raw ?? right.paid_amount) < 0;
  return leftRefund !== rightRefund;
}

function bigrams(value) {
  const chars = Array.from(value);
  return chars.slice(0, -1).map((char, index) => `${char}${chars[index + 1]}`);
}
