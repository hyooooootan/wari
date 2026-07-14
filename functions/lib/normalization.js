const COMPANY_TERMS = [
  "株式会社",
  "有限会社",
  "合同会社",
  "合資会社",
  "合名会社",
  "一般社団法人",
  "一般財団法人",
  "公益社団法人",
  "公益財団法人",
  "医療法人",
  "社会福祉法人",
  "学校法人",
  "特定非営利活動法人",
  "(株)",
  "(有)",
  "(同)",
];

export const MERCHANT_ALIAS_DICTIONARY = Object.freeze({
  "7-eleven": "セブンイレブン",
  "7eleven": "セブンイレブン",
  "seven eleven": "セブンイレブン",
  "セブン-イレブン": "セブンイレブン",
  "セブンイレブン": "セブンイレブン",
  "セブンイレブンジャパン": "セブンイレブン",
  "family mart": "ファミリーマート",
  "familymart": "ファミリーマート",
  "ファミマ": "ファミリーマート",
  "ファミリーマート": "ファミリーマート",
  "lawson": "ローソン",
  "ローソン": "ローソン",
  "ローソンストア100": "ローソンストア100",
  "ナチュラルローソン": "ナチュラルローソン",
  "ministop": "ミニストップ",
  "ミニストップ": "ミニストップ",
  "aeon": "イオン",
  "イオン": "イオン",
  "まいばすけっと": "まいばすけっと",
  "mcdonald's": "マクドナルド",
  "mcdonalds": "マクドナルド",
  "マック": "マクドナルド",
  "マクドナルド": "マクドナルド",
  "starbucks": "スターバックス",
  "starbucks coffee": "スターバックス",
  "スタバ": "スターバックス",
  "スターバックス": "スターバックス",
  "amazon": "amazon",
  "amazon co jp": "amazon",
  "amazon.co.jp": "amazon",
  "amazon marketplace": "amazon",
  "amazonマーケットプレイス": "amazon",
  "amzn": "amazon",
  "rakuten": "楽天市場",
  "rakuten ichiba": "楽天市場",
  "楽天": "楽天市場",
  "楽天市場": "楽天市場",
  "yahoo shopping": "yahooショッピング",
  "yahoo! shopping": "yahooショッピング",
  "yahooショッピング": "yahooショッピング",
  "ヤフーショッピング": "yahooショッピング",
  "paypay mall": "yahooショッピング",
  "paypayモール": "yahooショッピング",
  "mercari": "メルカリ",
  "メルカリ": "メルカリ",
  "zozotown": "zozotown",
  "zozo town": "zozotown",
  "uber eats": "ubereats",
  "ubereats": "ubereats",
  "ウーバーイーツ": "ubereats",
  "出前館": "出前館",
});

export const MERCHANT_ALIASES = MERCHANT_ALIAS_DICTIONARY;

export const BROAD_MARKETPLACE_MERCHANTS = Object.freeze([
  "amazon",
  "楽天市場",
  "yahooショッピング",
  "メルカリ",
  "zozotown",
]);

export const PAYMENT_METHOD_ALIASES = Object.freeze({
  cash: "cash",
  現金: "cash",
  creditcard: "credit_card",
  credit: "credit_card",
  クレジットカード: "credit_card",
  クレジット: "credit_card",
  カード: "credit_card",
  visa: "credit_card",
  mastercard: "credit_card",
  jcb: "credit_card",
  americanexpress: "credit_card",
  amex: "credit_card",
  debitcard: "debit_card",
  debit: "debit_card",
  デビットカード: "debit_card",
  デビット: "debit_card",
  prepaidcard: "prepaid_card",
  prepaid: "prepaid_card",
  プリペイドカード: "prepaid_card",
  プリペイド: "prepaid_card",
  paypay: "paypay",
  ペイペイ: "paypay",
  banktransfer: "bank_transfer",
  transfer: "bank_transfer",
  銀行振込: "bank_transfer",
  振込: "bank_transfer",
  directdebit: "direct_debit",
  accounttransfer: "direct_debit",
  口座振替: "direct_debit",
  自動引落: "direct_debit",
  自動引き落とし: "direct_debit",
  electronicmoney: "electronic_money",
  電子マネー: "electronic_money",
  suica: "electronic_money",
  pasmo: "electronic_money",
  icoca: "electronic_money",
  nanaco: "electronic_money",
  waon: "electronic_money",
  楽天edy: "electronic_money",
  edy: "electronic_money",
  applepay: "mobile_wallet",
  googlepay: "mobile_wallet",
  quickpay: "mobile_wallet",
  quicpay: "mobile_wallet",
  id: "mobile_wallet",
  points: "points",
  point: "points",
  ポイント: "points",
});

