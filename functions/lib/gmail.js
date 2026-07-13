import { ApiError } from "./responses.js";
import { cookieHeader, clearCookieHeader, parseCookies } from "./auth.js";
import { randomToken, sha256Hex } from "./crypto.js";
import { extractGmailText } from "./gmail-mime.js";
import { parsePaymentNotification } from "./gmail-parsers.js";
import { normalizeDate, normalizeMerchantName, normalizePaymentMethod } from "./normalization.js";

const STATE_COOKIE = "wari_gmail_oauth";
const STATE_TTL_MS = 10 * 60 * 1000;
const DAYS = new Set([7, 30, 90]);
const encoder = new TextEncoder();

export async function startGmailOAuth(db, env, request, user, projectId) {
  requireConfig(env);
  projectId=bounded(projectId,"project_id",128);
  await requirePersonalHousehold(db,user.id,projectId);
  const state = randomToken(32);
  const verifier = randomToken(48);
  const challenge = await base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(verifier))));
  const now = new Date();
  const redirectUri = gmailRedirectUri(env, request);
  await db.prepare(`INSERT INTO gmail_oauth_states (state_hash, user_id, project_id, created_at, expires_at, used_at) VALUES (?, ?, ?, ?, ?, NULL)`)
    .bind(await sha256Hex(state), user.id, projectId, now.toISOString(), new Date(now.getTime() + STATE_TTL_MS).toISOString()).run();
  const parameters = new URLSearchParams({ client_id: env.GMAIL_CLIENT_ID, redirect_uri: redirectUri, response_type: "code",
    scope: "https://www.googleapis.com/auth/gmail.readonly", access_type: "offline", prompt: "consent", state,
    code_challenge: challenge, code_challenge_method: "S256", include_granted_scopes: "false" });
  return { url: `https://accounts.google.com/o/oauth2/v2/auth?${parameters}`, cookie: cookieHeader(STATE_COOKIE, `${state}.${verifier}`, { maxAge: 600, sameSite: "Lax" }) };
}

