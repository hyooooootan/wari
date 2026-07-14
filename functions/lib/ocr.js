import { ApiError, json, readJson } from "./responses.js";

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif"]);
const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 25_000;

export async function handleReceiptOcr(request, env, payload = null) {
  const maximumBytes = maxImageBytes(env);
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > Math.ceil(maximumBytes * 4 / 3) + 4_096) {
    throw new ApiError(413, "image_too_large", { max_bytes: maximumBytes });
  }
  payload = payload || await readJson(request);
  const image = parseImageDataUrl(payload.image_data_url, maximumBytes);
  const backend = String(env.OCR_BACKEND || "auto").toLowerCase();
  if (backend === "remote" || backend === "tesseract_ollama") return readReceiptWithRemoteOcr(image.dataUrl, env);
  if (backend === "openai") return readReceiptWithOpenAI(image.dataUrl, env);
  if (backend === "gemini") return readReceiptWithGemini(image, env);
  if (backend === "auto") {
    if (env.OPENAI_API_KEY) return readReceiptWithOpenAI(image.dataUrl, env);
    if (env.GEMINI_API_KEY) return readReceiptWithGemini(image, env);
    return json({ error: "missing_api_key" }, 503);
  }
  return json({ error: "unsupported_ocr_backend" }, 400);
}

export function parseImageDataUrl(value, maximumBytes = DEFAULT_MAX_IMAGE_BYTES) {
  if (typeof value !== "string") throw new ApiError(400, "invalid_image");
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(value);
  if (!match) throw new ApiError(400, "invalid_image");
  const mimeType = match[1].toLowerCase();
  if (!IMAGE_TYPES.has(mimeType)) throw new ApiError(415, "unsupported_image_type");
  const base64Data = match[2];
  if (!base64Data || base64Data.length % 4 !== 0) throw new ApiError(400, "invalid_image");
  const firstPadding = base64Data.indexOf("=");
  if (firstPadding !== -1 && firstPadding < base64Data.length - 2) throw new ApiError(400, "invalid_image");
  const padding = base64Data.endsWith("==") ? 2 : base64Data.endsWith("=") ? 1 : 0;
  const decodedBytes = (base64Data.length / 4) * 3 - padding;
  if (!Number.isSafeInteger(decodedBytes) || decodedBytes <= 0) throw new ApiError(400, "invalid_image");
  if (decodedBytes > maximumBytes) throw new ApiError(413, "image_too_large", { max_bytes: maximumBytes });
  try {
    atob(base64Data);
  } catch {
    throw new ApiError(400, "invalid_image");
  }
  return { dataUrl: value, mimeType, base64Data, decodedBytes };
}

async function readReceiptWithRemoteOcr(imageDataUrl, env) {
  const baseUrl = String(env.RECEIPT_OCR_API_URL || env.OCR_API_URL || "").replace(/\/+$/, "");
  if (!baseUrl) return json({ error: "missing_receipt_ocr_api_url" }, 503);
  let url;
  try {
    url = new URL(`${baseUrl}/api/ocr-receipt`);
  } catch {
    return json({ error: "invalid_receipt_ocr_api_url" }, 503);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return json({ error: "invalid_receipt_ocr_api_url" }, 503);
  const { response: remoteRes, data } = await timedJsonFetch(
    url,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ image_data_url: imageDataUrl }),
    },
    env,
  );
  if (!remoteRes.ok) return json({ error: "remote_ocr_error" }, 502);
  if (!data || typeof data !== "object" || Array.isArray(data)) return json({ error: "invalid_remote_ocr_response" }, 502);
  return json(data);
}

