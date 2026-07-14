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

export async function startGmailOAuth(db, env, request, user) {
  requireConfig(env);
  const household = await requireAnyPersonalHousehold(db, user.id);
  const state = randomToken(32);
  const verifier = randomToken(48);
  const challenge = await base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(verifier))));
  const now = new Date();
  const redirectUri = gmailRedirectUri(env, request);
  await db.prepare(`INSERT INTO gmail_oauth_states (state_hash, user_id, project_id, created_at, expires_at, used_at) VALUES (?, ?, ?, ?, ?, NULL)`)
    .bind(await sha256Hex(state), user.id, household.id, now.toISOString(), new Date(now.getTime() + STATE_TTL_MS).toISOString()).run();
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
  try {
    const profile = await googleJson(env, "https://gmail.googleapis.com/gmail/v1/users/me/profile", token.access_token);
    const gmailEmail = normalizeGmailEmail(profile.emailAddress);
    const existing = await db.prepare("SELECT id FROM gmail_connections WHERE user_id = ? AND lower(trim(gmail_email)) = ? ORDER BY created_at, id LIMIT 1").bind(user.id, gmailEmail).first();
    const connectionId = existing?.id || `gmail_${(await sha256Hex(`gmail-connection:v1:${user.id}:${gmailEmail}`)).slice(0,48)}`;
    const encrypted = await encryptRefreshToken(env, connectionId, user.id, token.refresh_token);
    const personalSql = personalHouseholdExistsSql();
    const personalBindings = personalHouseholdBindings(user.id, state.project_id, usedAt);
    const activeUserSql = activeUserExistsSql();
    const connectionWrite = existing
      ? db.prepare(`UPDATE gmail_connections SET household_project_id=?,gmail_email=?,refresh_token_ciphertext=?,refresh_token_iv=?,key_generation=?,aad_version=1,status='active',updated_at=? WHERE id=? AND user_id=? AND EXISTS(${personalSql}) AND EXISTS(${activeUserSql})`)
        .bind(state.project_id,gmailEmail,encrypted.ciphertext,encrypted.iv,encrypted.key_generation,usedAt,connectionId,user.id,...personalBindings,user.id)
      : db.prepare(`INSERT INTO gmail_connections (id,user_id,household_project_id,gmail_email,refresh_token_ciphertext,refresh_token_iv,key_generation,aad_version,status,created_at,updated_at)
        SELECT ?,?,?,?, ?,?,?,1,'active',?,? WHERE EXISTS(${personalSql}) AND EXISTS(${activeUserSql})
        ON CONFLICT(user_id,gmail_email) DO UPDATE SET refresh_token_ciphertext=excluded.refresh_token_ciphertext,
        household_project_id=excluded.household_project_id,refresh_token_iv=excluded.refresh_token_iv,key_generation=excluded.key_generation,aad_version=1,status='active',updated_at=excluded.updated_at`)
        .bind(connectionId,user.id,state.project_id,gmailEmail,encrypted.ciphertext,encrypted.iv,encrypted.key_generation,usedAt,usedAt,...personalBindings,user.id);
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
  } catch (error) {
    await revokeOrQueueOAuthToken(db, env, user.id, token.refresh_token);
    throw error;
  }
}

export async function listConnections(db, user) {
  const result = await db.prepare(`SELECT c.id,c.household_project_id,c.gmail_email,c.status,c.created_at,c.updated_at,c.last_synced_at
    FROM gmail_connections c
    JOIN projects p ON p.id=c.household_project_id AND p.project_type='household' AND p.owner_user_id=c.user_id
    JOIN users u ON u.id=c.user_id AND u.deleted_at IS NULL AND u.deletion_started_at IS NULL
    WHERE c.user_id=? AND c.status!='disconnected' ORDER BY c.created_at`).bind(user.id).all();
  return { connections: result.results || [] };
}