const BROAD_MARKETPLACE_KEYS = new Set(BROAD_MARKETPLACE_MERCHANTS.map((value) => compactComparable(value)));
const BRANCHABLE_MERCHANTS = new Set([
  "セブンイレブン",
  "ファミリーマート",
  "ローソン",
  "ローソンストア100",
  "ナチュラルローソン",
  "ミニストップ",
  "イオン",
  "まいばすけっと",
  "マクドナルド",
  "スターバックス",
]);
const NORMALIZED_MERCHANT_ALIASES = buildMerchantAliases(MERCHANT_ALIAS_DICTIONARY);

const SECRET_KEY_PATTERN = /(?:password|passwd|passcode|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|credential|cookie|暗証|秘密|認証|トークン|セキュリティコード)/iu;
const IDENTIFIER_KEY_PATTERN = /(?:card(?:number|no)?|account(?:number|no)?|routing|iban|swift|phone|mobile|tel|カード番号|口座番号|会員番号|電話|携帯)/iu;
const PERSONAL_KEY_PATTERN = /(?:email|e-mail|mailaddress|full[_-]?name|first[_-]?name|last[_-]?name|address|postal|氏名|名前|メール|住所|郵便番号)/iu;

export function normalizeUnicode(value) {
  if (value === null || value === undefined) return "";
  return String(value).normalize("NFKC");
}

export function normalizeWhitespace(value) {
  return normalizeUnicode(value).replace(/[\s\u00a0]+/gu, " ").trim();
}

export function normalizeMerchant(value, aliases = MERCHANT_ALIAS_DICTIONARY) {
  const prepared = prepareMerchant(value);
  if (!prepared) return "";
  const aliasEntries = aliases === MERCHANT_ALIAS_DICTIONARY ? NORMALIZED_MERCHANT_ALIASES : buildMerchantAliases(aliases);
  const exact = aliasEntries.get(prepared);
  if (exact) return exact;

  for (const [alias, canonical] of aliasEntries.entries()) {
    if (!BRANCHABLE_MERCHANTS.has(canonical) || !prepared.startsWith(alias) || prepared.length === alias.length) continue;
    const suffix = prepared.slice(alias.length);
    if (/^(?:[\p{L}\p{N}]{1,24})(?:本店|支店|店|営業所|出張所|売店)$|^(?:[\p{L}]{1,16})?(?:駅|空港|sa|pa)[\p{L}\p{N}]{0,8}$/iu.test(suffix)) return canonical;
  }

  return prepared;
}

export const normalizeMerchantName = normalizeMerchant;

export function normalizeMerchantDetails(value, aliases = MERCHANT_ALIAS_DICTIONARY) {
  const normalized = normalizeMerchant(value, aliases);
  const broadMarketplace = isBroadMarketplace(normalized);
  return {
    original: value === null || value === undefined ? "" : String(value),
    normalized,
    comparisonKey: normalized,
    broadMarketplace,
    weakened: broadMarketplace,
  };
}

export function isBroadMarketplace(value) {
  const normalized = compactComparable(normalizeMerchant(value));
  return normalized !== "" && BROAD_MARKETPLACE_KEYS.has(normalized);
}