export async function finishGmailOAuth(db, env, request, user) {
  requireConfig(env);
  const url = new URL(request.url);
  const suppliedState = bounded(url.searchParams.get("state"), "state", 512);
  const cookieValue = parseCookies(request).get(STATE_COOKIE) || "";
  const separator = cookieValue.indexOf(".");
  const cookieState = separator > 0 ? cookieValue.slice(0, separator) : "";
  const verifier = separator > 0 ? cookieValue.slice(separator + 1) : "";
  if (!cookieState || !verifier || cookieState !== suppliedState) throw new ApiError(400, "invalid_gmail_oauth_state");
  const stateHash = await sha256Hex(suppliedState);
  const state = await db.prepare("SELECT * FROM gmail_oauth_states WHERE state_hash = ?").bind(stateHash).first();
  if (!state || state.user_id !== user.id || !state.project_id || state.used_at || Date.parse(state.expires_at) <= Date.now()) throw new ApiError(400, "invalid_gmail_oauth_state");
  const usedAt = new Date().toISOString();
  const claimed = await db.prepare("UPDATE gmail_oauth_states SET used_at = ? WHERE state_hash = ? AND used_at IS NULL").bind(usedAt, stateHash).run();
  if (!claimed.meta?.changes) throw new ApiError(400, "invalid_gmail_oauth_state");
  if (url.searchParams.get("error")) throw new ApiError(400, "gmail_oauth_denied");
  await requirePersonalHousehold(db,user.id,state.project_id);
  const code = bounded(url.searchParams.get("code"), "code", 4096);
  const token = await googleForm(env, "https://oauth2.googleapis.com/token", { code, client_id: env.GMAIL_CLIENT_ID,
    client_secret: env.GMAIL_CLIENT_SECRET, redirect_uri: gmailRedirectUri(env, request), grant_type: "authorization_code", code_verifier: verifier });
  if (!token.refresh_token) throw new ApiError(400, "gmail_refresh_token_missing");
  const profile = await googleJson(env, "https://gmail.googleapis.com/gmail/v1/users/me/profile", token.access_token);
  const gmailEmail = normalizeGmailEmail(profile.emailAddress);
  const existing = await db.prepare("SELECT id FROM gmail_connections WHERE user_id = ? AND lower(trim(gmail_email)) = ? ORDER BY created_at, id LIMIT 1").bind(user.id, gmailEmail).first();
  const connectionId = existing?.id || `gmail_${(await sha256Hex(`gmail-connection:v1:${user.id}:${gmailEmail}`)).slice(0,48)}`;
  const encrypted = await encryptRefreshToken(env, connectionId, user.id, token.refresh_token);
  const personalSql = personalHouseholdExistsSql();
  const personalBindings = personalHouseholdBindings(user.id, state.project_id, usedAt);
  const activeUserSql = "SELECT 1 FROM users WHERE id=? AND deleted_at IS NULL AND deletion_started_at IS NULL";
  const connectionWrite = existing
    ? db.prepare(`UPDATE gmail_connections SET gmail_email=?,refresh_token_ciphertext=?,refresh_token_iv=?,key_generation=?,aad_version=1,status='active',updated_at=? WHERE id=? AND user_id=? AND EXISTS(${personalSql}) AND EXISTS(${activeUserSql})`)
      .bind(gmailEmail,encrypted.ciphertext,encrypted.iv,encrypted.key_generation,usedAt,connectionId,user.id,...personalBindings,user.id)
    : db.prepare(`INSERT INTO gmail_connections (id,user_id,gmail_email,refresh_token_ciphertext,refresh_token_iv,key_generation,aad_version,status,created_at,updated_at)
      SELECT ?,?,?,?,?,?,1,'active',?,? WHERE EXISTS(${personalSql}) AND EXISTS(${activeUserSql})
      ON CONFLICT(user_id,gmail_email) DO UPDATE SET refresh_token_ciphertext=excluded.refresh_token_ciphertext,
      refresh_token_iv=excluded.refresh_token_iv,key_generation=excluded.key_generation,aad_version=1,status='active',updated_at=excluded.updated_at`)
      .bind(connectionId,user.id,gmailEmail,encrypted.ciphertext,encrypted.iv,encrypted.key_generation,usedAt,usedAt,...personalBindings,user.id);
  const results = await db.batch([
    db.prepare(`UPDATE gmail_oauth_states SET used_at=used_at WHERE state_hash=? AND used_at=? AND project_id=? AND EXISTS(${personalSql}) AND EXISTS(${activeUserSql})`).bind(stateHash, usedAt, state.project_id, ...personalBindings, user.id),
    connectionWrite,
  ]);
  if (!changedRows(results[0]) || !changedRows(results[1])) {
    const activeUser = await db.prepare(`SELECT 1 AS active FROM users
      WHERE id=? AND deleted_at IS NULL AND deletion_started_at IS NULL`).bind(user.id).first();
    throw new ApiError(403, activeUser ? "gmail_personal_household_required" : "account_unavailable");
  }
  return { connection_id: connectionId, clearCookie: clearCookieHeader(STATE_COOKIE) };
}

export async function listConnections(db, user) {
  const result = await db.prepare(`SELECT id,gmail_email,status,created_at,updated_at,last_synced_at FROM gmail_connections WHERE user_id=? AND status!='disconnected' ORDER BY created_at`).bind(user.id).all();
  return { connections: result.results || [] };
}

export async function disconnectGmail(db, env, user, connectionId) {
  const connection = await ownedConnection(db, user, connectionId);
  const token = await decryptRefreshToken(env, connection);
  await revokeGoogleToken(env, token);
  await db.prepare(`UPDATE gmail_connections SET refresh_token_ciphertext='',refresh_token_iv='',status='disconnected',updated_at=? WHERE id=? AND user_id=?`)
    .bind(new Date().toISOString(), connectionId, user.id).run();
  return { ok: true };
}

