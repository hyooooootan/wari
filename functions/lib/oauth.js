import { ApiError } from "./responses.js";
import { OAUTH_COOKIE, clearCookieHeader, cookieHeader, parseCookies } from "./auth.js";
import { base64UrlDecode, randomToken, sha256Hex, timingSafeEqual } from "./crypto.js";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_CERTS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const OAUTH_TTL_SECONDS = 600;

export async function createGoogleStart(db, env, request, timestamp = now()) {
  const appOrigin = env.APP_ORIGIN || new URL(request.url).origin;
  const redirectUri = env.OAUTH_REDIRECT_URI || `${appOrigin}/api/auth/google/callback`;
  const clientId = requiredEnv(env, "GOOGLE_CLIENT_ID");
  const state = randomToken(32);
  const verifier = randomToken(48);
  const challenge = await pkceChallenge(verifier);
  const expiresAt = new Date(Date.parse(timestamp) + OAUTH_TTL_SECONDS * 1000).toISOString();
  await db.prepare(`INSERT INTO oauth_states (
    state_hash, code_verifier_hash, redirect_uri, created_at, expires_at, used_at
  ) VALUES (?, ?, ?, ?, ?, NULL)`).bind(
    await sha256Hex(state),
    await sha256Hex(verifier),
    redirectUri,
    timestamp,
    expiresAt,
  ).run();
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("access_type", "online");
  return {
    url: url.toString(),
    cookie: cookieHeader(OAUTH_COOKIE, JSON.stringify({ state, verifier }), {
      httpOnly: true,
      maxAge: OAUTH_TTL_SECONDS,
      expires: new Date(expiresAt),
    }),
  };
}

export async function finishGoogleCallback(db, env, request, timestamp = now()) {
  const url = new URL(request.url);
  const code = bounded(url.searchParams.get("code"), "code", 1, 2048);
  const state = bounded(url.searchParams.get("state"), "state", 16, 512);
  const cookie = parseOAuthCookie(request);
  if (!timingSafeEqual(cookie.state, state)) throw new ApiError(400, "invalid_oauth_state");
  const stateHash = await sha256Hex(state);
  const row = await db.prepare(`SELECT * FROM oauth_states
    WHERE state_hash = ?
      AND expires_at > ?
      AND used_at IS NULL`).bind(stateHash, timestamp).first();
  if (!row) throw new ApiError(400, "invalid_oauth_state");
  if (!timingSafeEqual(row.code_verifier_hash, await sha256Hex(cookie.verifier))) throw new ApiError(400, "invalid_oauth_state");
  const claimed = await db.prepare(`UPDATE oauth_states SET used_at = ?
    WHERE state_hash = ? AND used_at IS NULL AND expires_at > ?`).bind(timestamp, stateHash, timestamp).run();
  if (changedRows(claimed) !== 1) throw new ApiError(400, "invalid_oauth_state");
  const profile = env.OAUTH_MOCK_USER_JSON && env.CF_PAGES !== "1"
    ? parseMockProfile(env.OAUTH_MOCK_USER_JSON)
    : await exchangeAndVerify(env, code, cookie.verifier, row.redirect_uri);
  return { profile, clearCookie: clearCookieHeader(OAUTH_COOKIE) };
}

async function exchangeAndVerify(env, code, verifier, redirectUri) {
  const clientId = requiredEnv(env, "GOOGLE_CLIENT_ID");
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: requiredEnv(env, "GOOGLE_CLIENT_SECRET"),
      code,
      code_verifier: verifier,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }),
  });
  if (!response.ok) throw new ApiError(401, "oauth_exchange_failed");
  const token = await response.json();
  if (typeof token.id_token !== "string") throw new ApiError(401, "oauth_exchange_failed");
  return verifyGoogleIdToken(token.id_token, clientId);
}

async function verifyGoogleIdToken(idToken, audience) {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new ApiError(401, "invalid_id_token");
  const header = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[0])));
  const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[1])));
  if (!["accounts.google.com", "https://accounts.google.com"].includes(payload.iss)) throw new ApiError(401, "invalid_id_token");
  if (payload.aud !== audience) throw new ApiError(401, "invalid_id_token");
  if (typeof payload.exp !== "number" || payload.exp * 1000 <= Date.now()) throw new ApiError(401, "invalid_id_token");
  if (payload.email_verified !== true && payload.email_verified !== "true") throw new ApiError(401, "email_not_verified");
  const jwk = await googleKey(header.kid);
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    base64UrlDecode(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!valid) throw new ApiError(401, "invalid_id_token");
  return {
    sub: String(payload.sub || ""),
    email: String(payload.email || ""),
    name: typeof payload.name === "string" ? payload.name : null,
  };
}

async function googleKey(kid) {
  const response = await fetch(GOOGLE_CERTS_URL, { headers: { accept: "application/json" } });
  if (!response.ok) throw new ApiError(503, "oauth_provider_unavailable");
  const body = await response.json();
  const key = Array.isArray(body.keys) ? body.keys.find((entry) => entry.kid === kid) : null;
  if (!key) throw new ApiError(401, "invalid_id_token");
  return key;
}

function parseOAuthCookie(request) {
  const raw = parseCookies(request).get(OAUTH_COOKIE);
  if (!raw) throw new ApiError(400, "invalid_oauth_state");
  try {
    const value = JSON.parse(raw);
    return {
      state: bounded(value.state, "state", 16, 512),
      verifier: bounded(value.verifier, "verifier", 32, 512),
    };
  } catch {
    throw new ApiError(400, "invalid_oauth_state");
  }
}

function parseMockProfile(value) {
  try {
    const profile = JSON.parse(value);
    return {
      sub: bounded(profile.sub, "sub", 1, 255),
      email: bounded(profile.email, "email", 3, 320),
      name: typeof profile.name === "string" ? profile.name : null,
    };
  } catch {
    throw new ApiError(500, "invalid_oauth_mock");
  }
}

async function pkceChallenge(verifier) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const bytes = new Uint8Array(digest);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function requiredEnv(env, name) {
  const value = env?.[name];
  if (typeof value !== "string" || value.trim() === "") throw new ApiError(500, `missing_${name.toLowerCase()}`);
  return value.trim();
}

function bounded(value, field, minimum, maximum) {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum) throw new ApiError(400, `invalid_${field}`);
  return value;
}

function now() {
  return new Date().toISOString();
}

function changedRows(result) {
  return Number(result?.meta?.changes ?? result?.changes ?? result?.meta?.rows_written ?? 0);
}
