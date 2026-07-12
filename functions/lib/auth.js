import { ApiError } from "./responses.js";
import { randomToken, sha256Hex, timingSafeEqual } from "./crypto.js";

export const SESSION_COOKIE = "wari_session";
export const CSRF_COOKIE = "wari_csrf";
export const OAUTH_COOKIE = "wari_oauth";

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

export function parseCookies(request) {
  const header = request.headers.get("cookie") || "";
  const cookies = new Map();
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name) cookies.set(name, decodeURIComponent(value));
  }
  return cookies;
}

export function cookieHeader(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push("Path=/");
  parts.push("Secure");
  if (options.httpOnly !== false) parts.push("HttpOnly");
  parts.push(`SameSite=${options.sameSite || "Lax"}`);
  if (options.maxAge !== undefined) parts.push(`Max-Age=${Number(options.maxAge)}`);
  if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`);
  return parts.join("; ");
}

export function clearCookieHeader(name) {
  return cookieHeader(name, "", { maxAge: 0, expires: new Date(0) });
}

export async function ensureUser(db, profile, timestamp = now()) {
  const sub = requiredString(profile.sub, "sub", 255);
  const email = requiredString(profile.email, "email", 320);
  const name = typeof profile.name === "string" && profile.name.trim() ? profile.name.trim().slice(0, 320) : null;
  const existing = await db.prepare("SELECT * FROM users WHERE google_sub = ?").bind(sub).first();
  if (existing) {
    await db.prepare(`UPDATE users
      SET email = ?, name = ?, deleted_at = NULL, updated_at = ?
      WHERE id = ?`).bind(email, name, timestamp, existing.id).run();
    return { ...existing, email, name, deleted_at: null, updated_at: timestamp };
  }
  const user = {
    id: `usr_${crypto.randomUUID()}`,
    google_sub: sub,
    email,
    name,
    created_at: timestamp,
    updated_at: timestamp,
    deleted_at: null,
  };
  await db.prepare(`INSERT INTO users (
    id, google_sub, email, name, created_at, updated_at, deleted_at
  ) VALUES (?, ?, ?, ?, ?, ?, NULL)`).bind(
    user.id,
    user.google_sub,
    user.email,
    user.name,
    user.created_at,
    user.updated_at,
  ).run();
  return user;
}

export async function createSession(db, userId, timestamp = now()) {
  const sessionId = randomToken(32);
  const csrfToken = randomToken(32);
  const sessionHash = await sha256Hex(sessionId);
  const expiresAt = new Date(Date.parse(timestamp) + SESSION_TTL_SECONDS * 1000).toISOString();
  await db.prepare(`INSERT INTO sessions (
    id_hash, user_id, csrf_token, created_at, expires_at, revoked_at
  ) VALUES (?, ?, ?, ?, ?, NULL)`).bind(sessionHash, userId, csrfToken, timestamp, expiresAt).run();
  return { sessionId, csrfToken, expiresAt };
}

export async function getSessionUser(db, request, timestamp = now()) {
  const sessionId = parseCookies(request).get(SESSION_COOKIE);
  if (!sessionId) return null;
  const sessionHash = await sha256Hex(sessionId);
  const row = await db.prepare(`SELECT sessions.*, users.google_sub, users.email, users.name, users.deleted_at
    FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.id_hash = ?
      AND sessions.revoked_at IS NULL
      AND sessions.expires_at > ?`).bind(sessionHash, timestamp).first();
  if (!row || row.deleted_at) return null;
  return {
    id: row.user_id,
    google_sub: row.google_sub,
    email: row.email,
    name: row.name,
    session_hash: row.id_hash,
    csrf_token: row.csrf_token,
    expires_at: row.expires_at,
  };
}

export async function requireUser(db, request) {
  const user = await getSessionUser(db, request);
  if (!user) throw new ApiError(401, "authentication_required");
  return user;
}

export async function revokeCurrentSession(db, request, timestamp = now()) {
  const sessionId = parseCookies(request).get(SESSION_COOKIE);
  if (!sessionId) return;
  await db.prepare("UPDATE sessions SET revoked_at = ? WHERE id_hash = ?").bind(timestamp, await sha256Hex(sessionId)).run();
}

export function assertCsrf(request, user) {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) return;
  const header = request.headers.get("x-csrf-token") || "";
  const cookie = parseCookies(request).get(CSRF_COOKIE) || "";
  if (!header || !cookie || !timingSafeEqual(header, user.csrf_token) || !timingSafeEqual(cookie, user.csrf_token)) {
    throw new ApiError(403, "csrf_failed");
  }
}

export function sessionCookieHeaders(session) {
  return [
    cookieHeader(SESSION_COOKIE, session.sessionId, {
      httpOnly: true,
      maxAge: SESSION_TTL_SECONDS,
      expires: new Date(session.expiresAt),
    }),
    cookieHeader(CSRF_COOKIE, session.csrfToken, {
      httpOnly: false,
      maxAge: SESSION_TTL_SECONDS,
      expires: new Date(session.expiresAt),
    }),
  ];
}

function requiredString(value, field, maximum) {
  if (typeof value !== "string" || value.trim() === "" || value.length > maximum) throw new ApiError(400, `invalid_${field}`);
  return value.trim();
}

function now() {
  return new Date().toISOString();
}