export async function disconnectAllGmail(db, env, user) {
  const rows = await db.prepare("SELECT * FROM gmail_connections WHERE user_id=? AND refresh_token_ciphertext!=''").bind(user.id).all();
  for (const connection of rows.results || []) {
    const token = await decryptRefreshToken(env, connection);
    await revokeGoogleToken(env, token);
  }
  const timestamp = new Date().toISOString();
  await db.prepare("UPDATE gmail_connections SET refresh_token_ciphertext='',refresh_token_iv='',status='disconnected',updated_at=? WHERE user_id=?").bind(timestamp,user.id).run();
}

export async function syncGmail(db, env, user, connectionId, input = {}) {
  const days = Number(input.days ?? 30); const limit = Number(input.limit ?? 100);
  if (!DAYS.has(days)) throw new ApiError(400, "invalid_field", { field: "days" });
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new ApiError(400, "invalid_field", { field: "limit" });
  const syncProject = await requireAnyPersonalHousehold(db,user.id);
  const connection = await ownedConnection(db, user, connectionId); const started = new Date().toISOString(); const runId = crypto.randomUUID();
  await db.prepare(`INSERT INTO gmail_sync_runs (id,connection_id,user_id,days,message_limit,status,started_at) VALUES (?,?,?,?,?,'running',?)`).bind(runId,connectionId,user.id,days,limit,started).run();
  let listed=0,processed=0,candidates=0,duplicates=0,errors=0,status="completed",errorCode=null;
  try {
    const refresh = await decryptRefreshToken(env, connection);
    const token = await googleForm(env, "https://oauth2.googleapis.com/token", { client_id:env.GMAIL_CLIENT_ID,client_secret:env.GMAIL_CLIENT_SECRET,refresh_token:refresh,grant_type:"refresh_token" });
    const after = Math.floor((Date.now()-days*86400000)/1000);
    const listing = await googleJson(env, `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${limit}&q=${encodeURIComponent(`after:${after}`)}`, token.access_token);
    const messages=(listing.messages||[]).slice(0,limit); listed=messages.length;
    const pending=[];
    for (const item of messages) {
      const exists=await db.prepare(`SELECT m.id,c.id AS candidate_id FROM gmail_messages m LEFT JOIN gmail_import_candidates c ON c.gmail_message_row_id=m.id WHERE m.connection_id=? AND m.gmail_message_id=?`).bind(connectionId,item.id).first();
      if(exists?.candidate_id){duplicates++;continue;}
      try {
        const message=await googleJson(env,`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(item.id)}?format=full`,token.access_token);
        const headers=Object.fromEntries((message.payload?.headers||[]).map(h=>[String(h.name).toLowerCase(),h.value]));
        const parsed=parsePaymentNotification(extractGmailText(message.payload),headers); const messageRowId=exists?.id||crypto.randomUUID(); const candidateId=crypto.randomUUID();
        const warning=parsed.amount!==null&&parsed.occurred_at?await duplicateWarning(db,user.id,parsed.amount,parsed.occurred_at):0;
        const now=new Date().toISOString();
        pending.push({ exists: Boolean(exists), messageRowId, candidateId, gmailMessageId:item.id, parsed,
          receivedAt:headers.date&&Number.isFinite(Date.parse(headers.date))?new Date(headers.date).toISOString():null, warning, now });
      } catch(error){errors++;status=error?.status===401?"reauthorization_required":error?.status===429?"rate_limited":"partial";errorCode=safeErrorCode(error);if(status!=="partial")break;}
    }
    if(pending.length){
      const checkedAt=new Date().toISOString();
      const personalSql=personalHouseholdExistsSql();
      const personalBindings=personalHouseholdBindings(user.id,syncProject.id,checkedAt);
      const statements=[db.prepare(`UPDATE gmail_sync_runs SET status=status WHERE id=? AND user_id=? AND EXISTS(${personalSql})`).bind(runId,user.id,...personalBindings)];
      for(const record of pending){
        if(!record.exists){statements.push(db.prepare(`INSERT INTO gmail_messages (id,connection_id,gmail_message_id,sync_run_id,parse_status,provider,received_at,created_at)
          SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(${personalSql})`).bind(record.messageRowId,connectionId,record.gmailMessageId,runId,record.parsed.parse_status,record.parsed.provider,record.receivedAt,record.now,...personalBindings));}
        statements.push(db.prepare(`INSERT INTO gmail_import_candidates (id,connection_id,gmail_message_row_id,user_id,status,provider,merchant_name,amount,occurred_at,payment_method,external_transaction_id,duplicate_warning,created_at,updated_at)
          SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(${personalSql})`).bind(record.candidateId,connectionId,record.messageRowId,user.id,record.parsed.parse_status === "parsed" ? "ready" : record.parsed.parse_status,record.parsed.provider,record.parsed.merchant_name,record.parsed.amount,record.parsed.occurred_at,record.parsed.payment_method,record.parsed.external_transaction_id,record.warning,record.now,record.now,...personalBindings));
      }
      const results=await db.batch(statements);
      if(!changedRows(results[0]))throw new ApiError(403,"gmail_personal_household_lost");
      processed+=pending.length;candidates+=pending.length;
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
export async function updateCandidate(db,user,id,input){const row=await ownedCandidate(db,user,id);if(row.status==="imported"||row.imported_project_id||row.import_record_id)throw new ApiError(409,"candidate_already_imported");const allowed=new Set(["merchant_name","amount","occurred_at","payment_method","external_transaction_id","status"]);if(!input||typeof input!=="object"||Array.isArray(input)||Object.keys(input).some(k=>!allowed.has(k)))throw new ApiError(400,"invalid_json_body");
  const next={...row,...input};if(input.status&&!new Set(["needs_review","ready","ignored"]).has(input.status))throw new ApiError(400,"invalid_field",{field:"status"});if(next.amount!==null&&(!Number.isSafeInteger(next.amount)))throw new ApiError(400,"invalid_field",{field:"amount"});
  await db.prepare(`UPDATE gmail_import_candidates SET merchant_name=?,amount=?,occurred_at=?,payment_method=?,external_transaction_id=?,status=?,updated_at=? WHERE id=? AND user_id=?`).bind(next.merchant_name,next.amount,next.occurred_at,next.payment_method,next.external_transaction_id,next.status,new Date().toISOString(),id,user.id).run();return{candidate:await ownedCandidate(db,user,id)};}
export async function importCandidate(db,user,id,input){const candidate=await ownedCandidate(db,user,id);const projectId=bounded(input?.project_id,"project_id",128);if(candidate.status==="imported"||candidate.imported_project_id||candidate.import_record_id)return importedCandidateResult(db,candidate,projectId);if(candidate.status==="ignored")throw new ApiError(409,"candidate_not_importable");
  await requirePersonalHousehold(db,user.id,projectId,"gmail_import_target_forbidden");
  if(!candidate.merchant_name||candidate.amount===null||!candidate.occurred_at)throw new ApiError(409,"candidate_incomplete");
  const message=await db.prepare("SELECT gmail_message_id FROM gmail_messages WHERE id=?").bind(candidate.gmail_message_row_id).first();
  if(!message)throw new ApiError(409,"candidate_incomplete");
  const sourceRecordId=`gmail:${candidate.connection_id}:${message.gmail_message_id}`;
  const existingImport=await db.prepare("SELECT * FROM import_records WHERE project_id=? AND source_type='gmail_notification' AND source_record_id=?").bind(projectId,sourceRecordId).first();
  const importId=existingImport?.id||crypto.randomUUID();
  const transactionId=existingImport?.transaction_id||`gmail-import:${importId}`;
  const timestamp=new Date().toISOString();
  const occurredAt=normalizeDate(candidate.occurred_at);
  if(!occurredAt)throw new ApiError(409,"candidate_incomplete");
  const normalizedMerchant=normalizeMerchantName(candidate.merchant_name);
  const paymentMethod=schemaPaymentMethod(candidate.payment_method);
  const status=candidate.amount<0?"refunded":"provisional";
  const entryType=candidate.amount<0?"refund":"purchase";
  const members=(await db.prepare("SELECT id FROM project_members WHERE project_id=? AND is_active=1 ORDER BY created_at,id").bind(projectId).all()).results||[];
  const personalSql=personalHouseholdExistsSql();
  const personalBindings=personalHouseholdBindings(user.id,projectId,timestamp);
  const candidateGuard=`EXISTS(SELECT 1 FROM gmail_import_candidates c WHERE c.id=? AND c.user_id=? AND c.updated_at=? AND c.imported_project_id=? AND c.import_record_id=? AND c.status IN ('needs_review','ready','parse_error')) AND EXISTS(${personalSql})`;
  const guardBindings=[id,user.id,timestamp,projectId,importId,...personalBindings];
  const unimportedGuard=`EXISTS(SELECT 1 FROM gmail_import_candidates c WHERE c.id=? AND c.user_id=? AND c.updated_at=? AND c.imported_project_id IS NULL AND c.import_record_id IS NULL AND c.status IN ('needs_review','ready','parse_error')) AND EXISTS(${personalSql})`;
  const unimportedBindings=[id,user.id,candidate.updated_at,...personalBindings];
  const statements=[];
  if(!existingImport){statements.push(db.prepare(`INSERT INTO import_records (id,project_id,transaction_id,source_type,source_record_id,source_status,merchant_raw,merchant_normalized,gross_amount_raw,paid_amount_raw,occurred_at_raw,settled_at_raw,payment_method_raw,external_transaction_id,image_url,raw_text,raw_payload,parse_confidence,parser_version,match_score,match_reason_json,created_at,updated_at)
    SELECT ?,?,NULL,'gmail_notification',?,'parsed',?,?,?,?,?,NULL,?,?,NULL,NULL,NULL,NULL,NULL,NULL,NULL,?,? WHERE ${unimportedGuard}`).bind(importId,projectId,sourceRecordId,candidate.merchant_name,normalizedMerchant,candidate.amount,candidate.amount,occurredAt,normalizePaymentMethod(candidate.payment_method),candidate.external_transaction_id,timestamp,timestamp,...unimportedBindings));}
  const claimResultIndex=statements.length;
  statements.push(db.prepare(`UPDATE gmail_import_candidates SET imported_project_id=?,import_record_id=?,updated_at=? WHERE id=? AND user_id=? AND updated_at=? AND imported_project_id IS NULL AND import_record_id IS NULL AND status IN ('needs_review','ready','parse_error') AND EXISTS(SELECT 1 FROM import_records WHERE id=? AND project_id=?) AND EXISTS(${personalSql})`).bind(projectId,importId,timestamp,id,user.id,candidate.updated_at,importId,projectId,...personalBindings));
  if(!existingImport?.transaction_id){
    statements.push(db.prepare(`INSERT INTO transactions (id,project_id,merchant_name,merchant_normalized,gross_amount,paid_amount,discount_amount,point_amount,category,status,occurred_at,settled_at,note,entry_type,origin_project_id,origin_transaction_id,origin_member_id,generated_automatically,created_at,updated_at)
      SELECT ?,?,?,?,?,?,0,0,NULL,?,?,NULL,NULL,?,NULL,NULL,NULL,1,?,? WHERE ${candidateGuard} AND EXISTS(SELECT 1 FROM import_records WHERE id=? AND transaction_id IS NULL)`).bind(transactionId,projectId,candidate.merchant_name,normalizedMerchant,candidate.amount,candidate.amount,status,occurredAt,entryType,timestamp,timestamp,...guardBindings,importId));
    const summaryId=`gmail-summary:${importId}`;
    statements.push(db.prepare(`INSERT INTO transaction_items (id,transaction_id,name,amount,quantity,item_type,category,sort_order,is_hidden,created_at,updated_at)
      SELECT ?,?,'Total',?,1,'summary',NULL,0,0,?,? WHERE ${candidateGuard} AND EXISTS(SELECT 1 FROM transactions WHERE id=?)`).bind(summaryId,transactionId,candidate.amount,timestamp,timestamp,...guardBindings,transactionId));
    for(const allocation of allocateAmount(candidate.amount,members)){statements.push(db.prepare(`INSERT INTO item_allocations (id,transaction_item_id,project_member_id,allocated_amount,created_at,updated_at)
      SELECT ?,?,?,?,?,? WHERE ${candidateGuard} AND EXISTS(SELECT 1 FROM transaction_items WHERE id=?)`).bind(`gmail-allocation:${importId}:${allocation.member.id}`,summaryId,allocation.member.id,allocation.amount,timestamp,timestamp,...guardBindings,summaryId));}
    if(candidate.payment_method||candidate.external_transaction_id||candidate.provider){statements.push(db.prepare(`INSERT INTO transaction_payments (id,transaction_id,payer_member_id,amount,payment_method,provider,account_label,external_payment_id,payment_status,occurred_at,created_at,updated_at)
      SELECT ?,?,NULL,?,?,?,NULL,?,?,?,?,? WHERE ${candidateGuard} AND EXISTS(SELECT 1 FROM transactions WHERE id=?)`).bind(`gmail-payment:${importId}`,transactionId,candidate.amount,paymentMethod,candidate.provider,candidate.external_transaction_id,status,occurredAt,timestamp,timestamp,...guardBindings,transactionId));}
    statements.push(db.prepare(`UPDATE import_records SET transaction_id=?,source_status='linked',updated_at=? WHERE id=? AND transaction_id IS NULL AND ${candidateGuard}`).bind(transactionId,timestamp,importId,...guardBindings));
  }
  statements.push(db.prepare(`UPDATE gmail_import_candidates SET status='imported',imported_project_id=?,import_record_id=?,updated_at=? WHERE id=? AND user_id=? AND updated_at=? AND ${candidateGuard} AND EXISTS(SELECT 1 FROM import_records WHERE id=? AND transaction_id=?)`).bind(projectId,importId,timestamp,id,user.id,timestamp,...guardBindings,importId,transactionId));
  const results=await db.batch(statements);
  if(!changedRows(results[claimResultIndex])||!changedRows(results.at(-1))){const current=await ownedCandidate(db,user,id);if(current.status==="imported"||current.imported_project_id||current.import_record_id)return importedCandidateResult(db,current,projectId);throw new ApiError(403,"gmail_import_target_forbidden");}
  return{candidate:await ownedCandidate(db,user,id),import:await db.prepare("SELECT * FROM import_records WHERE id=?").bind(importId).first(),transaction:await db.prepare("SELECT * FROM transactions WHERE id=?").bind(transactionId).first()};}

export async function encryptRefreshToken(env,connectionId,userId,token){const generation=keyGeneration(env);const key=await tokenKey(env,generation);const iv=crypto.getRandomValues(new Uint8Array(12));const aad=encoder.encode(`gmail-token:v1:${connectionId}:${userId}:${generation}`);const encrypted=await crypto.subtle.encrypt({name:"AES-GCM",iv,additionalData:aad},key,encoder.encode(token));return{ciphertext:base64(new Uint8Array(encrypted)),iv:base64(iv),key_generation:generation,aad_version:1};}
export async function decryptRefreshToken(env,connection){if(connection.aad_version!==1)throw new ApiError(500,"unsupported_gmail_token_aad");const key=await tokenKey(env,connection.key_generation);try{const decrypted=await crypto.subtle.decrypt({name:"AES-GCM",iv:fromBase64(connection.refresh_token_iv),additionalData:encoder.encode(`gmail-token:v1:${connection.id}:${connection.user_id}:${connection.key_generation}`)},key,fromBase64(connection.refresh_token_ciphertext));return new TextDecoder().decode(decrypted);}catch{throw new ApiError(500,"gmail_token_decryption_failed");}}
async function ownedConnection(db,user,id){const row=await db.prepare("SELECT * FROM gmail_connections WHERE id=? AND user_id=? AND status!='disconnected'").bind(id,user.id).first();if(!row)throw new ApiError(404,"not_found");return row;}
async function ownedCandidate(db,user,id){const row=await db.prepare("SELECT * FROM gmail_import_candidates WHERE id=? AND user_id=?").bind(id,user.id).first();if(!row)throw new ApiError(404,"not_found");return row;}
async function importedCandidateResult(db,candidate,projectId){if(candidate.imported_project_id!==projectId)throw new ApiError(409,"candidate_already_imported");const imported=await db.prepare("SELECT * FROM import_records WHERE id=? AND project_id=?").bind(candidate.import_record_id,projectId).first();if(!imported)throw new ApiError(409,"candidate_import_incomplete");const transaction=imported.transaction_id?await db.prepare("SELECT * FROM transactions WHERE id=? AND project_id=?").bind(imported.transaction_id,projectId).first():null;return{candidate,import:imported,transaction};}
async function requirePersonalHousehold(db,userId,projectId,errorCode="gmail_personal_household_required"){projectId=bounded(projectId,"project_id",128);const timestamp=new Date().toISOString();const row=await db.prepare(`SELECT p.id FROM projects p JOIN project_user_roles owner ON owner.project_id=p.id AND owner.user_id=? AND owner.role='owner' AND owner.revoked_at IS NULL WHERE ${personalHouseholdPredicate()}`).bind(...personalHouseholdBindings(userId,projectId,timestamp)).first();if(!row)throw new ApiError(403,errorCode);return row;}
async function requireAnyPersonalHousehold(db,userId){const timestamp=new Date().toISOString();const row=await db.prepare(`SELECT p.id FROM projects p JOIN project_user_roles owner ON owner.project_id=p.id AND owner.user_id=? AND owner.role='owner' AND owner.revoked_at IS NULL WHERE ${personalHouseholdPredicate(false)} ORDER BY p.created_at,p.id LIMIT 1`).bind(...personalHouseholdBindings(userId,null,timestamp)).first();if(!row)throw new ApiError(403,"gmail_personal_household_required");return row;}
function personalHouseholdPredicate(withProjectId=true){return `${withProjectId?"p.id=? AND ":""}p.project_type='household' AND NOT EXISTS(SELECT 1 FROM project_user_roles other WHERE other.project_id=p.id AND other.user_id<>? AND other.revoked_at IS NULL) AND NOT EXISTS(SELECT 1 FROM project_shares s WHERE s.project_id=p.id AND s.revoked_at IS NULL AND (s.expires_at IS NULL OR s.expires_at>?)) AND (p.share_token IS NULL OR (p.share_expires_at IS NOT NULL AND p.share_expires_at<=?))`;}
function personalHouseholdExistsSql(){return `SELECT 1 FROM projects p JOIN project_user_roles owner ON owner.project_id=p.id AND owner.user_id=? AND owner.role='owner' AND owner.revoked_at IS NULL WHERE ${personalHouseholdPredicate()}`;}
function personalHouseholdBindings(userId,projectId,timestamp){return projectId===null?[userId,userId,timestamp,timestamp]:[userId,projectId,userId,timestamp,timestamp];}
function changedRows(result){return Number(result?.meta?.changes??result?.changes??result?.meta?.rows_written??0);}
function normalizeGmailEmail(value){if(typeof value!=="string")throw new ApiError(502,"gmail_profile_invalid");const normalized=value.trim().toLowerCase();if(!normalized||normalized.length>320)throw new ApiError(502,"gmail_profile_invalid");return normalized;}
function allocateAmount(amount,members){if(!members.length)return[];const base=Math.trunc(amount/members.length);const remainder=amount-base*members.length;return members.map((member,index)=>({member,amount:base+(index<Math.abs(remainder)?Math.sign(remainder):0)}));}
function schemaPaymentMethod(value){const raw=String(value||"").normalize("NFKC").toLowerCase();if(raw.includes("suica"))return"suica";if(raw.includes("pasmo"))return"pasmo";const normalized=normalizePaymentMethod(value);if(["cash","credit_card","paypay","suica","pasmo","bank","point","other"].includes(normalized))return normalized;if(["bank_transfer","direct_debit"].includes(normalized))return"bank";if(normalized==="points")return"point";return"other";}
async function duplicateWarning(db,userId,amount,occurredAt){const start=new Date(Date.parse(occurredAt)-7*86400000).toISOString(),end=new Date(Date.parse(occurredAt)+7*86400000).toISOString();const row=await db.prepare(`SELECT 1 FROM gmail_import_candidates WHERE user_id=? AND amount=? AND occurred_at BETWEEN ? AND ? LIMIT 1`).bind(userId,amount,start,end).first();return row?1:0;}
function keyGeneration(env){const value=Number(env.GMAIL_TOKEN_KEY_CURRENT_GENERATION);if(!Number.isInteger(value)||value<1)throw new ApiError(500,"invalid_gmail_token_key_generation");return value;}
async function tokenKey(env,generation){const raw=env[`GMAIL_TOKEN_KEY_V${generation}`];if(!raw)throw new ApiError(500,"missing_gmail_token_key");const bytes=fromBase64(raw);if(bytes.length!==32)throw new ApiError(500,"invalid_gmail_token_key");return crypto.subtle.importKey("raw",bytes,"AES-GCM",false,["encrypt","decrypt"]);}
async function googleForm(env,url,body){const response=await fetcher(env)(url,{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams(body)});if(!response.ok){let payload={};try{payload=await response.json();}catch{}throw apiFailure(response.status,payload?.error);}return response.json();}
async function googleJson(env,url,accessToken){const response=await fetcher(env)(url,{headers:{authorization:`Bearer ${accessToken}`}});if(!response.ok)throw apiFailure(response.status);return response.json();}
async function revokeGoogleToken(env,token){const response=await fetcher(env)("https://oauth2.googleapis.com/revoke",{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({token})});if(response.ok)return;let payload={};try{payload=await response.json();}catch{}if(response.status===400&&["invalid_token","invalid_grant"].includes(payload?.error))return;throw new ApiError(502,"gmail_revocation_failed");}
function apiFailure(status,providerCode){const reauth=status===401||status===403||providerCode==="invalid_grant";const error=new ApiError(reauth?401:status===429?429:502,reauth?"gmail_reauthorization_required":status===429?"gmail_rate_limited":"gmail_api_error");error.status=reauth?401:status;return error;}
function fetcher(env){return env.GMAIL_FETCH||fetch;}
function requireConfig(env){if(!env.GMAIL_CLIENT_ID||!env.GMAIL_CLIENT_SECRET)throw new ApiError(500,"missing_gmail_oauth_config");}
function gmailRedirectUri(env,request){return env.GMAIL_REDIRECT_URI||new URL("/api/gmail/oauth/callback",request.url).toString();}
function bounded(value,field,max){if(typeof value!=="string"||!value.trim()||value.length>max)throw new ApiError(400,"invalid_field",{field});return value.trim();}
function safeErrorCode(error){return String(error?.code||"gmail_sync_error").slice(0,80);}
function base64(bytes){let value="";for(const byte of bytes)value+=String.fromCharCode(byte);return btoa(value);}
function fromBase64(value){return Uint8Array.from(atob(value),c=>c.charCodeAt(0));}
async function base64Url(bytes){return base64(bytes).replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_");}