async function readReceiptWithOpenAI(imageDataUrl, env) {
  if (!env.OPENAI_API_KEY) return json({ error: "missing_api_key" }, 503);
  const schema = receiptSchema(false);
  const { response: openaiRes, data } = await timedJsonFetch(
    "https://api.openai.com/v1/responses",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: env.OPENAI_OCR_MODEL || "gpt-5.4-mini",
        store: false,
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: receiptOcrPrompt() },
              { type: "input_image", image_url: imageDataUrl, detail: "high" },
            ],
          },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "receipt_ocr",
            schema,
            strict: true,
          },
        },
      }),
    },
    env,
  );
  if (!openaiRes.ok) return json({ error: "openai_error" }, 502);
  const outputText = data?.output_text || data?.output?.flatMap((entry) => entry.content || []).find((entry) => entry.type === "output_text")?.text;
  const parsed = parseOcrOutput(outputText);
  if (!parsed) return json({ error: "invalid_ocr_result" }, 502);
  return json({ ...parsed, model: data?.model || env.OPENAI_OCR_MODEL || "gpt-5.4-mini" });
}

async function readReceiptWithGemini(image, env) {
  if (!env.GEMINI_API_KEY) return json({ error: "missing_api_key" }, 503);
  const model = env.GEMINI_OCR_MODEL || "gemini-2.5-flash";
  const { response: geminiRes, data } = await timedJsonFetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: receiptOcrPrompt() },
              { inlineData: { mimeType: image.mimeType, data: image.base64Data } },
            ],
          },
        ],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: receiptSchema(true),
        },
      }),
    },
    env,
  );
  if (!geminiRes.ok) return json({ error: "gemini_error" }, 502);
  const outputText = data?.candidates?.flatMap((entry) => entry.content?.parts || []).find((entry) => typeof entry.text === "string")?.text;
  const parsed = parseOcrOutput(outputText);
  if (!parsed) return json({ error: "invalid_ocr_result" }, 502);
  return json({ ...parsed, model });
}

async function timedJsonFetch(url, options, env) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs(env));
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    let data = null;
    try {
      data = await response.json();
    } catch (error) {
      if (error?.name === "AbortError") throw error;
    }
    return { response, data };
  } catch (error) {
    if (error?.name === "AbortError") throw new ApiError(504, "ocr_timeout");
    throw new ApiError(502, "ocr_upstream_unavailable");
  } finally {
    clearTimeout(timeout);
  }
}

function receiptSchema(gemini) {
  const nullableString = gemini ? { type: "string", nullable: true } : { type: ["string", "null"] };
  const nullableInteger = gemini ? { type: "integer", nullable: true } : { type: ["integer", "null"] };
  const itemSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      name: { type: "string" },
      amount: { type: "integer" },
    },
    required: ["name", "amount"],
  };
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      store_name: nullableString,
      total_amount: nullableInteger,
      paid_at: nullableString,
      items: { type: "array", items: itemSchema },
      confidence: { type: "number" },
      notes: { type: "string" },
    },
    required: ["store_name", "total_amount", "paid_at", "items", "confidence", "notes"],
  };
  if (gemini) {
    delete schema.additionalProperties;
    delete itemSchema.additionalProperties;
  }
  return schema;
}

function receiptOcrPrompt() {
  return "日本のレシート画像から店名、税込の最終支払総額、支払日、購入品目を読み取ってください。合計、小計、税、値引き、支払い方法、預かり金、釣り銭、ポイントは購入品目に含めないでください。読み取れない品目がある場合はitemsを空配列にしてください。";
}

function parseOcrOutput(value) {
  if (typeof value !== "string" || value.length > 200_000) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function maxImageBytes(env) {
  const value = Number(env.OCR_MAX_IMAGE_BYTES);
  return Number.isSafeInteger(value) && value >= 1_024 && value <= 25 * 1024 * 1024 ? value : DEFAULT_MAX_IMAGE_BYTES;
}

function timeoutMs(env) {
  const value = Number(env.OCR_TIMEOUT_MS);
  return Number.isSafeInteger(value) && value >= 100 && value <= 120_000 ? value : DEFAULT_TIMEOUT_MS;
}