export async function disconnectGmail(db, env, user, connectionId) {
  const connection = await ownedConnection(db, user, connectionId);
  const timestamp = new Date().toISOString();
  if (connection.status !== "disconnecting") {
    const marked = await db.prepare(`UPDATE gmail_connections SET status='disconnecting',updated_at=? WHERE id=? AND user_id=? AND status IN ('active','reauthorization_required')`)
      .bind(timestamp, connectionId, user.id).run();
    if (!changedRows(marked)) throw new ApiError(409, "gmail_connection_unavailable");
    connection.status = "disconnecting";
  }
  const token = await decryptRefreshToken(env, connection);
  await revokeGoogleToken(env, token);
  await db.prepare(`UPDATE gmail_connections SET refresh_token_ciphertext='',refresh_token_iv='',status='disconnected',updated_at=? WHERE id=? AND user_id=?`)
    .bind(new Date().toISOString(), connectionId, user.id).run();
  return { ok: true };
}

export async function disconnectAllGmail(db, env, user) {
  const rows = await db.prepare(`SELECT c.* FROM gmail_connections c
    JOIN projects p ON p.id=c.household_project_id AND p.project_type='household' AND p.owner_user_id=c.user_id
    WHERE c.user_id=? AND c.refresh_token_ciphertext!=''`).bind(user.id).all();
  let failed = 0;
  for (const connection of rows.results || []) {
    try {
      await disconnectGmail(db, env, user, connection.id);
    } catch {
      failed += 1;
    }
  }
  if (failed) throw new ApiError(502,"gmail_revocation_failed");
  return { failed };
}

export async function retryGmailRevocations(db, env, input = {}) {
  const limit = Number.isInteger(input.limit) && input.limit > 0 ? Math.min(input.limit, 100) : 25;
  let completed = 0;
  let failed = 0;
  const retries = await db.prepare("SELECT * FROM gmail_revocation_retries WHERE status='pending' ORDER BY created_at,id LIMIT ?").bind(limit).all();
  for (const record of retries.results || []) {
    const attemptedAt = new Date().toISOString();
    try {
      const token = await decryptRevocationToken(env, record);
      await revokeGoogleToken(env, token);
      await db.prepare(`UPDATE gmail_revocation_retries SET token_ciphertext='',token_iv='',status='completed',attempt_count=attempt_count+1,last_error_code=NULL,updated_at=?,last_attempted_at=?,completed_at=? WHERE id=? AND status='pending'`)
        .bind(attemptedAt,attemptedAt,attemptedAt,record.id).run();
      completed += 1;
    } catch {
      await db.prepare(`UPDATE gmail_revocation_retries SET attempt_count=attempt_count+1,last_error_code='gmail_revocation_failed',updated_at=?,last_attempted_at=? WHERE id=? AND status='pending'`)
        .bind(attemptedAt,attemptedAt,record.id).run();
      failed += 1;
    }
  }
  const available = Math.max(0, limit - (retries.results || []).length);
  if (available > 0) {
    const connections = await db.prepare("SELECT * FROM gmail_connections WHERE status='disconnecting' AND refresh_token_ciphertext!='' ORDER BY updated_at,id LIMIT ?").bind(available).all();
    for (const connection of connections.results || []) {
      const attemptedAt = new Date().toISOString();
      try {
        const token = await decryptRefreshToken(env, connection);
        await revokeGoogleToken(env, token);
        await db.prepare("UPDATE gmail_connections SET refresh_token_ciphertext='',refresh_token_iv='',status='disconnected',updated_at=? WHERE id=? AND status='disconnecting'").bind(attemptedAt,connection.id).run();
        completed += 1;
      } catch {
        await db.prepare("UPDATE gmail_connections SET updated_at=? WHERE id=? AND status='disconnecting'").bind(attemptedAt,connection.id).run();
        failed += 1;
      }
    }
  }
  const pendingRetries = await db.prepare("SELECT COUNT(*) AS count FROM gmail_revocation_retries WHERE status='pending'").first();
  const pendingConnections = await db.prepare("SELECT COUNT(*) AS count FROM gmail_connections WHERE status='disconnecting' AND refresh_token_ciphertext!=''").first();
  return { completed, failed, remaining: Number(pendingRetries?.count || 0) + Number(pendingConnections?.count || 0) };
}

