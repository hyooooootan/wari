const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_MIME_TYPES = Object.freeze([
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const CSV_SOURCE_TYPES = Object.freeze(["card_csv", "paypay_csv", "bank_csv", "manual"]);

class ImportFileError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ImportFileError";
    this.code = code;
    Object.assign(this, details);
  }
}

function extensionMimeType(name) {
  const extension = String(name || "").toLowerCase().split(".").pop();
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "png") return "image/png";
  if (extension === "webp") return "image/webp";
  return "";
}

function validateImageFile(file, options = {}) {
  if (!file || typeof file !== "object") {
    throw new ImportFileError("image_required", "画像ファイルを選択してください");
  }
  const allowedTypes = Array.isArray(options.allowedTypes) && options.allowedTypes.length
    ? options.allowedTypes.map((value) => String(value).toLowerCase())
    : IMAGE_MIME_TYPES;
  const mimeType = String(file.type || extensionMimeType(file.name)).toLowerCase();
  if (!allowedTypes.includes(mimeType)) {
    throw new ImportFileError("unsupported_image_type", "JPEG、PNG、WebPの画像を選択してください", { mimeType });
  }
  const size = Number(file.size);
  if (!Number.isFinite(size) || size < 0) {
    throw new ImportFileError("invalid_image_size", "画像の大きさを確認できません");
  }
  const maxBytes = Number.isSafeInteger(options.maxBytes) && options.maxBytes > 0 ? options.maxBytes : MAX_IMAGE_BYTES;
  if (size === 0) {
    throw new ImportFileError("empty_image", "画像ファイルが空です");
  }
  if (size > maxBytes) {
    throw new ImportFileError("image_too_large", `画像は${Math.floor(maxBytes / 1024 / 1024)}MB以下にしてください`, {
      size,
      maxBytes,
    });
  }
  if (typeof file.arrayBuffer !== "function" && typeof FileReader === "undefined") {
    throw new ImportFileError("image_unreadable", "画像ファイルを読み込めません");
  }
  return file;
}

function bytesToBase64(bytes) {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  if (typeof btoa !== "function") {
    throw new ImportFileError("base64_unavailable", "画像を変換できません");
  }
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

async function readImageAsDataUrl(file, options = {}) {
  validateImageFile(file, options);
  if (typeof file.arrayBuffer === "function") {
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const mimeType = String(file.type || extensionMimeType(file.name)).toLowerCase();
    return `data:${mimeType};base64,${bytesToBase64(bytes)}`;
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new ImportFileError("image_read_failed", "画像ファイルを読み込めません", { cause: reader.error }));
    reader.readAsDataURL(file);
  });
}

function bufferBytes(value) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError("CSV data must be an ArrayBuffer or an ArrayBuffer view");
}

function decodeCsvArrayBuffer(value, options = {}) {
  const bytes = bufferBytes(value);
  const Decoder = options.TextDecoder || globalThis.TextDecoder;
  if (typeof Decoder !== "function") {
    throw new ImportFileError("text_decoder_unavailable", "CSVの文字コードを変換できません");
  }
  try {
    return new Decoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/u, "");
  } catch (utf8Error) {
    try {
      return new Decoder("shift_jis", { fatal: true }).decode(bytes).replace(/^\uFEFF/u, "");
    } catch (shiftJisError) {
      throw new ImportFileError("unsupported_csv_encoding", "CSVはUTF-8またはShift_JISで保存してください", {
        utf8Error,
        shiftJisError,
      });
    }
  }
}

function delimiterCounts(text) {
  const counts = { ",": 0, "\t": 0, ";": 0 };
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') index += 1;
      else quoted = !quoted;
      continue;
    }
    if (!quoted && (char === "\r" || char === "\n")) break;
    if (!quoted && Object.prototype.hasOwnProperty.call(counts, char)) counts[char] += 1;
  }
  return counts;
}

function detectCsvDelimiter(text) {
  const counts = delimiterCounts(String(text ?? ""));
  return Object.entries(counts).sort((left, right) => right[1] - left[1])[0][1] > 0
    ? Object.entries(counts).sort((left, right) => right[1] - left[1])[0][0]
    : ",";
}

function parseCsvRows(text, options = {}) {
  const source = String(text ?? "").replace(/^\uFEFF/u, "");
  const delimiter = String(options.delimiter || detectCsvDelimiter(source));
  if (delimiter.length !== 1) throw new TypeError("CSV delimiter must be one character");
  const maxRows = options.maxRows === undefined ? Number.POSITIVE_INFINITY : Number(options.maxRows);
  if (!(maxRows > 0)) return [];
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"' && field.length === 0) {
      quoted = true;
      continue;
    }
    if (char === delimiter) {
      row.push(field);
      field = "";
      continue;
    }
    if (char === "\r" || char === "\n") {
      if (char === "\r" && source[index + 1] === "\n") index += 1;
      row.push(field);
      rows.push(row);
      if (rows.length >= maxRows) return rows;
      row = [];
      field = "";
      continue;
    }
    field += char;
  }
  if (quoted) {
    throw new ImportFileError("invalid_csv_quotes", "CSVの引用符が閉じられていません");
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.slice(0, maxRows);
}

function parseCsvPreview(text, options = {}) {
  const maxRows = Number.isSafeInteger(options.maxRows) && options.maxRows > 0 ? options.maxRows : 6;
  return parseCsvRows(text, { ...options, maxRows });
}

function sourceText(fileName, rowsOrText) {
  const rowText = Array.isArray(rowsOrText)
    ? rowsOrText.flatMap((row) => Array.isArray(row) ? row : [row]).join(" ")
    : String(rowsOrText || "");
  return `${String(fileName || "")} ${rowText}`.toLowerCase();
}

function normalizeCsvSourceType(value) {
  const normalized = String(value || "").trim().toLowerCase();
  const aliases = {
    card: "card_csv",
    credit_card: "card_csv",
    paypay: "paypay_csv",
    bank: "bank_csv",
    generic: "manual",
    csv: "manual",
  };
  const selected = aliases[normalized] || normalized;
  return CSV_SOURCE_TYPES.includes(selected) ? selected : null;
}

function selectCsvSourceType(selection, fileName, rowsOrText) {
  const selected = normalizeCsvSourceType(selection);
  if (selected) return selected;
  const text = sourceText(fileName, rowsOrText);
  if (/paypay|ペイペイ/u.test(text)) return "paypay_csv";
  if (/銀行|口座|入出金|振込|bank/u.test(text)) return "bank_csv";
  if (/カード|利用日|ご利用店|card|visa|mastercard|jcb/u.test(text)) return "card_csv";
  return "manual";
}

const api = {
  MAX_IMAGE_BYTES,
  IMAGE_MIME_TYPES,
  CSV_SOURCE_TYPES,
  ImportFileError,
  validateImageFile,
  readImageAsDataUrl,
  imageFileToDataUrl: readImageAsDataUrl,
  decodeCsvArrayBuffer,
  decodeCsvBuffer: decodeCsvArrayBuffer,
  detectCsvDelimiter,
  parseCsvRows,
  parseCsvPreview,
  previewCsvRows: parseCsvPreview,
  normalizeCsvSourceType,
  selectCsvSourceType,
  selectSourceType: selectCsvSourceType,
};

if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof globalThis !== "undefined") globalThis.WariImports = api;