export function normalizeAmount(value, options = {}) {
  if (value === null || value === undefined || typeof value === "boolean") return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return options.absolute ? Math.abs(value) : normalizeFiniteNumber(value);
  }

  let text = normalizeWhitespace(value);
  if (!text) return null;
  const parenthesized = /^\(.*\)$/u.test(text);
  const refundMarked = /(?:返金|払戻|払い戻し|refund|credit)/iu.test(text);
  const debitMarked = /(?:debit|dr)$/iu.test(text);
  text = text
    .replace(/^\((.*)\)$/u, "$1")
    .replace(/[￥¥$€£円]/gu, "")
    .replace(/(?:税込|税抜|返金|払戻し?|払い戻し|refund|credit|debit|cr|dr)/giu, "")
    .replace(/[\s'’]/gu, "");

  let sign = parenthesized || refundMarked || debitMarked ? -1 : 1;
  if (/^-/u.test(text)) sign = -1;
  text = text.replace(/^[+-]/u, "");

  const commaIndex = text.lastIndexOf(",");
  const dotIndex = text.lastIndexOf(".");
  if (commaIndex >= 0 && dotIndex >= 0) {
    if (commaIndex > dotIndex && /^\d{1,2}$/u.test(text.slice(commaIndex + 1))) {
      text = text.replace(/\./gu, "").replace(/,/gu, ".");
    } else {
      text = text.replace(/,/gu, "");
    }
  } else if (commaIndex >= 0) {
    const commaParts = text.split(",");
    const decimalComma = commaParts.length === 2 && /^\d{1,2}$/u.test(commaParts[1]);
    text = decimalComma ? `${commaParts[0]}.${commaParts[1]}` : commaParts.join("");
  }

  text = text.replace(/[^\d.]/gu, "");
  if (!/^\d+(?:\.\d+)?$/u.test(text)) return null;
  const amount = Number(text) * sign;
  if (!Number.isFinite(amount)) return null;
  const normalized = normalizeFiniteNumber(amount);
  return options.absolute ? Math.abs(normalized) : normalized;
}

export function normalizeDate(value) {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === "number" && Number.isFinite(value)) {
    const integerText = String(Math.trunc(value));
    if (/^\d{8}$/u.test(integerText)) return normalizeDate(integerText);
    const milliseconds = Math.abs(value) < 100000000000 ? value * 1000 : value;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  let text = normalizeWhitespace(value)
    .replace(/[（(](?:月|火|水|木|金|土|日)(?:曜日)?[）)]/gu, "")
    .replace(/午前/gu, "AM ")
    .replace(/午後/gu, "PM ")
    .replace(/時/gu, ":")
    .replace(/分/gu, ":")
    .replace(/秒/gu, "")
    .replace(/JST$/iu, "+09:00")
    .trim();

  const eraMatch = text.match(/^(令和|平成|昭和)(\d{1,2})年(\d{1,2})月(\d{1,2})日(.*)$/u);
  if (eraMatch) {
    const eraBase = { 令和: 2018, 平成: 1988, 昭和: 1925 }[eraMatch[1]];
    text = `${eraBase + Number(eraMatch[2])}-${eraMatch[3]}-${eraMatch[4]}${eraMatch[5]}`;
  }

  text = text
    .replace(/年/gu, "-")
    .replace(/月/gu, "-")
    .replace(/日/gu, " ")
    .replace(/\//gu, "-")
    .replace(/\.(?=\d{1,2}(?:\D|$))/gu, "-")
    .replace(/\s+/gu, " ")
    .trim();

  if (/^\d{8}$/u.test(text)) text = `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  const match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](?:(AM|PM)\s*)?(\d{1,2})(?::(\d{1,2}))?(?::(\d{1,2})(?:\.(\d{1,3}))?)?\s*(Z|[+-]\d{2}:?\d{2})?)?$/iu);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  let hour = match[5] === undefined ? null : Number(match[5]);
  const minute = match[6] === undefined ? 0 : Number(match[6]);
  const second = match[7] === undefined ? 0 : Number(match[7]);
  const millisecond = match[8] === undefined ? 0 : Number(match[8].padEnd(3, "0"));
  if (!validDateParts(year, month, day) || minute > 59 || second > 59 || millisecond > 999) return null;
  if (hour === null) return formatDate(year, month, day);
  if (hour > 23) return null;
  if (match[4]) {
    if (hour < 1 || hour > 12) return null;
    if (match[4].toUpperCase() === "PM" && hour !== 12) hour += 12;
    if (match[4].toUpperCase() === "AM" && hour === 12) hour = 0;
  }

  const time = `${pad(hour)}:${pad(minute)}:${pad(second)}${millisecond ? `.${String(millisecond).padStart(3, "0")}` : ""}`;
  let zone = match[9] || "";
  if (zone && zone.toUpperCase() !== "Z" && !zone.includes(":")) zone = `${zone.slice(0, 3)}:${zone.slice(3)}`;
  if (zone.toUpperCase() === "Z") zone = "Z";
  return `${formatDate(year, month, day)}T${time}${zone}`;
}

export const normalizeDateTime = normalizeDate;

export function normalizePaymentMethod(value) {
  const key = compactComparable(value);
  if (!key) return null;
  if (PAYMENT_METHOD_ALIASES[key]) return PAYMENT_METHOD_ALIASES[key];
  if (key.includes("paypay") || key.includes("ペイペイ")) return "paypay";
  if (/(?:デビット|debit)/iu.test(key)) return "debit_card";
  if (/(?:プリペイド|prepaid)/iu.test(key)) return "prepaid_card";
  if (/(?:クレジット|credit|visa|mastercard|jcb|amex|americanexpress)/iu.test(key)) return "credit_card";
  if (/(?:口座振替|自動引落|directdebit|accounttransfer)/iu.test(key)) return "direct_debit";
  if (/(?:銀行振込|振込|banktransfer|wiretransfer)/iu.test(key)) return "bank_transfer";
  if (/(?:suica|pasmo|icoca|nanaco|waon|edy|電子マネー)/iu.test(key)) return "electronic_money";
  if (/(?:applepay|googlepay|quickpay|quicpay)/iu.test(key)) return "mobile_wallet";
  if (/(?:現金|cash)/iu.test(key)) return "cash";
  if (/(?:ポイント|points?)/iu.test(key)) return "points";
  return key;
}

export const normalizePayment = normalizePaymentMethod;

export function normalizeAccountLabel(value) {
  let text = normalizeWhitespace(value).toLowerCase();
  if (!text) return "";
  text = removeCompanyTerms(text)
    .replace(/[＊*xX×●・•]+(?=\d{2,8}\b)/gu, "")
    .replace(/[\p{P}\p{S}\s]+/gu, "");
  return text;
}

export function maskSensitiveValue(value, key = "") {
  if (value === null || value === undefined) return value;
  const keyText = normalizeUnicode(key);
  if (SECRET_KEY_PATTERN.test(keyText)) return "[REDACTED]";
  if (IDENTIFIER_KEY_PATTERN.test(keyText)) return maskIdentifier(value);
  if (PERSONAL_KEY_PATTERN.test(keyText)) return maskPersonal(value, keyText);
  return typeof value === "string" ? maskSensitiveText(value) : value;
}

export function maskSensitivePayload(payload) {
  return maskPayloadValue(payload, "", new WeakMap());
}

export const maskSensitiveData = maskSensitivePayload;
export const sanitizeImportPayload = maskSensitivePayload;

function prepareMerchant(value) {
  let text = normalizeWhitespace(value).toLowerCase();
  if (!text) return "";
  text = removeCompanyTerms(text)
    .replace(/(?:[\s\u00a0・,，/／|｜]+)[\p{L}\p{N}]{1,24}(?:本店|支店|店|営業所|出張所|売店)$/iu, "")
    .replace(/[\p{P}\p{S}\s]+/gu, "");
  return text;
}

function removeCompanyTerms(value) {
  let result = value;
  for (const term of COMPANY_TERMS) result = result.replaceAll(term.toLowerCase(), " ");
  return result.replace(/\b(?:co(?:mpany)?|corp(?:oration)?|inc(?:orporated)?|ltd|limited|llc|gk|kk)\b\.?/giu, " ");
}

function compactComparable(value) {
  return normalizeWhitespace(value).toLowerCase().replace(/[\p{P}\p{S}\s]+/gu, "");
}

function buildMerchantAliases(aliases) {
  const result = new Map();
  for (const [alias, canonical] of Object.entries(aliases || {})) {
    const key = prepareMerchant(alias);
    const value = prepareMerchant(canonical);
    if (key && value) result.set(key, value);
  }
  return new Map([...result.entries()].sort((left, right) => right[0].length - left[0].length));
}

function normalizeFiniteNumber(value) {
  return Math.round((value + Number.EPSILON) * 1000000) / 1000000;
}

function validDateParts(year, month, day) {
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function formatDate(year, month, day) {
  return `${String(year).padStart(4, "0")}-${pad(month)}-${pad(day)}`;
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function maskPayloadValue(value, key, seen) {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return maskSensitiveValue(value, key);
  if (value instanceof Date) return value.toISOString();
  if (seen.has(value)) return "[CIRCULAR]";
  const result = Array.isArray(value) ? [] : {};
  seen.set(value, result);
  if (Array.isArray(value)) {
    for (const item of value) result.push(maskPayloadValue(item, key, seen));
  } else {
    for (const [entryKey, entryValue] of Object.entries(value)) result[entryKey] = maskPayloadValue(entryValue, entryKey, seen);
  }
  return result;
}

function maskIdentifier(value) {
  const text = String(value);
  const compact = text.replace(/\s+/gu, "");
  if (compact.length <= 4) return "****";
  return `${"*".repeat(Math.min(12, compact.length - 4))}${compact.slice(-4)}`;
}

function maskPersonal(value, key) {
  const text = String(value);
  if (/mail|メール/iu.test(key)) return maskEmail(text);
  return "[REDACTED]";
}

function maskSensitiveText(value) {
  return String(value)
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/giu, "Bearer [REDACTED]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, (email) => maskEmail(email))
    .replace(/(?<!\d)(?:\d[ -]?){11,18}\d(?!\d)/gu, (identifier) => maskIdentifier(identifier));
}

function maskEmail(value) {
  const at = value.indexOf("@");
  if (at <= 0) return "[REDACTED]";
  const local = value.slice(0, at);
  return `${local.slice(0, 1)}***${value.slice(at)}`;
}