export async function syncGmail(db, env, user, connectionId, input = {}) {
  const days = Number(input.days ?? 30); const limit = Number(input.limit ?? 100);
  if (!DAYS.has(days)) throw new ApiError(400, "invalid_field", { field: "days" });
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new ApiError(400, "invalid_field", { field: "limit" });
  const syncProject = await requireAnyPersonalHousehold(db,user.id);
  const connection = await ownedActiveConnection(db, user, connectionId); const started = new Date().toISOString(); const runId = crypto.randomUUID();
  const runStarted = await db.prepare(`INSERT INTO gmail_sync_runs (id,connection_id,user_id,days,message_limit,status,started_at)
    SELECT ?,?,?,?,?, 'running',? WHERE EXISTS(SELECT 1 FROM gmail_connections c JOIN users u ON u.id=c.user_id WHERE c.id=? AND c.user_id=? AND c.status='active' AND u.deleted_at IS NULL AND u.deletion_started_at IS NULL)`)
    .bind(runId,connectionId,user.id,days,limit,started,connectionId,user.id).run();
  if (!changedRows(runStarted)) throw new ApiError(409,"gmail_connection_unavailable");
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
      if(exists){duplicates++;continue;}
      try {
        const message=await googleJson(env,`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(item.id)}?format=full`,token.access_token);
        const headers=Object.fromEntries((message.payload?.headers||[]).map(h=>[String(h.name).toLowerCase(),h.value]));
        const parsed=parsePaymentNotification(extractGmailText(message.payload),headers); const messageRowId=exists?.id||crypto.randomUUID(); const candidateId=parsed.parse_status === "parse_error" ? null : crypto.randomUUID();
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
      const syncWriteSql="SELECT 1 FROM gmail_connections c JOIN users u ON u.id=c.user_id WHERE c.id=? AND c.user_id=? AND c.status='active' AND u.deleted_at IS NULL AND u.deletion_started_at IS NULL";
      const syncWriteBindings=[connectionId,user.id];
      const statements=[db.prepare(`UPDATE gmail_sync_runs SET status=status WHERE id=? AND user_id=? AND EXISTS(${personalSql}) AND EXISTS(${syncWriteSql})`).bind(runId,user.id,...personalBindings,...syncWriteBindings)];
      for(const record of pending){
        if(!record.exists){statements.push(db.prepare(`INSERT INTO gmail_messages (id,connection_id,gmail_message_id,sync_run_id,parse_status,provider,received_at,created_at)
          SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(${personalSql}) AND EXISTS(${syncWriteSql})`).bind(record.messageRowId,connectionId,record.gmailMessageId,runId,record.parsed.parse_status,record.parsed.provider,record.receivedAt,record.now,...personalBindings,...syncWriteBindings));}
        if(record.candidateId){
          statements.push(db.prepare(`INSERT INTO gmail_import_candidates (id,connection_id,gmail_message_row_id,user_id,status,provider,merchant_name,amount,occurred_at,payment_method,external_transaction_id,duplicate_warning,created_at,updated_at)
            SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(${personalSql}) AND EXISTS(${syncWriteSql})`).bind(record.candidateId,connectionId,record.messageRowId,user.id,record.parsed.parse_status === "parsed" ? "ready" : record.parsed.parse_status,record.parsed.provider,record.parsed.merchant_name,record.parsed.amount,record.parsed.occurred_at,record.parsed.payment_method,record.parsed.external_transaction_id,record.warning,record.now,record.now,...personalBindings,...syncWriteBindings));
        }
      }
      const results=await db.batch(statements);
      if(!changedRows(results[0]))throw new ApiError(403,"gmail_personal_household_lost");
      processed+=pending.length;candidates+=pending.filter((record)=>record.candidateId).length;
    }
  } catch(error) {
    errors++; errorCode=safeErrorCode(error); status=error?.status===401?"reauthorization_required":error?.status===429?"rate_limited":"failed";
    if(status==="reauthorization_required") await db.prepare("UPDATE gmail_connections SET status='reauthorization_required',updated_at=? WHERE id=? AND status='active'").bind(new Date().toISOString(),connectionId).run();
  }
  if(status==="reauthorization_required") await db.prepare("UPDATE gmail_connections SET status='reauthorization_required',updated_at=? WHERE id=? AND status='active'").bind(new Date().toISOString(),connectionId).run();
  const finished=new Date().toISOString();
  await db.prepare(`UPDATE gmail_sync_runs SET status=?,listed_count=?,processed_count=?,candidate_count=?,duplicate_count=?,error_count=?,error_code=?,finished_at=? WHERE id=?`)
    .bind(status,listed,processed,candidates,duplicates,errors,errorCode,finished,runId).run();
  await db.prepare("UPDATE gmail_connections SET last_synced_at=?,updated_at=? WHERE id=? AND status IN ('active','reauthorization_required')").bind(finished,finished,connectionId).run();
  return { run: await db.prepare("SELECT * FROM gmail_sync_runs WHERE id=?").bind(runId).first() };
}

