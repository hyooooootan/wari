import { ApiError } from "./responses.js";
import { cookieHeader, clearCookieHeader, parseCookies } from "./auth.js";
import { randomToken, sha256Hex } from "./crypto.js";
import { extractGmailText } from "./gmail-mime.js";
import { parsePaymentNotification } from "./gmail-parsers.js";
import { createNotificationImport, reconcileImport } from "./imports.js";

const STATE_COOKIE = "wari_gmail_oauth";
const STATE_TTL_MS = 10 * 60 * 1000;
const DAYS = new Set([7, 30, 90]);
const encoder = new TextEncoder();

export async function startGmailOAuth(db, env, request, user) {
  requireConfig(env);
  const state = randomToken(32);
  const verifier = randomToken(48);
  const challenge = await base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(verifier))));
  const now = new Date();
  const redirectUri = gmailRedirectUri(env, request);
  await db.prepare(`INSERT INTO gmail_oauth_states (state_hash, user_id, created_at, expires_at, used_at) VALUES (?, ?, ?, ?, NULL)`)
    .bind(await sha256Hex(state), user.id, now.toISOString(), new Date(now.getTime() + STATE_TTL_MS).toISOString()).run();
  const parameters = new URLSearchParams({ client_id: env.GMAIL_CLIENT_ID, redirect_uri: redirectUri, response_type: "code",
    scope: "https://www.googleapis.com/auth/gmail.readonly", access_type: "offline", prompt: "consent", state,
    code_challenge: challenge, code_challenge_method: "S256", include_granted_scopes: "false" });
  return { url: `https://accounts.google.com/o/oauth2/v2/auth?${parameters}`, cookie: cookieHeader(STATE_COOKIE, `${state}.${verifier}`, { maxAge: 600, sameSite: "Lax" }) };
}

export async function finishGmailOAuth(db, env, request, user) {
  requireConfig(env);
  const url = new URL(request.url);
  const code = bounded(url.searchParams.get("code"), "code", 4096);
  const suppliedState = bounded(url.searchParams.get("state"), "state", 512);
  if (url.searchParams.get("error")) throw new ApiError(400, "gmail_oauth_denied");
  const cookieValue = parseCookies(request).get(STATE_COOKIE) || "";
  const separator = cookieValue.indexOf(".");
  const cookieState = separator > 0 ? cookieValue.slice(0, separator) : "";
  const verifier = separator > 0 ? cookieValue.slice(separator + 1) : "";
  if (!cookieState || !verifier || cookieState !== suppliedState) throw new ApiError(400, "invalid_gmail_oauth_state");
  const stateHash = await sha256Hex(suppliedState);
  const state = await db.prepare("SELECT * FROM gmail_oauth_states WHERE state_hash = ?").bind(stateHash).first();
  if (!state || state.user_id !== user.id || state.used_at || Date.parse(state.expires_at) <= Date.now()) throw new ApiError(400, "invalid_gmail_oauth_state");
  const usedAt = new Date().toISOString();
  const claimed = await db.prepare("UPDATE gmail_oauth_states SET used_at = ? WHERE state_hash = ? AND used_at IS NULL").bind(usedAt, stateHash).run();
  if (!claimed.meta?.changes) throw new ApiError(400, "invalid_gmail_oauth_state");
  const token = await googleForm(env, "https://oauth2.googleapis.com/token", { code, client_id: env.GMAIL_CLIENT_ID,
    client_secret: env.GMAIL_CLIENT_SECRET, redirect_uri: gmailRedirectUri(env, request), grant_type: "authorization_code", code_verifier: verifier });
  if (!token.refresh_token) throw new ApiError(400, "gmail_refresh_token_missing");
  const profile = await googleJson(env, "https://gmail.googleapis.com/gmail/v1/users/me/profile", token.access_token);
  const existing = await db.prepare("SELECT id FROM gmail_connections WHERE user_id = ? AND gmail_email = ?").bind(user.id, profile.emailAddress).first();
  const connectionId = existing?.id || crypto.randomUUID();
  const encrypted = await encryptRefreshToken(env, connectionId, user.id, token.refresh_token);
  await db.prepare(`INSERT INTO gmail_connections (id,user_id,gmail_email,refresh_token_ciphertext,refresh_token_iv,key_generation,aad_version,status,created_at,updated_at)
    VALUES (?,?,?,?,?,?,1,'active',?,?) ON CONFLICT(user_id,gmail_email) DO UPDATE SET refresh_token_ciphertext=excluded.refresh_token_ciphertext,
    refresh_token_iv=excluded.refresh_token_iv,key_generation=excluded.key_generation,aad_version=1,status='active',updated_at=excluded.updated_at`)
    .bind(connectionId, user.id, profile.emailAddress, encrypted.ciphertext, encrypted.iv, encrypted.key_generation, usedAt, usedAt).run();
  return { connection_id: connectionId, clearCookie: clearCookieHeader(STATE_COOKIE) };
}

