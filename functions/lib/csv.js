import {
  normalizeAmount,
  normalizeDate,
  normalizeMerchantName,
  normalizePaymentMethod,
  sanitizeImportPayload,
} from "./normalization.js";

const COMMON = Object.freeze({
  merchant: ["merchant", "merchant_name", "store", "store_name", "description", "利用店名", "加盟店", "店舗", "店名", "摘要", "内容"],
  paidAmount: ["paid_amount", "amount", "total", "利用金額", "金額", "支払金額", "取引金額", "出金額"],
  grossAmount: ["gross_amount", "利用総額", "総額", "税込金額"],
  occurredAt: ["occurred_at", "date", "datetime", "利用日", "取引日", "日時", "日付"],
  settledAt: ["settled_at", "確定日", "支払日", "計上日"],
  paymentMethod: ["payment_method", "支払方法", "決済方法", "種別"],
  externalId: ["external_transaction_id", "transaction_id", "取引番号", "利用番号", "id"],
  accountLabel: ["account_label", "カード", "カード番号", "口座", "支払元"],
  status: ["status", "状態", "ステータス"],
});

export const CSV_PROFILES = Object.freeze({
  generic: Object.freeze({ source_type: "manual", columns: COMMON }),
  card: Object.freeze({ source_type: "card_csv", columns: COMMON, default_payment_method: "credit_card" }),
  paypay: Object.freeze({ source_type: "paypay_csv", columns: COMMON, default_payment_method: "paypay" }),
  bank: Object.freeze({ source_type: "bank_csv", columns: COMMON, default_payment_method: "bank" }),
});

export function parseCsv(text, options = {}) {
  const source = String(text ?? "").replace(/^\uFEFF/u, "");
  const delimiter = options.delimiter || detectDelimiter(source);
  const matrix = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"' && cell === "") {
      quoted = true;
    } else if (char === delimiter) {
      row.push(cell);
      cell = "";
    } else if (char === "\r" || char === "\n") {
      if (char === "\r" && source[index + 1] === "\n") index += 1;
      row.push(cell);
      if (row.some((value) => value !== "")) matrix.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  if (quoted) throw new TypeError("CSVの引用符が閉じられていません。");
  row.push(cell);
  if (row.some((value) => value !== "")) matrix.push(row);
  const headers = (matrix.shift() || []).map((value, index) => normalizeHeader(value) || `column_${index + 1}`);
  const rows = matrix.map((values, rowIndex) => ({
    ...Object.fromEntries(headers.map((header, index) => [header, neutralizeFormula(values[index] ?? "")])),
    __row_number: rowIndex + 2,
  }));
  return { delimiter, headers, rows };
}

export function mapCsvRows(parsedOrText, profileName = "generic", options = {}) {
  const parsed = typeof parsedOrText === "string" ? parseCsv(parsedOrText, options) : parsedOrText;
  const profile = typeof profileName === "object" ? profileName : CSV_PROFILES[profileName] || CSV_PROFILES.generic;
  return (parsed?.rows || []).map((row) => {
    const merchantRaw = pick(row, profile.columns.merchant);
    const paidAmount = normalizeAmount(pick(row, profile.columns.paidAmount));
    const grossAmount = normalizeAmount(pick(row, profile.columns.grossAmount)) ?? paidAmount;
    const occurredAt = normalizeDate(pick(row, profile.columns.occurredAt));
    const settledAt = normalizeDate(pick(row, profile.columns.settledAt));
    const rawMethod = pick(row, profile.columns.paymentMethod) || profile.default_payment_method || null;
    const statusRaw = String(pick(row, profile.columns.status) || "").toLowerCase();
    return {
      source_type: options.source_type || profile.source_type,
      source_record_id: null,
      merchant_raw: merchantRaw || null,
      merchant_normalized: normalizeMerchantName(merchantRaw),
      gross_amount_raw: grossAmount,
      paid_amount_raw: paidAmount,
      occurred_at_raw: occurredAt,
      settled_at_raw: settledAt,
      payment_method_raw: normalizePaymentMethod(rawMethod),
      external_transaction_id: pick(row, profile.columns.externalId) || null,
      account_label: pick(row, profile.columns.accountLabel) || null,
      status: statusRaw.includes("取消") || statusRaw.includes("refund") || (paidAmount ?? 0) < 0 ? "refunded" : "confirmed",
      raw_payload: sanitizeImportPayload(Object.fromEntries(Object.entries(row).filter(([key]) => key !== "__row_number"))),
      row_number: row.__row_number,
      valid: Boolean(merchantRaw || paidAmount !== null) && Boolean(occurredAt),
    };
  });
}

export async function makeSourceRecordId(sourceType, record, context = {}) {
  const payload = stableStringify({
    source_type: sourceType,
    account_label: record.account_label || null,
    external_transaction_id: record.external_transaction_id || null,
    merchant: normalizeMerchantName(record.merchant_raw ?? record.merchant_name),
    paid_amount: normalizeAmount(record.paid_amount_raw ?? record.paid_amount),
    occurred_at: normalizeDate(record.occurred_at_raw ?? record.occurred_at),
    provider: context.provider || record.provider || null,
  });
  const bytes = new TextEncoder().encode(payload);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function decodeCsvBytes(bytes) {
  const value = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    return new TextDecoder("shift_jis").decode(value);
  }
}

function detectDelimiter(text) {
  const sample = String(text).split(/\r?\n/u).slice(0, 5).join("\n");
  const candidates = [",", "\t", ";"];
  return candidates.map((delimiter) => ({ delimiter, count: countOutsideQuotes(sample, delimiter) })).sort((left, right) => right.count - left.count)[0].delimiter;
}

function countOutsideQuotes(text, delimiter) {
  let quoted = false;
  let count = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '"') {
      if (quoted && text[index + 1] === '"') index += 1;
      else quoted = !quoted;
    } else if (!quoted && text[index] === delimiter) count += 1;
  }
  return count;
}

function normalizeHeader(value) {
  return String(value || "").normalize("NFKC").trim().toLowerCase().replace(/[\s　]+/gu, "_");
}

function pick(row, aliases) {
  for (const alias of aliases || []) {
    const normalized = normalizeHeader(alias);
    if (row[normalized] !== undefined && row[normalized] !== "") return String(row[normalized]).replace(/^'/u, "").trim();
  }
  return null;
}

function neutralizeFormula(value) {
  const text = String(value ?? "");
  return /^[=+\-@]/u.test(text.trimStart()) ? `'${text}` : text;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