export async function listSyncRuns(db,user,connectionId){await ownedConnection(db,user,connectionId);const rows=await db.prepare("SELECT * FROM gmail_sync_runs WHERE connection_id=? AND user_id=? ORDER BY started_at DESC LIMIT 50").bind(connectionId,user.id).all();return{sync_runs:rows.results||[]};}
export async function listCandidates(db,user,status){const values=[user.id];let condition="c.user_id=?";if(status){condition+=" AND c.status=?";values.push(status);}const rows=await db.prepare(`SELECT c.* FROM gmail_import_candidates c JOIN gmail_connections gc ON gc.id=c.connection_id AND gc.user_id=c.user_id JOIN projects p ON p.id=gc.household_project_id AND p.project_type='household' AND p.owner_user_id=c.user_id JOIN users u ON u.id=c.user_id AND u.deleted_at IS NULL AND u.deletion_started_at IS NULL WHERE ${condition} ORDER BY c.created_at DESC LIMIT 200`).bind(...values).all();return{candidates:rows.results||[]};}
export async function updateCandidate(db,user,id,input){const row=await ownedCandidate(db,user,id);await requirePersonalHousehold(db,user.id,row.household_project_id);if(row.status==="imported"||row.imported_project_id||row.import_record_id)throw new ApiError(409,"candidate_already_imported");const allowed=new Set(["merchant_name","amount","occurred_at","payment_method","external_transaction_id","status"]);if(!input||typeof input!=="object"||Array.isArray(input)||Object.keys(input).some(k=>!allowed.has(k)))throw new ApiError(400,"invalid_json_body");
  const next={...row,...input};if(input.status&&!new Set(["needs_review","ready","ignored"]).has(input.status))throw new ApiError(400,"invalid_field",{field:"status"});if(next.amount!==null&&(!Number.isSafeInteger(next.amount)))throw new ApiError(400,"invalid_field",{field:"amount"});
  const updated=await db.prepare(`UPDATE gmail_import_candidates SET merchant_name=?,amount=?,occurred_at=?,payment_method=?,external_transaction_id=?,status=?,updated_at=? WHERE id=? AND user_id=? AND updated_at=? AND imported_project_id IS NULL AND import_record_id IS NULL AND status IN ('needs_review','ready','ignored','parse_error') AND EXISTS(${activeUserExistsSql()})`).bind(next.merchant_name,next.amount,next.occurred_at,next.payment_method,next.external_transaction_id,next.status,new Date().toISOString(),id,user.id,row.updated_at,user.id).run();if(!changedRows(updated)){const current=await ownedCandidate(db,user,id);if(current.status==="imported"||current.imported_project_id||current.import_record_id)throw new ApiError(409,"candidate_already_imported");throw new ApiError(409,"candidate_update_conflict");}return{candidate:await ownedCandidate(db,user,id)};}
