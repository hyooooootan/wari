const NON_TRANSACTION_TERMS = [
  "一定金額到達",
  "ご利用累計金額",
  "通知設定金額",
  "対象期間内のご利用累計",
];

export function parsePaymentNotification(text, headers = {}) {
  const source = String(text || "").replace(/\r/g, "");
  const subject = String(headers.subject || "");
  const sender = String(headers.from || "").toLowerCase();
  const provider = providerName(sender, source);
  if (isNonTransactionNotification(source, subject)) {
    return { provider, amount: null, occurred_at: headers.received_at || null, merchant_name: null, external_transaction_id: null, payment_method: "credit_card", parse_status: "ignored" };
  }
  const amount = parseAmount(source);
  const occurredAt = validIso(headers.received_at);
  const merchant = parseMerchant(source);
  const externalId = match(source, /(?:transaction\s*(?:id|number))\s*[:：\s]*([A-Z0-9_-]{4,64})/i);
  const paymentMethod = /paypay/i.test(provider) ? "paypay" : /銀行|bank/i.test(source) ? "bank" : "credit_card";
  const paymentEvidence = Number.isSafeInteger(amount) && amount !== 0;
  const status = !paymentEvidence || !occurredAt ? "parse_error" : merchant ? "parsed" : "needs_review";
  return { provider, amount, occurred_at: occurredAt, merchant_name: merchant, external_transaction_id: externalId, payment_method: paymentMethod, parse_status: status };
}

export function isNonTransactionNotification(text, subject = "") {
  const source = `${String(subject || "")}\n${String(text || "")}`;
  return NON_TRANSACTION_TERMS.some((term) => source.includes(term));
}

export function parseAmount(text) {
  const source = String(text || "");
  const value = match(source, /(?:ご利用金額|利用金額|決済金額|支払金額|amount)\s*[:：\s]*\s*(?:JPY\s*)?([+-]?[\d,]+)\s*(?:円|JPY)?/i)
    || match(source, /(?:￥|¥)\s*([+-]?[\d,]+)/);
  if (!value) return null;
  const number = Number(value.replace(/,/g, ""));
  return Number.isSafeInteger(number) ? number : null;
}

export function parseDateTime(text, fallback) {
  const value = match(String(text || ""), /(?:利用日|決済日時|受信日時|日時|date)\s*[:：\s]*(\d{4}[年\/-]\d{1,2}[月\/-]\d{1,2}日?(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?)/i);
  const normalized = value?.replace(/年|\//g, "-").replace(/月/g, "-").replace(/日/g, "");
  const candidate = normalized || fallback;
  if (!candidate || !Number.isFinite(Date.parse(candidate))) return null;
  return new Date(candidate).toISOString();
}

export function parseMerchant(text) {
  const value = match(String(text || ""), /(?:利用先|ご利用先|加盟店名|店名|merchant)\s*[:：\s]*([^\n]{1,160})/i);
  return value ? value.trim().replace(/\s{2,}.*/, "").slice(0, 160) : null;
}

function validIso(value) {
  if (typeof value !== "string" || !value || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function providerName(sender, text) {
  if (/paypay/.test(sender + text)) return "paypay";
  if (/rakuten/.test(sender + text)) return "rakuten_card";
  if (/smbc|vpass/.test(sender + text)) return "smbc_card";
  if (/jcb/.test(sender + text)) return "jcb";
  if (/amazon/.test(sender + text)) return "amazon";
  return "generic";
}

function match(text, expression) { return expression.exec(text)?.[1] || null; }
