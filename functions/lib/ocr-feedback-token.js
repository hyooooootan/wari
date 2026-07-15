import { base64UrlDecode, base64UrlEncode, timingSafeEqual } from "./crypto.js";
import { ApiError } from "./responses.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_TOKEN_LENGTH = 16_384;

export async function createOcrFeedbackToken(env, userId, projectId, result, timestamp = new Date()) {
  const secret = tokenSecret(env);
  if (!secret) return null;
  const issuedAt = timestamp.toISOString();
  const payload = {
    v: 1,
    user_id: userId,
    project_id: projectId,
    ocr_result_id: result.ocr_result_id,
    issued_at: issuedAt,
    expires_at: new Date(timestamp.getTime() + TOKEN_TTL_MS).toISOString(),
    ocr_model: boundedText(result.ocr_engine_version || result.model || "receipt-ocr", 100),
    original: signedOriginal(result),
  };
  const encoded = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  const token = `${encoded}.${base64UrlEncode(await sign(secret, encoded))}`;
  return token.length <= MAX_TOKEN_LENGTH ? token : null;
}

export async function verifyOcrFeedbackToken(env, token, userId, timestamp = new Date()) {
  if (typeof token !== "string" || token.length > MAX_TOKEN_LENGTH) throw new ApiError(400, "invalid_ocr_feedback_token");
  const parts = token.split(".");
  const secret = tokenSecret(env);
  if (parts.length !== 2 || !secret) throw new ApiError(400, "invalid_ocr_feedback_token");
  let payload;
  try {
    const expected = base64UrlEncode(await sign(secret, parts[0]));
    if (!timingSafeEqual(expected, parts[1])) throw new Error("signature");
    payload = JSON.parse(decoder.decode(base64UrlDecode(parts[0])));
  } catch {
    throw new ApiError(400, "invalid_ocr_feedback_token");
  }
  if (payload?.v !== 1 || payload.user_id !== userId || !/^[A-Za-z0-9_-]{8,128}$/u.test(payload.ocr_result_id || "")) {
    throw new ApiError(403, "ocr_feedback_token_mismatch");
  }
  const expiresAt = Date.parse(payload.expires_at);
  if (!Number.isFinite(expiresAt) || expiresAt < timestamp.getTime()) throw new ApiError(400, "expired_ocr_feedback_token");
  if (typeof payload.project_id !== "string" || !payload.project_id || !payload.original || typeof payload.original !== "object") {
    throw new ApiError(400, "invalid_ocr_feedback_token");
  }
  return payload;
}

function signedOriginal(result) {
  const original = {};
  for (const field of ["store_name", "total_amount", "paid_at", "paid_time"]) {
    const value = result[field];
    original[field] = {
      value: value == null ? "" : value,
      evidence: signedEvidence(result.field_evidence?.[field]),
    };
  }
  original.items = (Array.isArray(result.items) ? result.items : []).slice(0, 40).map((item, index) => ({
    source_id: boundedText(item.source_id || `item:${index}`, 64),
    name: boundedText(item.name, 200),
    amount: Number.isSafeInteger(Number(item.amount)) ? Number(item.amount) : null,
  })).filter((item) => item.name && item.amount > 0);
  return original;
}

function signedEvidence(value) {
  const evidence = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const box = Array.isArray(evidence.bounding_box) && evidence.bounding_box.length === 4
    ? evidence.bounding_box.map(Number)
    : null;
  return {
    source_id: boundedText(evidence.source_id || "root", 64),
    source_text: boundedText(evidence.source_text, 500),
    bounding_box: box?.every((entry) => Number.isFinite(entry) && entry >= 0 && entry <= 1) ? box : null,
    confidence: Math.max(0, Math.min(1, Number(evidence.confidence) || 0)),
    preprocessing: boundedText(evidence.preprocessing || "default", 100),
  };
}

async function sign(secret, value) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}

function tokenSecret(env) {
  const value = env.OCR_FEEDBACK_TOKEN_KEY_V1;
  return typeof value === "string" && value.length >= 32 ? value : "";
}

function boundedText(value, maximum) {
  return typeof value === "string" && value.trim() && value.length <= maximum ? value.trim() : "";
}