export async function importCandidate(db,user,id){const candidate=await ownedCandidate(db,user,id);const projectId=bounded(candidate.household_project_id,"household_project_id",128);if(candidate.status==="imported"||candidate.imported_project_id||candidate.import_record_id)return importedCandidateResult(db,candidate,projectId);if(candidate.status==="ignored")throw new ApiError(409,"candidate_not_importable");
  await requirePersonalHousehold(db,user.id,projectId,"gmail_import_target_forbidden");
  const merchantName=String(candidate.merchant_name||"").trim();
  if(!merchantName||!Number.isSafeInteger(candidate.amount)||candidate.amount===0||!candidate.occurred_at)throw new ApiError(409,"candidate_incomplete");
  const message=await db.prepare("SELECT gmail_message_id FROM gmail_messages WHERE id=?").bind(candidate.gmail_message_row_id).first();
  if(!message)throw new ApiError(409,"candidate_incomplete");
  const sourceRecordId=`gmail:${candidate.connection_id}:${message.gmail_message_id}`;
  const existingImport=await db.prepare("SELECT * FROM import_records WHERE project_id=? AND source_type='gmail_notification' AND source_record_id=?").bind(projectId,sourceRecordId).first();
  const importId=existingImport?.id||crypto.randomUUID();
  const transactionId=existingImport?.transaction_id||`gmail-import:${importId}`;
  const timestamp=new Date().toISOString();
  const occurredAt=normalizeDate(candidate.occurred_at);
  if(!occurredAt)throw new ApiError(409,"candidate_incomplete");
  const normalizedMerchant=normalizeMerchantName(merchantName);
  const paymentMethod=schemaPaymentMethod(candidate.payment_method);
  const status=candidate.amount<0?"refunded":"provisional";
  const entryType=candidate.amount<0?"refund":"purchase";
  const members=(await db.prepare("SELECT id FROM project_members WHERE project_id=? AND is_active=1 ORDER BY created_at,id").bind(projectId).all()).results||[];
  const personalSql=personalHouseholdExistsSql();
  const personalBindings=personalHouseholdBindings(user.id,projectId,timestamp);
  const candidateGuard=`EXISTS(SELECT 1 FROM gmail_import_candidates c WHERE c.id=? AND c.user_id=? AND c.updated_at=? AND c.imported_project_id=? AND c.import_record_id=? AND c.status IN ('needs_review','ready','parse_error')) AND EXISTS(${personalSql}) AND EXISTS(${activeUserExistsSql()})`;
  const guardBindings=[id,user.id,timestamp,projectId,importId,...personalBindings,user.id];
  const unimportedGuard=`EXISTS(SELECT 1 FROM gmail_import_candidates c WHERE c.id=? AND c.user_id=? AND c.updated_at=? AND c.imported_project_id IS NULL AND c.import_record_id IS NULL AND c.status IN ('needs_review','ready','parse_error')) AND EXISTS(${personalSql}) AND EXISTS(${activeUserExistsSql()})`;
  const unimportedBindings=[id,user.id,candidate.updated_at,...personalBindings,user.id];
  const statements=[];
  if(!existingImport){statements.push(db.prepare(`INSERT INTO import_records (id,project_id,transaction_id,source_type,source_record_id,source_status,merchant_raw,merchant_normalized,gross_amount_raw,paid_amount_raw,occurred_at_raw,settled_at_raw,payment_method_raw,external_transaction_id,image_url,raw_text,raw_payload,parse_confidence,parser_version,match_score,match_reason_json,created_at,updated_at)
    SELECT ?,?,NULL,'gmail_notification',?,'parsed',?,?,?,?,?,NULL,?,?,NULL,NULL,NULL,NULL,NULL,NULL,NULL,?,? WHERE ${unimportedGuard}`).bind(importId,projectId,sourceRecordId,merchantName,normalizedMerchant,candidate.amount,candidate.amount,occurredAt,normalizePaymentMethod(candidate.payment_method),candidate.external_transaction_id,timestamp,timestamp,...unimportedBindings));}
  const claimResultIndex=statements.length;
  statements.push(db.prepare(`UPDATE gmail_import_candidates SET imported_project_id=?,import_record_id=?,updated_at=? WHERE id=? AND user_id=? AND updated_at=? AND imported_project_id IS NULL AND import_record_id IS NULL AND status IN ('needs_review','ready','parse_error') AND EXISTS(SELECT 1 FROM import_records WHERE id=? AND project_id=?) AND EXISTS(${personalSql}) AND EXISTS(${activeUserExistsSql()})`).bind(projectId,importId,timestamp,id,user.id,candidate.updated_at,importId,projectId,...personalBindings,user.id));
  if(!existingImport?.transaction_id){
    statements.push(db.prepare(`INSERT INTO transactions (id,project_id,merchant_name,merchant_normalized,gross_amount,paid_amount,discount_amount,point_amount,category,status,occurred_at,settled_at,note,entry_type,origin_project_id,origin_transaction_id,origin_member_id,generated_automatically,created_at,updated_at)
      SELECT ?,?,?,?,?,?,0,0,NULL,?,?,NULL,NULL,?,NULL,NULL,NULL,1,?,? WHERE ${candidateGuard} AND EXISTS(SELECT 1 FROM import_records WHERE id=? AND transaction_id IS NULL)`).bind(transactionId,projectId,merchantName,normalizedMerchant,candidate.amount,candidate.amount,status,occurredAt,entryType,timestamp,timestamp,...guardBindings,importId));
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
async function ownedConnection(db,user,id){const row=await db.prepare(`SELECT c.* FROM gmail_connections c JOIN projects p ON p.id=c.household_project_id AND p.project_type='household' AND p.owner_user_id=c.user_id WHERE c.id=? AND c.user_id=? AND c.status!='disconnected'`).bind(id,user.id).first();if(!row)throw new ApiError(404,"not_found");return row;}
async function ownedActiveConnection(db,user,id){const row=await db.prepare(`SELECT c.* FROM gmail_connections c JOIN projects p ON p.id=c.household_project_id AND p.project_type='household' AND p.owner_user_id=c.user_id JOIN users u ON u.id=c.user_id AND u.deleted_at IS NULL AND u.deletion_started_at IS NULL WHERE c.id=? AND c.user_id=? AND c.status='active'`).bind(id,user.id).first();if(!row)throw new ApiError(409,"gmail_connection_unavailable");return row;}
async function ownedCandidate(db,user,id){const row=await db.prepare(`SELECT c.*,gc.household_project_id FROM gmail_import_candidates c JOIN gmail_connections gc ON gc.id=c.connection_id AND gc.user_id=c.user_id JOIN projects p ON p.id=gc.household_project_id AND p.project_type='household' WHERE c.id=? AND c.user_id=?`).bind(id,user.id).first();if(!row)throw new ApiError(404,"not_found");return row;}
async function importedCandidateResult(db,candidate,projectId){if(candidate.imported_project_id!==projectId)throw new ApiError(409,"candidate_already_imported");const imported=await db.prepare("SELECT * FROM import_records WHERE id=? AND project_id=?").bind(candidate.import_record_id,projectId).first();if(!imported)throw new ApiError(409,"candidate_import_incomplete");const transaction=imported.transaction_id?await db.prepare("SELECT * FROM transactions WHERE id=? AND project_id=?").bind(imported.transaction_id,projectId).first():null;return{candidate,import:imported,transaction};}
async function requirePersonalHousehold(db,userId,projectId,errorCode="gmail_personal_household_required"){projectId=bounded(projectId,"project_id",128);const row=await db.prepare(`SELECT p.id FROM projects p JOIN users u ON u.id=p.owner_user_id WHERE p.id=? AND p.project_type='household' AND p.owner_user_id=? AND u.deleted_at IS NULL AND u.deletion_started_at IS NULL`).bind(projectId,userId).first();if(!row)throw new ApiError(403,errorCode);return row;}
async function requireAnyPersonalHousehold(db,userId){const row=await db.prepare(`SELECT p.id FROM projects p JOIN users u ON u.id=p.owner_user_id WHERE p.project_type='household' AND p.owner_user_id=? AND u.deleted_at IS NULL AND u.deletion_started_at IS NULL ORDER BY p.created_at,p.id LIMIT 1`).bind(userId).first();if(!row)throw new ApiError(403,"gmail_personal_household_required");return row;}
function personalHouseholdPredicate(withProjectId=true){return `${withProjectId?"p.id=? AND ":""}p.project_type='household' AND p.owner_user_id=? AND EXISTS(SELECT 1 FROM users u WHERE u.id=p.owner_user_id AND u.deleted_at IS NULL AND u.deletion_started_at IS NULL)`;}
function personalHouseholdExistsSql(){return `SELECT 1 FROM projects p WHERE ${personalHouseholdPredicate()}`;}
function personalHouseholdBindings(userId,projectId){return projectId===null?[userId]:[projectId,userId];}
function activeUserExistsSql(){return "SELECT 1 FROM users WHERE id=? AND deleted_at IS NULL AND deletion_started_at IS NULL";}
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
async function revokeOrQueueOAuthToken(db,env,userId,token){try{await revokeGoogleToken(env,token);return;}catch{}const id=crypto.randomUUID();const timestamp=new Date().toISOString();const encrypted=await encryptRevocationToken(env,id,userId,token);await db.prepare(`INSERT INTO gmail_revocation_retries (id,owner_user_id,source,token_ciphertext,token_iv,key_generation,aad_version,status,attempt_count,last_error_code,created_at,updated_at,last_attempted_at,completed_at) VALUES (?,?,'oauth_storage_rejected',?,?,?,1,'pending',1,'gmail_revocation_failed',?,?,?,NULL)`).bind(id,userId,encrypted.ciphertext,encrypted.iv,encrypted.key_generation,timestamp,timestamp,timestamp).run();}
async function encryptRevocationToken(env,id,userId,token){const generation=keyGeneration(env);const key=await tokenKey(env,generation);const iv=crypto.getRandomValues(new Uint8Array(12));const aad=encoder.encode(`gmail-revocation:v1:${id}:${userId}:${generation}`);const encrypted=await crypto.subtle.encrypt({name:"AES-GCM",iv,additionalData:aad},key,encoder.encode(token));return{ciphertext:base64(new Uint8Array(encrypted)),iv:base64(iv),key_generation:generation};}
async function decryptRevocationToken(env,record){if(record.aad_version!==1)throw new ApiError(500,"unsupported_gmail_token_aad");const key=await tokenKey(env,record.key_generation);try{const decrypted=await crypto.subtle.decrypt({name:"AES-GCM",iv:fromBase64(record.token_iv),additionalData:encoder.encode(`gmail-revocation:v1:${record.id}:${record.owner_user_id}:${record.key_generation}`)},key,fromBase64(record.token_ciphertext));return new TextDecoder().decode(decrypted);}catch{throw new ApiError(500,"gmail_token_decryption_failed");}}
function apiFailure(status,providerCode){const reauth=status===401||status===403||providerCode==="invalid_grant";const error=new ApiError(reauth?401:status===429?429:502,reauth?"gmail_reauthorization_required":status===429?"gmail_rate_limited":"gmail_api_error");error.status=reauth?401:status;return error;}
function fetcher(env){return env.GMAIL_FETCH||fetch;}
function requireConfig(env){if(!env.GMAIL_CLIENT_ID||!env.GMAIL_CLIENT_SECRET)throw new ApiError(500,"missing_gmail_oauth_config");}
function gmailRedirectUri(env,request){return env.GMAIL_REDIRECT_URI||new URL("/api/gmail/oauth/callback",request.url).toString();}
function bounded(value,field,max){if(typeof value!=="string"||!value.trim()||value.length>max)throw new ApiError(400,"invalid_field",{field});return value.trim();}
function safeErrorCode(error){return String(error?.code||"gmail_sync_error").slice(0,80);}
function base64(bytes){let value="";for(const byte of bytes)value+=String.fromCharCode(byte);return btoa(value);}
function fromBase64(value){return Uint8Array.from(atob(value),c=>c.charCodeAt(0));}
async function base64Url(bytes){return base64(bytes).replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_");}
