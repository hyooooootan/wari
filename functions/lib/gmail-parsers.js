export function parsePaymentNotification(text, headers = {}) {
  const source = String(text || "").replace(/\r/g, "");
  const sender = String(headers.from || "").toLowerCase();
  const provider = providerName(sender, source);
  const amount = parseAmount(source);
  const occurredAt = parseDateTime(source);
  const merchant = parseMerchant(source);
  const externalId = match(source, /(?:利用番号|取引番号|決済番号|受付番号|transaction\s*(?:id|number))\s*[:：]?\s*([A-Z0-9_-]{4,64})/i);
  const paymentMethod = /paypay/i.test(provider) ? "paypay" : /銀行|bank/i.test(source) ? "bank" : "credit_card";
  const paymentEvidence = amount !== null && amount !== 0;
  const status = !paymentEvidence ? "parse_error" : amount !== null && occurredAt && merchant ? "parsed" : "needs_review";
  return { provider, amount, occurred_at: occurredAt, merchant_name: merchant, external_transaction_id: externalId, payment_method: paymentMethod, parse_status: status };
}

export function parseAmount(text) {
  const value = match(text, /(?:ご利用金額|利用金額|決済金額|支払金額|金額|amount)\s*[:：]?\s*(?:JPY|￥|¥)?\s*([+-]?[\d,]+)\s*(?:円|JPY)?/i)
    || match(text, /(?:￥|¥)\s*([+-]?[\d,]+)/);
  if (!value) return null;
  const number = Number(value.replace(/,/g, ""));
  return Number.isSafeInteger(number) ? number : null;
}

export function parseDateTime(text, fallback) {
  const value = match(text, /(?:利用日時|決済日時|取引日時|日時|date)\s*[:：]?\s*(\d{4}[年\/-]\d{1,2}[月\/-]\d{1,2}日?(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?)/i);
  const normalized = value?.replace(/年|\//g, "-").replace(/月/g, "-").replace(/日/g, "");
  const candidate = normalized || fallback;
  if (!candidate || !Number.isFinite(Date.parse(candidate))) return null;
  return new Date(candidate).toISOString();
}

export function parseMerchant(text) {
  const value = match(text, /(?:利用先|ご利用先|加盟店|店舗名|店名|merchant)\s*[:：]?\s*([^\n]{1,160})/i);
  return value ? value.trim().replace(/\s{2,}.*/, "").slice(0, 160) : null;
}

function providerName(sender, text) {
  if (/paypay/.test(sender + text)) return "paypay";
  if (/rakuten|楽天/.test(sender + text)) return "rakuten_card";
  if (/smbc|三井住友|vpass/.test(sender + text)) return "smbc_card";
  if (/jcb/.test(sender + text)) return "jcb";
  if (/amazon/.test(sender + text)) return "amazon";
  return "generic";
}

function match(text, expression) { return expression.exec(text)?.[1] || null; }