export async function listConnections(db, user) {
  const result = await db.prepare(`SELECT id,gmail_email,status,created_at,updated_at,last_synced_at FROM gmail_connections WHERE user_id=? AND status!='disconnected' ORDER BY created_at`).bind(user.id).all();
  return { connections: result.results || [] };
}

export async function disconnectGmail(db, env, user, connectionId) {
  const connection = await ownedConnection(db, user, connectionId);
  try { const token = await decryptRefreshToken(env, connection); await googleForm(env, "https://oauth2.googleapis.com/revoke", { token }); } catch {}
  await db.prepare(`UPDATE gmail_connections SET refresh_token_ciphertext='',refresh_token_iv='',status='disconnected',updated_at=? WHERE id=? AND user_id=?`)
    .bind(new Date().toISOString(), connectionId, user.id).run();
  return { ok: true };
}

export async function syncGmail(db, env, user, connectionId, input = {}) {
  const days = Number(input.days ?? 30); const limit = Number(input.limit ?? 100);
  if (!DAYS.has(days)) throw new ApiError(400, "invalid_field", { field: "days" });
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new ApiError(400, "invalid_field", { field: "limit" });
  const connection = await ownedConnection(db, user, connectionId); const started = new Date().toISOString(); const runId = crypto.randomUUID();
  await db.prepare(`INSERT INTO gmail_sync_runs (id,connection_id,user_id,days,message_limit,status,started_at) VALUES (?,?,?,?,?,'running',?)`).bind(runId,connectionId,user.id,days,limit,started).run();
  let listed=0,processed=0,candidates=0,duplicates=0,errors=0,status="completed",errorCode=null;
  try {
    const refresh = await decryptRefreshToken(env, connection);
    const token = await googleForm(env, "https://oauth2.googleapis.com/token", { client_id:env.GMAIL_CLIENT_ID,client_secret:env.GMAIL_CLIENT_SECRET,refresh_token:refresh,grant_type:"refresh_token" });
    const after = Math.floor((Date.now()-days*86400000)/1000);
    const listing = await googleJson(env, `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${limit}&q=${encodeURIComponent(`after:${after}`)}`, token.access_token);
    const messages=(listing.messages||[]).slice(0,limit); listed=messages.length;
    for (const item of messages) {
      const exists=await db.prepare("SELECT id FROM gmail_messages WHERE connection_id=? AND gmail_message_id=?").bind(connectionId,item.id).first();
      if(exists){duplicates++;continue;}
      try {
        const message=await googleJson(env,`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(item.id)}?format=full`,token.access_token);
        const headers=Object.fromEntries((message.payload?.headers||[]).map(h=>[String(h.name).toLowerCase(),h.value]));
        const parsed=parsePaymentNotification(extractGmailText(message.payload),headers); const messageRowId=crypto.randomUUID(); const candidateId=crypto.randomUUID();
        await db.prepare(`INSERT INTO gmail_messages (id,connection_id,gmail_message_id,sync_run_id,parse_status,provider,received_at,created_at) VALUES (?,?,?,?,?,?,?,?)`)
          .bind(messageRowId,connectionId,item.id,runId,parsed.parse_status,parsed.provider,headers.date&&Number.isFinite(Date.parse(headers.date))?new Date(headers.date).toISOString():null,new Date().toISOString()).run();
        const warning=parsed.amount!==null&&parsed.occurred_at?await duplicateWarning(db,user.id,parsed.amount,parsed.occurred_at):0;
        await db.prepare(`INSERT INTO gmail_import_candidates (id,connection_id,gmail_message_row_id,user_id,status,provider,merchant_name,amount,occurred_at,payment_method,external_transaction_id,duplicate_warning,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .bind(candidateId,connectionId,messageRowId,user.id,parsed.parse_status === "parsed" ? "ready" : parsed.parse_status,parsed.provider,parsed.merchant_name,parsed.amount,parsed.occurred_at,parsed.payment_method,parsed.external_transaction_id,warning,new Date().toISOString(),new Date().toISOString()).run();
        processed++;candidates++;
      } catch(error){errors++;status=error?.status===401?"reauthorization_required":error?.status===429?"rate_limited":"partial";errorCode=safeErrorCode(error);if(status!=="partial")break;}
    }
  } catch(error) {
    errors++; errorCode=safeErrorCode(error); status=error?.status===401?"reauthorization_required":error?.status===429?"rate_limited":"failed";
    if(status==="reauthorization_required") await db.prepare("UPDATE gmail_connections SET status='reauthorization_required',updated_at=? WHERE id=?").bind(new Date().toISOString(),connectionId).run();
  }
  if(status==="reauthorization_required") await db.prepare("UPDATE gmail_connections SET status='reauthorization_required',updated_at=? WHERE id=?").bind(new Date().toISOString(),connectionId).run();
  const finished=new Date().toISOString();
  await db.prepare(`UPDATE gmail_sync_runs SET status=?,listed_count=?,processed_count=?,candidate_count=?,duplicate_count=?,error_count=?,error_code=?,finished_at=? WHERE id=?`)
    .bind(status,listed,processed,candidates,duplicates,errors,errorCode,finished,runId).run();
  await db.prepare("UPDATE gmail_connections SET last_synced_at=?,updated_at=? WHERE id=?").bind(finished,finished,connectionId).run();
  return { run: await db.prepare("SELECT * FROM gmail_sync_runs WHERE id=?").bind(runId).first() };
}

export async function listSyncRuns(db,user,connectionId){await ownedConnection(db,user,connectionId);const rows=await db.prepare("SELECT * FROM gmail_sync_runs WHERE connection_id=? AND user_id=? ORDER BY started_at DESC LIMIT 50").bind(connectionId,user.id).all();return{sync_runs:rows.results||[]};}
export async function listCandidates(db,user,status){const values=[user.id];let condition="user_id=?";if(status){condition+=" AND status=?";values.push(status);}const rows=await db.prepare(`SELECT * FROM gmail_import_candidates WHERE ${condition} ORDER BY created_at DESC LIMIT 200`).bind(...values).all();return{candidates:rows.results||[]};}
export async function updateCandidate(db,user,id,input){const row=await ownedCandidate(db,user,id);const allowed=new Set(["merchant_name","amount","occurred_at","payment_method","external_transaction_id","status"]);if(!input||typeof input!=="object"||Array.isArray(input)||Object.keys(input).some(k=>!allowed.has(k)))throw new ApiError(400,"invalid_json_body");
  const next={...row,...input};if(input.status&&!new Set(["needs_review","ready","ignored"]).has(input.status))throw new ApiError(400,"invalid_field",{field:"status"});if(next.amount!==null&&(!Number.isSafeInteger(next.amount)))throw new ApiError(400,"invalid_field",{field:"amount"});
  await db.prepare(`UPDATE gmail_import_candidates SET merchant_name=?,amount=?,occurred_at=?,payment_method=?,external_transaction_id=?,status=?,updated_at=? WHERE id=? AND user_id=?`).bind(next.merchant_name,next.amount,next.occurred_at,next.payment_method,next.external_transaction_id,next.status,new Date().toISOString(),id,user.id).run();return{candidate:await ownedCandidate(db,user,id)};}
export async function importCandidate(db,user,id,input){const candidate=await ownedCandidate(db,user,id);if(candidate.status==="imported"||candidate.status==="ignored")throw new ApiError(409,"candidate_not_importable");const projectId=bounded(input?.project_id,"project_id",128);
  const project=await db.prepare(`SELECT p.id FROM projects p JOIN project_user_roles r ON r.project_id=p.id AND r.user_id=? AND r.role='owner' AND r.revoked_at IS NULL WHERE p.id=? AND p.project_type='household'`).bind(user.id,projectId).first();if(!project)throw new ApiError(403,"gmail_import_target_forbidden");
  if(!candidate.merchant_name||candidate.amount===null||!candidate.occurred_at)throw new ApiError(409,"candidate_incomplete");
  const message=await db.prepare("SELECT gmail_message_id FROM gmail_messages WHERE id=?").bind(candidate.gmail_message_row_id).first();
  const result=await createNotificationImport(db,projectId,{source_record_id:`gmail:${candidate.connection_id}:${message.gmail_message_id}`,merchant_name:candidate.merchant_name,paid_amount:candidate.amount,gross_amount:candidate.amount,occurred_at:candidate.occurred_at,payment_method:candidate.payment_method,external_transaction_id:candidate.external_transaction_id,raw_text:null,raw_payload:null,provider:candidate.provider},{reconcile:false});
  const created=await reconcileImport(db,projectId,result.import.id,"create",{});await db.prepare("UPDATE gmail_import_candidates SET status='imported',imported_project_id=?,import_record_id=?,updated_at=? WHERE id=? AND user_id=?").bind(projectId,result.import.id,new Date().toISOString(),id,user.id).run();return{candidate:await ownedCandidate(db,user,id),import:result.import,transaction:created.transaction};}

export async function encryptRefreshToken(env,connectionId,userId,token){const generation=keyGeneration(env);const key=await tokenKey(env,generation);const iv=crypto.getRandomValues(new Uint8Array(12));const aad=encoder.encode(`gmail-token:v1:${connectionId}:${userId}:${generation}`);const encrypted=await crypto.subtle.encrypt({name:"AES-GCM",iv,additionalData:aad},key,encoder.encode(token));return{ciphertext:base64(new Uint8Array(encrypted)),iv:base64(iv),key_generation:generation,aad_version:1};}
export async function decryptRefreshToken(env,connection){if(connection.aad_version!==1)throw new ApiError(500,"unsupported_gmail_token_aad");const key=await tokenKey(env,connection.key_generation);try{const decrypted=await crypto.subtle.decrypt({name:"AES-GCM",iv:fromBase64(connection.refresh_token_iv),additionalData:encoder.encode(`gmail-token:v1:${connection.id}:${connection.user_id}:${connection.key_generation}`)},key,fromBase64(connection.refresh_token_ciphertext));return new TextDecoder().decode(decrypted);}catch{throw new ApiError(500,"gmail_token_decryption_failed");}}
async function ownedConnection(db,user,id){const row=await db.prepare("SELECT * FROM gmail_connections WHERE id=? AND user_id=? AND status!='disconnected'").bind(id,user.id).first();if(!row)throw new ApiError(404,"not_found");return row;}
async function ownedCandidate(db,user,id){const row=await db.prepare("SELECT * FROM gmail_import_candidates WHERE id=? AND user_id=?").bind(id,user.id).first();if(!row)throw new ApiError(404,"not_found");return row;}
async function duplicateWarning(db,userId,amount,occurredAt){const start=new Date(Date.parse(occurredAt)-7*86400000).toISOString(),end=new Date(Date.parse(occurredAt)+7*86400000).toISOString();const row=await db.prepare(`SELECT 1 FROM gmail_import_candidates WHERE user_id=? AND amount=? AND occurred_at BETWEEN ? AND ? LIMIT 1`).bind(userId,amount,start,end).first();return row?1:0;}
function keyGeneration(env){const value=Number(env.GMAIL_TOKEN_KEY_CURRENT_GENERATION);if(!Number.isInteger(value)||value<1)throw new ApiError(500,"invalid_gmail_token_key_generation");return value;}
async function tokenKey(env,generation){const raw=env[`GMAIL_TOKEN_KEY_V${generation}`];if(!raw)throw new ApiError(500,"missing_gmail_token_key");const bytes=fromBase64(raw);if(bytes.length!==32)throw new ApiError(500,"invalid_gmail_token_key");return crypto.subtle.importKey("raw",bytes,"AES-GCM",false,["encrypt","decrypt"]);}
async function googleForm(env,url,body){const response=await fetcher(env)(url,{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams(body)});if(!response.ok)throw apiFailure(response.status);return response.json();}
async function googleJson(env,url,accessToken){const response=await fetcher(env)(url,{headers:{authorization:`Bearer ${accessToken}`}});if(!response.ok)throw apiFailure(response.status);return response.json();}
function apiFailure(status){const error=new ApiError(status===401?401:status===429?429:502,status===401?"gmail_unauthorized":status===429?"gmail_rate_limited":"gmail_api_error");error.status=status;return error;}
function fetcher(env){return env.GMAIL_FETCH||fetch;}
function requireConfig(env){if(!env.GMAIL_CLIENT_ID||!env.GMAIL_CLIENT_SECRET)throw new ApiError(500,"missing_gmail_oauth_config");}
function gmailRedirectUri(env,request){return env.GMAIL_REDIRECT_URI||new URL("/api/gmail/oauth/callback",request.url).toString();}
function bounded(value,field,max){if(typeof value!=="string"||!value.trim()||value.length>max)throw new ApiError(400,"invalid_field",{field});return value.trim();}
function safeErrorCode(error){return String(error?.code||"gmail_sync_error").slice(0,80);}
function base64(bytes){let value="";for(const byte of bytes)value+=String.fromCharCode(byte);return btoa(value);}
function fromBase64(value){return Uint8Array.from(atob(value),c=>c.charCodeAt(0));}
async function base64Url(bytes){return base64(bytes).replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_");}
