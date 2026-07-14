import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { decryptRefreshToken, disconnectGmail, encryptRefreshToken, finishGmailOAuth, importCandidate, retryGmailRevocations, startGmailOAuth, syncGmail, updateCandidate } from "../functions/lib/gmail.js";
import { extractGmailText } from "../functions/lib/gmail-mime.js";
import { parsePaymentNotification } from "../functions/lib/gmail-parsers.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const schema = readFileSync(`${root}/db/schema.sql`, "utf8");

class Statement {
  constructor(database, sql, bindings = []) { this.database = database; this.sql = sql; this.bindings = bindings; }
  bind(...bindings) { return new Statement(this.database, this.sql, bindings); }
  async first() { return this.database.prepare(this.sql).get(...this.bindings) ?? null; }
  async all() { return { results: this.database.prepare(this.sql).all(...this.bindings) }; }
  async run() { if(this.database.owner?.beforeRunSql&&this.sql.includes(this.database.owner.beforeRunSql)){const beforeRun=this.database.owner.beforeRun;this.database.owner.beforeRunSql=null;this.database.owner.beforeRun=null;await beforeRun();}if(this.database.owner?.failSqlOnce&&this.sql.includes(this.database.owner.failSqlOnce)){this.database.owner.failSqlOnce=null;throw new Error("injected_statement_failure");}const value = this.database.prepare(this.sql).run(...this.bindings); return { meta: { changes: Number(value.changes) } }; }
}
class Database {
  constructor() { this.raw = new DatabaseSync(":memory:"); this.raw.exec(schema); }
  prepare(sql) { const statement=new Statement(this.raw, sql);statement.database.owner=this;return statement; }
  async batch(statements) {
    if(this.beforeBatch){const beforeBatch=this.beforeBatch;this.beforeBatch=null;await beforeBatch();}
    this.raw.exec("BEGIN");
    try {
      const results=[];
      for (let index=0;index<statements.length;index++) {
        if (this.failBatchAt===index) throw new Error("injected_batch_failure");
        results.push(await statements[index].run());
      }
      this.raw.exec("COMMIT");
      return results;
    } catch (error) {
      this.raw.exec("ROLLBACK");
      throw error;
    } finally { this.failBatchAt=undefined; }
  }
  close() { this.raw.close(); }
}

class SerializedDatabase extends Database {
  constructor() { super(); this.batchQueue=Promise.resolve(); }
  batch(statements) { const run=()=>super.batch(statements);const result=this.batchQueue.then(run,run);this.batchQueue=result.catch(()=>{});return result; }
}

function base64Url(value) { return Buffer.from(value).toString("base64url"); }
function environment(fetch) { return { GMAIL_CLIENT_ID: "client", GMAIL_CLIENT_SECRET: "secret", GMAIL_TOKEN_KEY_CURRENT_GENERATION: "1", GMAIL_TOKEN_KEY_V1: Buffer.alloc(32, 7).toString("base64"), GMAIL_FETCH: fetch }; }
function seed(db) {
  const now = "2026-07-12T00:00:00.000Z";
  db.raw.prepare("INSERT INTO users (id,google_sub,email,created_at,updated_at) VALUES (?,?,?,?,?)").run("user-1","sub-1","user@example.test",now,now);
  db.raw.prepare("INSERT INTO projects (id,name,project_type,owner_user_id,created_at,updated_at) VALUES (?,?,?,?,?,?)").run("personal-home","Personal","household","user-1",now,now);
}

async function syncFixture(messageBodies, existing = []) {
  const db = new Database();
  seed(db);
  const now = "2026-07-12T00:00:00.000Z";
  let detailCalls = 0;
  const env = environment(async (url) => {
    if (String(url).includes("oauth2.googleapis.com/token")) return Response.json({ access_token: "access-secret" });
    if (String(url).includes("/messages?")) return Response.json({ messages: Object.keys(messageBodies).map((id) => ({ id })) });
    const id = decodeURIComponent(String(url).split("/messages/")[1].split("?")[0]);
    detailCalls += 1;
    return Response.json({ payload: { mimeType: "text/plain", headers: [{ name: "From", value: "notice@example.test" }, { name: "Date", value: "Fri, 10 Jul 2026 12:30:00 +0900" }], body: { data: base64Url(messageBodies[id]) } } });
  });
  const encrypted = await encryptRefreshToken(env, "sync-fixture-connection", "user-1", "refresh-secret");
  db.raw.prepare("INSERT INTO gmail_connections (id,user_id,household_project_id,gmail_email,refresh_token_ciphertext,refresh_token_iv,key_generation,aad_version,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,1,'active',?,?)").run("sync-fixture-connection", "user-1", "personal-home", "mail@example.test", encrypted.ciphertext, encrypted.iv, 1, now, now);
  for (const [messageId, candidate] of existing) {
    const runId = `existing-run-${messageId}`;
    const messageRowId = `existing-row-${messageId}`;
    db.raw.prepare("INSERT INTO gmail_sync_runs (id,connection_id,user_id,days,message_limit,status,started_at) VALUES (?,?,?,?,?,'completed',?)").run(runId, "sync-fixture-connection", "user-1", 7, 10, now);
    db.raw.prepare("INSERT INTO gmail_messages (id,connection_id,gmail_message_id,sync_run_id,parse_status,created_at) VALUES (?,?,?,?,?,?)").run(messageRowId, "sync-fixture-connection", messageId, runId, "parsed", now);
    if (candidate) db.raw.prepare("INSERT INTO gmail_import_candidates (id,connection_id,gmail_message_row_id,user_id,status,merchant_name,amount,occurred_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run(`existing-candidate-${messageId}`, "sync-fixture-connection", messageRowId, "user-1", "ready", "Shop", 1200, now, now, now);
  }
  return { db, env, detailCalls: () => detailCalls };
}

test("Gmail sync passes a stable query and page token across pages", async (t) => {
  const db = new Database();
  t.after(() => db.close());
  seed(db);
  const now = "2026-07-12T00:00:00.000Z";
  const requests = [];
  const env = environment(async (url) => {
    const value = String(url);
    if (value.includes("oauth2.googleapis.com/token")) return Response.json({ access_token: "access-secret" });
    const parsedUrl = new URL(value);
    if (parsedUrl.pathname.endsWith("/messages")) {
      requests.push(parsedUrl);
      const pageToken = parsedUrl.searchParams.get("pageToken");
      return Response.json(pageToken ? { messages: [{ id: "page-2" }] } : { messages: [{ id: "page-1" }], nextPageToken: "next-page" });
    }
    const id = decodeURIComponent(parsedUrl.pathname.split("/messages/")[1]);
    return Response.json({ id, payload: { mimeType: "text/plain", headers: [{ name: "Date", value: "Fri, 10 Jul 2026 12:30:00 +0900" }], body: { data: base64Url("amount: 1200\ndate: 2026/07/10\nmerchant: Shop") } } });
  });
  const encrypted = await encryptRefreshToken(env, "page-connection", "user-1", "refresh-secret");
  db.raw.prepare("INSERT INTO gmail_connections (id,user_id,household_project_id,gmail_email,refresh_token_ciphertext,refresh_token_iv,key_generation,aad_version,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,1,'active',?,?)").run("page-connection", "user-1", "personal-home", "mail@example.test", encrypted.ciphertext, encrypted.iv, 1, now, now);
  const first = await syncGmail(db, env, { id: "user-1" }, "page-connection", { days: 7, batch_size: 40 });
  const second = await syncGmail(db, env, { id: "user-1" }, "page-connection", { days: 7, batch_size: 40, page_token: first.next_page_token, query_after: first.query_after });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].searchParams.get("maxResults"), "40");
  assert.equal(requests[1].searchParams.get("maxResults"), "40");
  assert.equal(requests[0].searchParams.get("q"), requests[1].searchParams.get("q"));
  assert.equal(requests[1].searchParams.get("pageToken"), "next-page");
  assert.equal(first.has_more, true);
  assert.equal(second.has_more, false);
  assert.equal(second.query_after, first.query_after);
  assert.equal(second.candidate_count, 1);
});

test("Gmail sync rejects a batch size above the external request budget", async (t) => {
  const fixture = await syncFixture({});
  t.after(() => fixture.db.close());
  await assert.rejects(() => syncGmail(fixture.db, fixture.env, { id: "user-1" }, "sync-fixture-connection", { days: 7, batch_size: 41 }), (error) => error.status === 400 && error.message === "invalid_field");
});

test("AES-GCM token storage uses a 12-byte IV and binds connection, user, and generation through AAD", async () => {
  const env = environment(() => {});
  const encrypted = await encryptRefreshToken(env, "connection-1", "user-1", "refresh-secret");
  assert.equal(Buffer.from(encrypted.iv, "base64").length, 12);
  assert.notEqual(encrypted.ciphertext, "refresh-secret");
  assert.equal(await decryptRefreshToken(env, { id:"connection-1",user_id:"user-1",key_generation:1,aad_version:1,refresh_token_iv:encrypted.iv,refresh_token_ciphertext:encrypted.ciphertext }), "refresh-secret");
  await assert.rejects(() => decryptRefreshToken(env, { id:"connection-2",user_id:"user-1",key_generation:1,aad_version:1,refresh_token_iv:encrypted.iv,refresh_token_ciphertext:encrypted.ciphertext }), /gmail_token_decryption_failed/);
  await assert.rejects(() => decryptRefreshToken({ ...env, GMAIL_TOKEN_KEY_V1: undefined }, { id:"connection-1",user_id:"user-1",key_generation:1,aad_version:1,refresh_token_iv:encrypted.iv,refresh_token_ciphertext:encrypted.ciphertext }), /missing_gmail_token_key/);
});

test("OAuth callback revalidates the household selected at start", async (t) => {
  const db=new Database();t.after(()=>db.close());seed(db);let fetchCalls=0;const env=environment(async()=>{fetchCalls+=1;return Response.json({});});
  const started=await startGmailOAuth(db,env,new Request("https://example.test/api/gmail/oauth/start"),{id:"user-1"},"personal-home");
  const state=new URL(started.url).searchParams.get("state");
  const cookie=started.cookie.split(";",1)[0];
  db.raw.prepare("INSERT INTO users (id,google_sub,email,created_at,updated_at) VALUES (?,?,?,?,?)").run("user-2","sub-2","user2@example.test","2026-07-12T00:00:00.000Z","2026-07-12T00:00:00.000Z");
  db.raw.prepare("UPDATE projects SET owner_user_id='user-2' WHERE id='personal-home'").run();
  await assert.rejects(()=>finishGmailOAuth(db,env,new Request(`https://example.test/api/gmail/oauth/callback?state=${encodeURIComponent(state)}&code=code`,{headers:{cookie}}),{id:"user-1"}),/gmail_personal_household_required/);
  assert.equal(fetchCalls,0);
  assert.equal(db.raw.prepare("SELECT project_id FROM gmail_oauth_states").get().project_id,"personal-home");
  assert.notEqual(db.raw.prepare("SELECT used_at FROM gmail_oauth_states").get().used_at,null);
});

test("personal household ownership is required for Gmail OAuth", async (t) => {
  const db=new Database();t.after(()=>db.close());seed(db);const env=environment(async()=>Response.json({}));const request=new Request("https://example.test/api/gmail/oauth/start");
  db.raw.prepare("INSERT INTO users (id,google_sub,email,created_at,updated_at) VALUES (?,?,?,?,?)").run("user-2","sub-2","user2@example.test","2026-07-12T00:00:00.000Z","2026-07-12T00:00:00.000Z");
  db.raw.prepare("UPDATE projects SET owner_user_id='user-2' WHERE id=?").run("personal-home");
  await assert.rejects(()=>startGmailOAuth(db,env,request,{id:"user-1"},"personal-home"),/gmail_personal_household_required/);
  assert.equal(db.raw.prepare("SELECT count(*) AS n FROM gmail_oauth_states").get().n,0);
});

test("OAuth callback rejects sharing added after its final read and before connection storage", async (t) => {
  const db=new Database();t.after(()=>db.close());seed(db);let profileRequested=false;const env=environment(async(url)=>{
    if(String(url).includes("/token"))return Response.json({access_token:"access-secret",refresh_token:"refresh-secret"});
    profileRequested=true;
    db.raw.prepare("INSERT INTO users (id,google_sub,email,created_at,updated_at) VALUES (?,?,?,?,?)").run("user-2","sub-2","user2@example.test","2026-07-12T00:00:00.000Z","2026-07-12T00:00:00.000Z");
    db.raw.prepare("UPDATE projects SET owner_user_id='user-2' WHERE id='personal-home'").run();
    return Response.json({emailAddress:"mail@example.test"});
  });
  const started=await startGmailOAuth(db,env,new Request("https://example.test/api/gmail/oauth/start"),{id:"user-1"},"personal-home");
  const state=new URL(started.url).searchParams.get("state");const cookie=started.cookie.split(";",1)[0];
  await assert.rejects(()=>finishGmailOAuth(db,env,new Request(`https://example.test/api/gmail/oauth/callback?state=${encodeURIComponent(state)}&code=code`,{headers:{cookie}}),{id:"user-1"}),/gmail_personal_household_required/);
  assert.equal(profileRequested,true);
  assert.equal(db.raw.prepare("SELECT count(*) AS n FROM gmail_connections").get().n,0);
});

test("OAuth callback rejects connection storage when account deletion starts during provider reads", async (t) => {
  const db=new Database();t.after(()=>db.close());seed(db);const env=environment(async(url)=>{
    if(String(url).includes("/token"))return Response.json({access_token:"access-secret",refresh_token:"refresh-secret"});
    db.raw.prepare("UPDATE users SET deletion_started_at=? WHERE id=?").run("2026-07-12T00:00:00.000Z","user-1");
    return Response.json({emailAddress:"mail@example.test"});
  });
  const started=await startGmailOAuth(db,env,new Request("https://example.test/api/gmail/oauth/start"),{id:"user-1"},"personal-home");
  const state=new URL(started.url).searchParams.get("state");const cookie=started.cookie.split(";",1)[0];
  await assert.rejects(()=>finishGmailOAuth(db,env,new Request(`https://example.test/api/gmail/oauth/callback?state=${encodeURIComponent(state)}&code=code`,{headers:{cookie}}),{id:"user-1"}),/account_unavailable/);
  assert.equal(db.raw.prepare("SELECT count(*) AS n FROM gmail_connections").get().n,0);
});

test("parallel OAuth callbacks use the stored connection identifier for token AAD", async (t) => {
  const db=new SerializedDatabase();t.after(()=>db.close());seed(db);let profileCalls=0;let releaseProfiles;const profilesReady=new Promise((resolve)=>{releaseProfiles=resolve;});let tokenCalls=0;
  const env=environment(async(url)=>{
    if(String(url).includes("/token")){tokenCalls+=1;return Response.json({access_token:`access-${tokenCalls}`,refresh_token:`refresh-${tokenCalls}`});}
    profileCalls+=1;const currentProfile=profileCalls;if(profileCalls===2)releaseProfiles();await profilesReady;return Response.json({emailAddress:currentProfile===1?" Mail@Example.Test ":"mail@example.test"});
  });
  const first=await startGmailOAuth(db,env,new Request("https://example.test/api/gmail/oauth/start"),{id:"user-1"},"personal-home");
  const second=await startGmailOAuth(db,env,new Request("https://example.test/api/gmail/oauth/start"),{id:"user-1"},"personal-home");
  const callback=(started,code)=>finishGmailOAuth(db,env,new Request(`https://example.test/api/gmail/oauth/callback?state=${encodeURIComponent(new URL(started.url).searchParams.get("state"))}&code=${code}`,{headers:{cookie:started.cookie.split(";",1)[0]}}),{id:"user-1"});
  const results=await Promise.all([callback(first,"first"),callback(second,"second")]);
  assert.equal(results[0].connection_id,results[1].connection_id);
  assert.equal(db.raw.prepare("SELECT count(*) AS n FROM gmail_connections").get().n,1);
  const stored=db.raw.prepare("SELECT * FROM gmail_connections").get();
  assert.equal(stored.gmail_email,"mail@example.test");
  assert.match(await decryptRefreshToken(env,stored),/^refresh-[12]$/);
});

test("OAuth callback reuses a legacy mixed-case Gmail connection identifier", async (t) => {
  const db=new Database();t.after(()=>db.close());seed(db);const env=environment(async(url)=>String(url).includes("/token")?Response.json({access_token:"access",refresh_token:"replacement"}):Response.json({emailAddress:"legacy@example.test"}));const now="2026-07-12T00:00:00.000Z";
  const encrypted=await encryptRefreshToken(env,"legacy-id","user-1","old-refresh");
  db.raw.prepare("INSERT INTO gmail_connections (id,user_id,household_project_id,gmail_email,refresh_token_ciphertext,refresh_token_iv,key_generation,aad_version,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,1,'active',?,?)").run("legacy-id","user-1","personal-home"," Legacy@Example.Test ",encrypted.ciphertext,encrypted.iv,1,now,now);
  const started=await startGmailOAuth(db,env,new Request("https://example.test/api/gmail/oauth/start"),{id:"user-1"},"personal-home");
  const result=await finishGmailOAuth(db,env,new Request(`https://example.test/api/gmail/oauth/callback?state=${encodeURIComponent(new URL(started.url).searchParams.get("state"))}&code=code`,{headers:{cookie:started.cookie.split(";",1)[0]}}),{id:"user-1"});
  assert.equal(result.connection_id,"legacy-id");
  assert.equal(db.raw.prepare("SELECT count(*) AS n FROM gmail_connections").get().n,1);
  assert.equal(await decryptRefreshToken(env,db.raw.prepare("SELECT * FROM gmail_connections WHERE id='legacy-id'").get()),"replacement");
});

test("multiple message and candidate writes roll back together and permit a later sync retry", async (t) => {
  const db=new Database();t.after(()=>db.close());seed(db);const env=environment(async(url)=>{
    if(String(url).includes("oauth2.googleapis.com/token"))return Response.json({access_token:"access-secret"});
    if(String(url).includes("/messages?"))return Response.json({messages:[{id:"retry-message-1"},{id:"retry-message-2"}]});
    return Response.json({payload:{mimeType:"text/plain",headers:[{name:"From",value:"notice@jcb.co.jp"}],body:{data:base64Url("amount 1200 2026/07/10 shop")}}});
  });
  const encrypted=await encryptRefreshToken(env,"retry-connection","user-1","refresh-secret");
  db.raw.prepare(`INSERT INTO gmail_connections (id,user_id,household_project_id,gmail_email,refresh_token_ciphertext,refresh_token_iv,key_generation,aad_version,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,1,'active',?,?)`).run("retry-connection","user-1","personal-home","retry@example.test",encrypted.ciphertext,encrypted.iv,1,"2026-07-12T00:00:00.000Z","2026-07-12T00:00:00.000Z");
  db.failBatchAt=4;const failed=await syncGmail(db,env,{id:"user-1"},"retry-connection",{days:7,limit:2});
  assert.equal(failed.run.error_count,1);assert.equal(db.raw.prepare("SELECT count(*) AS n FROM gmail_messages").get().n,0);assert.equal(db.raw.prepare("SELECT count(*) AS n FROM gmail_import_candidates").get().n,0);
  const retried=await syncGmail(db,env,{id:"user-1"},"retry-connection",{days:7,limit:2});
  assert.equal(retried.run.candidate_count,2);assert.equal(db.raw.prepare("SELECT count(*) AS n FROM gmail_import_candidates").get().n,2);
});

test("sync revalidates its selected personal household against each sharing mechanism", async (t) => {
  const cases=[
    ["ownership changed",(db,now)=>{db.raw.prepare("INSERT INTO users (id,google_sub,email,created_at,updated_at) VALUES (?,?,?,?,?)").run("user-2","sub-2","user2@example.test",now,now);db.raw.prepare("UPDATE projects SET owner_user_id='user-2' WHERE id='personal-home'").run();}],
    ["legacy share field",(db,now)=>{db.raw.prepare("INSERT INTO users (id,google_sub,email,created_at,updated_at) VALUES (?,?,?,?,?)").run("user-2","sub-2","user2@example.test",now,now);db.raw.prepare("UPDATE projects SET owner_user_id='user-2' WHERE id='personal-home'").run();}],
    ["other user role",(db,now)=>{db.raw.prepare("INSERT INTO users (id,google_sub,email,created_at,updated_at) VALUES (?,?,?,?,?)").run("user-2","sub-2","user2@example.test",now,now);db.raw.prepare("UPDATE projects SET owner_user_id='user-2' WHERE id='personal-home'").run();}],
  ];
  for(const [name,share] of cases){await t.test(name,async()=>{
    const db=new Database();seed(db);const now="2026-07-12T00:00:00.000Z";
    const env=environment(async(url)=>{
      if(String(url).includes("oauth2.googleapis.com/token"))return Response.json({access_token:"access-secret"});
      if(String(url).includes("/messages?"))return Response.json({messages:[{id:"race-message-1"},{id:"race-message-2"}]});
      return Response.json({payload:{mimeType:"text/plain",headers:[{name:"From",value:"notice@jcb.co.jp"}],body:{data:base64Url("amount 1200 2026/07/10 shop")}}});
    });
    const encrypted=await encryptRefreshToken(env,"sync-race-connection","user-1","refresh-secret");
    db.raw.prepare("INSERT INTO gmail_connections (id,user_id,household_project_id,gmail_email,refresh_token_ciphertext,refresh_token_iv,key_generation,aad_version,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,1,'active',?,?)").run("sync-race-connection","user-1","personal-home","race@example.test",encrypted.ciphertext,encrypted.iv,1,now,now);
    db.beforeBatch=async()=>share(db,now);
    const result=await syncGmail(db,env,{id:"user-1"},"sync-race-connection",{days:7,limit:2});
    assert.equal(result.run.status,"failed");
    assert.equal(result.run.error_code,"gmail_personal_household_lost");
    assert.equal(result.run.processed_count,0);
    assert.equal(result.run.candidate_count,0);
    assert.equal(db.raw.prepare("SELECT count(*) AS n FROM gmail_messages").get().n,0);
    assert.equal(db.raw.prepare("SELECT count(*) AS n FROM gmail_import_candidates").get().n,0);
    db.close();
  });}
});

test("sync batch leaves no message or candidate after account deletion starts", async (t) => {
  const db=new Database();t.after(()=>db.close());seed(db);const now="2026-07-12T00:00:00.000Z";const env=environment(async(url)=>{if(String(url).includes("oauth2.googleapis.com/token"))return Response.json({access_token:"access-secret"});if(String(url).includes("/messages?"))return Response.json({messages:[{id:"deletion-message"}]});return Response.json({payload:{mimeType:"text/plain",headers:[{name:"From",value:"notice@jcb.co.jp"}],body:{data:base64Url("amount 1200 2026/07/10 shop")}}});});
  const encrypted=await encryptRefreshToken(env,"deletion-sync","user-1","refresh-secret");db.raw.prepare("INSERT INTO gmail_connections (id,user_id,household_project_id,gmail_email,refresh_token_ciphertext,refresh_token_iv,key_generation,aad_version,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,1,'active',?,?)").run("deletion-sync","user-1","personal-home","deletion@example.test",encrypted.ciphertext,encrypted.iv,1,now,now);
  db.beforeBatch=async()=>db.raw.prepare("UPDATE users SET deletion_started_at=? WHERE id=?").run(now,"user-1");
  const result=await syncGmail(db,env,{id:"user-1"},"deletion-sync",{days:7,limit:1});assert.equal(result.run.status,"failed");assert.equal(result.run.candidate_count,0);assert.equal(db.raw.prepare("SELECT count(*) AS n FROM gmail_messages").get().n,0);assert.equal(db.raw.prepare("SELECT count(*) AS n FROM gmail_import_candidates").get().n,0);
});

test("failed revocation leaves the connection disconnecting with its encrypted token", async (t) => {
  const db=new Database();t.after(()=>db.close());seed(db);const env=environment(async()=>new Response("unavailable",{status:503}));
  const encrypted=await encryptRefreshToken(env,"revoke-connection","user-1","refresh-secret");
  db.raw.prepare(`INSERT INTO gmail_connections (id,user_id,household_project_id,gmail_email,refresh_token_ciphertext,refresh_token_iv,key_generation,aad_version,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,1,'active',?,?)`).run("revoke-connection","user-1","personal-home","revoke@example.test",encrypted.ciphertext,encrypted.iv,1,"2026-07-12T00:00:00.000Z","2026-07-12T00:00:00.000Z");
  await assert.rejects(()=>disconnectGmail(db,env,{id:"user-1"},"revoke-connection"),/gmail_revocation_failed/);
  const row=db.raw.prepare("SELECT status,refresh_token_ciphertext FROM gmail_connections WHERE id=?").get("revoke-connection");assert.equal(row.status,"disconnecting");assert.equal(row.refresh_token_ciphertext,encrypted.ciphertext);
});

test("OAuth storage rejection revokes the acquired token without creating a connection or retry row", async (t) => {
  const db=new Database();t.after(()=>db.close());seed(db);const calls=[];const env=environment(async(url)=>{calls.push(String(url));if(String(url).includes("/token"))return Response.json({access_token:"access-secret",refresh_token:"refresh-secret"});if(String(url).includes("/profile")){db.raw.prepare("UPDATE users SET deletion_started_at=? WHERE id=?").run("2026-07-12T00:00:00.000Z","user-1");return Response.json({emailAddress:"mail@example.test"});}return new Response(null,{status:200});});
  const started=await startGmailOAuth(db,env,new Request("https://example.test/api/gmail/oauth/start"),{id:"user-1"},"personal-home");
  await assert.rejects(()=>finishGmailOAuth(db,env,new Request(`https://example.test/api/gmail/oauth/callback?state=${encodeURIComponent(new URL(started.url).searchParams.get("state"))}&code=code`,{headers:{cookie:started.cookie.split(";",1)[0]}}),{id:"user-1"}),/account_unavailable/);
  assert.equal(calls.filter(url=>url.includes("/revoke")).length,1);
  assert.equal(db.raw.prepare("SELECT count(*) AS n FROM gmail_connections").get().n,0);
  assert.equal(db.raw.prepare("SELECT count(*) AS n FROM gmail_revocation_retries").get().n,0);
});

test("OAuth revocation failure stores an encrypted retry and retry completion erases its ciphertext", async (t) => {
  const db=new Database();t.after(()=>db.close());seed(db);let allowRevocation=false;const env=environment(async(url)=>{if(String(url).includes("/token"))return Response.json({access_token:"access-secret",refresh_token:"refresh-secret"});if(String(url).includes("/profile")){db.raw.prepare("UPDATE users SET deletion_started_at=? WHERE id=?").run("2026-07-12T00:00:00.000Z","user-1");return Response.json({emailAddress:"mail@example.test"});}return new Response(null,{status:allowRevocation?200:503});});
  const started=await startGmailOAuth(db,env,new Request("https://example.test/api/gmail/oauth/start"),{id:"user-1"},"personal-home");
  await assert.rejects(()=>finishGmailOAuth(db,env,new Request(`https://example.test/api/gmail/oauth/callback?state=${encodeURIComponent(new URL(started.url).searchParams.get("state"))}&code=code`,{headers:{cookie:started.cookie.split(";",1)[0]}}),{id:"user-1"}),/account_unavailable/);
  const pending=db.raw.prepare("SELECT * FROM gmail_revocation_retries").get();
  assert.equal(pending.status,"pending");assert.equal(Buffer.from(pending.token_iv,"base64").length,12);assert.notEqual(pending.token_ciphertext,"refresh-secret");assert.equal(pending.owner_user_id,"user-1");
  assert.doesNotMatch(JSON.stringify(pending),/refresh-secret/);
  allowRevocation=true;const retried=await retryGmailRevocations(db,env,{limit:10});assert.deepEqual(retried,{completed:1,failed:0,remaining:0});
  const completed=db.raw.prepare("SELECT status,token_ciphertext,token_iv,completed_at FROM gmail_revocation_retries WHERE id=?").get(pending.id);assert.equal(completed.status,"completed");assert.equal(completed.token_ciphertext,"");assert.equal(completed.token_iv,"");assert.notEqual(completed.completed_at,null);
});

test("OAuth connection batch failure also queues a failed revocation", async (t) => {
  const db=new Database();t.after(()=>db.close());seed(db);const env=environment(async(url)=>{if(String(url).includes("/token"))return Response.json({access_token:"access-secret",refresh_token:"refresh-secret"});if(String(url).includes("/profile"))return Response.json({emailAddress:"mail@example.test"});return new Response(null,{status:503});});
  const started=await startGmailOAuth(db,env,new Request("https://example.test/api/gmail/oauth/start"),{id:"user-1"},"personal-home");db.failBatchAt=1;
  await assert.rejects(()=>finishGmailOAuth(db,env,new Request(`https://example.test/api/gmail/oauth/callback?state=${encodeURIComponent(new URL(started.url).searchParams.get("state"))}&code=code`,{headers:{cookie:started.cookie.split(";",1)[0]}}),{id:"user-1"}),/injected_batch_failure/);
  assert.equal(db.raw.prepare("SELECT count(*) AS n FROM gmail_connections").get().n,0);const retry=db.raw.prepare("SELECT status,token_ciphertext,token_iv FROM gmail_revocation_retries").get();assert.equal(retry.status,"pending");assert.notEqual(retry.token_ciphertext,"refresh-secret");assert.equal(Buffer.from(retry.token_iv,"base64").length,12);
});

test("disconnecting connections reject synchronization and successful retry erases the token", async (t) => {
  const db=new Database();t.after(()=>db.close());seed(db);let available=false;const env=environment(async()=>new Response(null,{status:available?200:503}));const encrypted=await encryptRefreshToken(env,"disconnect-retry","user-1","refresh-secret");const now="2026-07-12T00:00:00.000Z";
  db.raw.prepare("INSERT INTO gmail_connections (id,user_id,household_project_id,gmail_email,refresh_token_ciphertext,refresh_token_iv,key_generation,aad_version,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,1,'active',?,?)").run("disconnect-retry","user-1","personal-home","retry@example.test",encrypted.ciphertext,encrypted.iv,1,now,now);
  await assert.rejects(()=>disconnectGmail(db,env,{id:"user-1"},"disconnect-retry"),/gmail_revocation_failed/);
  await assert.rejects(()=>syncGmail(db,env,{id:"user-1"},"disconnect-retry",{days:7,limit:1}),(error)=>error.status===409&&error.message==="gmail_connection_unavailable");
  assert.equal(db.raw.prepare("SELECT count(*) AS n FROM gmail_sync_runs").get().n,0);
  available=true;const result=await retryGmailRevocations(db,env,{limit:10});assert.deepEqual(result,{completed:1,failed:0,remaining:0});
  const row=db.raw.prepare("SELECT status,refresh_token_ciphertext,refresh_token_iv FROM gmail_connections WHERE id=?").get("disconnect-retry");assert.deepEqual({...row},{status:"disconnected",refresh_token_ciphertext:"",refresh_token_iv:""});
});

test("Gmail candidate import uses the connection household", async (t) => {
  const db=new Database();t.after(()=>db.close());seed(db);const now="2026-07-12T00:00:00.000Z";
  db.raw.prepare("INSERT INTO gmail_connections (id,user_id,household_project_id,gmail_email,refresh_token_ciphertext,refresh_token_iv,key_generation,aad_version,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,1,'active',?,?)").run("c1","user-1","personal-home","mail@example.test","x","y",1,now,now);
  db.raw.prepare("INSERT INTO gmail_sync_runs (id,connection_id,user_id,days,message_limit,status,started_at) VALUES (?,?,?,?,?,'completed',?)").run("run-1","c1","user-1",7,1,now);
  db.raw.prepare("INSERT INTO gmail_messages (id,connection_id,gmail_message_id,sync_run_id,parse_status,created_at) VALUES (?,?,?,?,?,?)").run("m1","c1","gm1","run-1","parsed",now);
  db.raw.prepare("INSERT INTO gmail_import_candidates (id,connection_id,gmail_message_row_id,user_id,status,merchant_name,amount,occurred_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run("candidate-1","c1","m1","user-1","ready","Shop",1000,now,now,now);
  const result=await importCandidate(db,{id:"user-1"},"candidate-1",{project_id:"untrusted-project"});
  assert.equal(result.import.project_id,"personal-home");
});

test("candidate import rejects a role added between permission read and its write batch", async (t) => {
  const db=new Database();t.after(()=>db.close());seed(db);const now="2026-07-12T00:00:00.000Z";
  db.raw.prepare("INSERT INTO project_members (id,project_id,display_name,role,is_active,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run("personal-member","personal-home","Owner","owner",1,now,now);
  db.raw.prepare("INSERT INTO gmail_connections (id,user_id,household_project_id,gmail_email,refresh_token_ciphertext,refresh_token_iv,key_generation,aad_version,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,1,'active',?,?)").run("race-connection","user-1","personal-home","race@example.test","x","y",1,now,now);
  db.raw.prepare("INSERT INTO gmail_sync_runs (id,connection_id,user_id,days,message_limit,status,started_at) VALUES (?,?,?,?,?,'completed',?)").run("race-run","race-connection","user-1",7,1,now);
  db.raw.prepare("INSERT INTO gmail_messages (id,connection_id,gmail_message_id,sync_run_id,parse_status,created_at) VALUES (?,?,?,?,?,?)").run("race-message","race-connection","race-gmail-id","race-run","parsed",now);
  db.raw.prepare("INSERT INTO gmail_import_candidates (id,connection_id,gmail_message_row_id,user_id,status,merchant_name,amount,occurred_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run("race-candidate","race-connection","race-message","user-1","ready","Shop",1000,now,now,now);
  db.beforeBatch=async()=>{
    db.raw.prepare("INSERT INTO users (id,google_sub,email,created_at,updated_at) VALUES (?,?,?,?,?)").run("user-2","sub-2","user2@example.test",now,now);
    db.raw.prepare("UPDATE projects SET owner_user_id='user-2' WHERE id='personal-home'").run();
  };
  await assert.rejects(()=>importCandidate(db,{id:"user-1"},"race-candidate",{project_id:"personal-home"}),/gmail_import_target_forbidden/);
  assert.equal(db.raw.prepare("SELECT count(*) AS n FROM import_records WHERE project_id=?").get("personal-home").n,0);
  assert.equal(db.raw.prepare("SELECT count(*) AS n FROM transactions WHERE project_id=?").get("personal-home").n,0);
  assert.equal(db.raw.prepare("SELECT status FROM gmail_import_candidates WHERE id=?").get("race-candidate").status,"ready");
});

test("candidate import batch rejects account deletion started after its permission read", async (t) => {
  const db=new Database();t.after(()=>db.close());seed(db);const now="2026-07-12T00:00:00.000Z";
  db.raw.prepare("INSERT INTO project_members (id,project_id,display_name,role,is_active,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run("deletion-member","personal-home","Owner","owner",1,now,now);
  db.raw.prepare("INSERT INTO gmail_connections (id,user_id,household_project_id,gmail_email,refresh_token_ciphertext,refresh_token_iv,key_generation,aad_version,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,1,'active',?,?)").run("deletion-import-connection","user-1","personal-home","deletion-import@example.test","x","y",1,now,now);
  db.raw.prepare("INSERT INTO gmail_sync_runs (id,connection_id,user_id,days,message_limit,status,started_at) VALUES (?,?,?,?,?,'completed',?)").run("deletion-import-run","deletion-import-connection","user-1",7,1,now);
  db.raw.prepare("INSERT INTO gmail_messages (id,connection_id,gmail_message_id,sync_run_id,parse_status,created_at) VALUES (?,?,?,?,?,?)").run("deletion-import-message","deletion-import-connection","deletion-import-gmail","deletion-import-run","parsed",now);
  db.raw.prepare("INSERT INTO gmail_import_candidates (id,connection_id,gmail_message_row_id,user_id,status,merchant_name,amount,occurred_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run("deletion-import-candidate","deletion-import-connection","deletion-import-message","user-1","ready","Shop",1000,now,now,now);
  db.beforeBatch=async()=>db.raw.prepare("UPDATE users SET deletion_started_at=? WHERE id=?").run(now,"user-1");
  await assert.rejects(()=>importCandidate(db,{id:"user-1"},"deletion-import-candidate",{project_id:"personal-home"}),/gmail_import_target_forbidden/);
  assert.equal(db.raw.prepare("SELECT count(*) AS n FROM import_records").get().n,0);assert.equal(db.raw.prepare("SELECT count(*) AS n FROM transactions").get().n,0);assert.equal(db.raw.prepare("SELECT status FROM gmail_import_candidates WHERE id=?").get("deletion-import-candidate").status,"ready");
});

test("candidate edit detects a concurrent import and does not restore its prior status", async (t) => {
  const db=new Database();t.after(()=>db.close());seed(db);const now="2026-07-12T00:00:00.000Z";
  db.raw.prepare("INSERT INTO gmail_connections (id,user_id,household_project_id,gmail_email,refresh_token_ciphertext,refresh_token_iv,key_generation,aad_version,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,1,'active',?,?)").run("edit-race-connection","user-1","personal-home","edit@example.test","x","y",1,now,now);
  db.raw.prepare("INSERT INTO gmail_sync_runs (id,connection_id,user_id,days,message_limit,status,started_at) VALUES (?,?,?,?,?,'completed',?)").run("edit-race-run","edit-race-connection","user-1",7,1,now);
  db.raw.prepare("INSERT INTO gmail_messages (id,connection_id,gmail_message_id,sync_run_id,parse_status,created_at) VALUES (?,?,?,?,?,?)").run("edit-race-message","edit-race-connection","edit-race-gmail","edit-race-run","parsed",now);
  db.raw.prepare("INSERT INTO gmail_import_candidates (id,connection_id,gmail_message_row_id,user_id,status,merchant_name,amount,occurred_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run("edit-race-candidate","edit-race-connection","edit-race-message","user-1","ready","Before",1000,now,now,now);
  db.beforeRunSql="UPDATE gmail_import_candidates SET merchant_name";db.beforeRun=async()=>db.raw.prepare("UPDATE gmail_import_candidates SET status='imported',updated_at=? WHERE id=?").run("2026-07-12T00:00:01.000Z","edit-race-candidate");
  await assert.rejects(()=>updateCandidate(db,{id:"user-1"},"edit-race-candidate",{merchant_name:"After",status:"ready"}),(error)=>error.status===409&&error.message==="candidate_already_imported");
  const row=db.raw.prepare("SELECT status,merchant_name FROM gmail_import_candidates WHERE id=?").get("edit-race-candidate");assert.deepEqual({...row},{status:"imported",merchant_name:"Before"});
});

test("sync remains available when a shared household and a personal household coexist", async (t) => {
  const db=new Database();t.after(()=>db.close());seed(db);const now="2026-07-12T00:00:00.000Z";
  db.raw.prepare("INSERT INTO projects (id,name,project_type,created_at,updated_at) VALUES (?,?,?,?,?)").run("shared-a","Shared","split",now,now);
  const env=environment(async(url)=>String(url).includes("/token")?Response.json({access_token:"access-secret"}):Response.json({messages:[]}));
  const encrypted=await encryptRefreshToken(env,"mixed-connection","user-1","refresh-secret");
  db.raw.prepare("INSERT INTO gmail_connections (id,user_id,household_project_id,gmail_email,refresh_token_ciphertext,refresh_token_iv,key_generation,aad_version,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,1,'active',?,?)").run("mixed-connection","user-1","personal-home","mixed@example.test",encrypted.ciphertext,encrypted.iv,1,now,now);
  const result=await syncGmail(db,env,{id:"user-1"},"mixed-connection",{days:7,limit:1});
  assert.equal(result.run.status,"completed");
});

test("nested mixed and alternative MIME prefers plain text and decodes Base64URL", () => {
  const payload = { mimeType:"multipart/mixed", parts:[{ mimeType:"multipart/alternative", parts:[
    { mimeType:"text/html", body:{ data:base64Url("<p>HTML only</p>") } },
    { mimeType:"text/plain", body:{ data:base64Url("利用金額: 1,280円\n利用日時: 2026/07/10 12:30\n利用先: テスト商店") } },
  ]},{ mimeType:"application/pdf", filename:"receipt.pdf", body:{ attachmentId:"ignored" } }] };
  const text = extractGmailText(payload);
  assert.match(text, /1,280円/);
  assert.doesNotMatch(text, /HTML only/);
  const parsed = parsePaymentNotification(text, { from:"notice@paypay.ne.jp" });
  assert.equal(parsed.amount, 1280);
  assert.equal(parsed.merchant_name, "テスト商店");
  assert.equal(parsed.provider, "paypay");
  assert.equal(parsed.parse_status, "parsed");
});

test("sync stores structured candidates, deduplicates Gmail Message ID, and retains no body or access token", async (t) => {
  const db = new Database(); t.after(() => db.close()); seed(db);
  const calls = [];
  const fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes("oauth2.googleapis.com/token")) return Response.json({ access_token:"access-secret" });
    if (String(url).includes("/messages?")) return Response.json({ messages:[{ id:"message-1" }] });
    return Response.json({ id:"message-1", payload:{ mimeType:"text/plain", headers:[{name:"From",value:"notice@jcb.co.jp"},{name:"Date",value:"Fri, 10 Jul 2026 12:30:00 +0900"}], body:{data:base64Url("利用金額: 2,500円\n利用日時: 2026/07/10 12:30\n利用先: 安全商店")}} });
  };
  const env=environment(fetch); const encrypted=await encryptRefreshToken(env,"connection-1","user-1","refresh-secret");
  db.raw.prepare(`INSERT INTO gmail_connections (id,user_id,household_project_id,gmail_email,refresh_token_ciphertext,refresh_token_iv,key_generation,aad_version,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,1,'active',?,?)`).run("connection-1","user-1","personal-home","mail@example.test",encrypted.ciphertext,encrypted.iv,1,"2026-07-12T00:00:00.000Z","2026-07-12T00:00:00.000Z");
  const user={id:"user-1"}; const first=await syncGmail(db,env,user,"connection-1",{days:30,limit:20}); const second=await syncGmail(db,env,user,"connection-1",{days:30,limit:20});
  assert.equal(first.run.candidate_count,1); assert.equal(second.run.duplicate_count,1);
  const candidate=db.raw.prepare("SELECT merchant_name,amount,status FROM gmail_import_candidates").get();
  assert.deepEqual({...candidate},{merchant_name:"安全商店",amount:2500,status:"ready"});
  const dump=JSON.stringify(db.raw.prepare("SELECT * FROM gmail_import_candidates").all())+JSON.stringify(db.raw.prepare("SELECT * FROM gmail_messages").all());
  assert.doesNotMatch(dump,/利用金額|access-secret|refresh-secret/);
});

test("401 and 429 produce restrained run states", async (t) => {
  for (const [status, expected] of [[401,"reauthorization_required"],[403,"reauthorization_required"],[429,"rate_limited"]]) {
    const db=new Database(); seed(db); const env=environment(async()=>new Response("denied",{status}));
    const encrypted=await encryptRefreshToken(env,`connection-${status}`,"user-1","refresh-secret");
    db.raw.prepare(`INSERT INTO gmail_connections (id,user_id,household_project_id,gmail_email,refresh_token_ciphertext,refresh_token_iv,key_generation,aad_version,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,1,'active',?,?)`).run(`connection-${status}`,"user-1","personal-home",`${status}@example.test`,encrypted.ciphertext,encrypted.iv,1,"2026-07-12T00:00:00.000Z","2026-07-12T00:00:00.000Z");
    const result=await syncGmail(db,env,{id:"user-1"},`connection-${status}`,{days:7,limit:1}); assert.equal(result.run.status,expected); db.close();
  }
});

test("token invalid_grant requests reauthorization without Gmail API calls", async (t) => {
  const db=new Database();t.after(()=>db.close());seed(db);let calls=0;const env=environment(async()=>{calls++;return Response.json({error:"invalid_grant"},{status:400});});
  const encrypted=await encryptRefreshToken(env,"invalid-grant","user-1","refresh-secret");
  db.raw.prepare(`INSERT INTO gmail_connections (id,user_id,household_project_id,gmail_email,refresh_token_ciphertext,refresh_token_iv,key_generation,aad_version,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,1,'active',?,?)`).run("invalid-grant","user-1","personal-home","invalid@example.test",encrypted.ciphertext,encrypted.iv,1,"2026-07-12T00:00:00.000Z","2026-07-12T00:00:00.000Z");
  const result=await syncGmail(db,env,{id:"user-1"},"invalid-grant",{days:7,limit:1});assert.equal(result.run.status,"reauthorization_required");assert.equal(calls,1);
});

test("candidate import retry repairs its final status without a second transaction", async (t) => {
  const db=new Database();t.after(()=>db.close());seed(db);const now="2026-07-12T00:00:00.000Z";
  db.raw.prepare("INSERT INTO project_members (id,project_id,display_name,role,is_active,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run("member-1","personal-home","Owner","owner",1,now,now);
  db.raw.prepare("INSERT INTO gmail_connections (id,user_id,household_project_id,gmail_email,refresh_token_ciphertext,refresh_token_iv,key_generation,aad_version,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,1,'active',?,?)").run("c2","user-1","personal-home","mail2@example.test","x","y",1,now,now);
  db.raw.prepare("INSERT INTO gmail_sync_runs (id,connection_id,user_id,days,message_limit,status,started_at) VALUES (?,?,?,?,?,'completed',?)").run("run-2","c2","user-1",7,1,now);
  db.raw.prepare("INSERT INTO gmail_messages (id,connection_id,gmail_message_id,sync_run_id,parse_status,created_at) VALUES (?,?,?,?,?,?)").run("m2","c2","gm2","run-2","parsed",now);
  db.raw.prepare("INSERT INTO gmail_import_candidates (id,connection_id,gmail_message_row_id,user_id,status,merchant_name,amount,occurred_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run("candidate-2","c2","m2","user-1","ready","Shop",1000,now,now,now);
  db.failSqlOnce="UPDATE gmail_import_candidates SET status='imported'";
  await assert.rejects(()=>importCandidate(db,{id:"user-1"},"candidate-2",{project_id:"untrusted-project"}),/injected_statement_failure/);
  await importCandidate(db,{id:"user-1"},"candidate-2",{project_id:"untrusted-project"});
  assert.equal(db.raw.prepare("SELECT count(*) AS n FROM transactions WHERE project_id=?").get("personal-home").n,1);assert.equal(db.raw.prepare("SELECT status FROM gmail_import_candidates WHERE id=?").get("candidate-2").status,"imported");
});

test("candidate import is idempotent for one household and ignores another target", async (t) => {
  const db=new Database();t.after(()=>db.close());seed(db);const now="2026-07-12T00:00:00.000Z";
  db.raw.prepare("INSERT INTO project_members (id,project_id,display_name,role,is_active,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run("member-personal-home","personal-home","Owner","owner",1,now,now);
  db.raw.prepare("INSERT INTO gmail_connections (id,user_id,household_project_id,gmail_email,refresh_token_ciphertext,refresh_token_iv,key_generation,aad_version,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,1,'active',?,?)").run("idempotent-connection","user-1","personal-home","idempotent@example.test","x","y",1,now,now);
  db.raw.prepare("INSERT INTO gmail_sync_runs (id,connection_id,user_id,days,message_limit,status,started_at) VALUES (?,?,?,?,?,'completed',?)").run("idempotent-run","idempotent-connection","user-1",7,1,now);
  db.raw.prepare("INSERT INTO gmail_messages (id,connection_id,gmail_message_id,sync_run_id,parse_status,created_at) VALUES (?,?,?,?,?,?)").run("idempotent-message","idempotent-connection","idempotent-gmail-id","idempotent-run","parsed",now);
  db.raw.prepare("INSERT INTO gmail_import_candidates (id,connection_id,gmail_message_row_id,user_id,status,merchant_name,amount,occurred_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run("idempotent-candidate","idempotent-connection","idempotent-message","user-1","ready","Shop",1000,now,now,now);
  const first=await importCandidate(db,{id:"user-1"},"idempotent-candidate",{project_id:"untrusted-a"});
  const repeated=await importCandidate(db,{id:"user-1"},"idempotent-candidate",{project_id:"untrusted-a"});
  assert.equal(repeated.import.id,first.import.id);assert.equal(repeated.transaction.id,first.transaction.id);assert.equal(db.raw.prepare("SELECT count(*) AS n FROM transactions").get().n,1);
  const ignoredTarget=await importCandidate(db,{id:"user-1"},"idempotent-candidate",{project_id:"untrusted-b"});
  assert.equal(ignoredTarget.import.id,first.import.id);
  await assert.rejects(()=>updateCandidate(db,{id:"user-1"},"idempotent-candidate",{status:"ready"}),(error)=>error.status===409&&error.message==="candidate_already_imported");
  assert.equal(db.raw.prepare("SELECT imported_project_id FROM gmail_import_candidates WHERE id='idempotent-candidate'").get().imported_project_id,"personal-home");
});

test("parallel candidate imports create one transaction and return the same result", async (t) => {
  const db=new SerializedDatabase();t.after(()=>db.close());seed(db);const now="2026-07-12T00:00:00.000Z";
  db.raw.prepare("INSERT INTO project_members (id,project_id,display_name,role,is_active,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run("parallel-member","personal-home","Owner","owner",1,now,now);
  db.raw.prepare("INSERT INTO gmail_connections (id,user_id,household_project_id,gmail_email,refresh_token_ciphertext,refresh_token_iv,key_generation,aad_version,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,1,'active',?,?)").run("parallel-connection","user-1","personal-home","parallel@example.test","x","y",1,now,now);
  db.raw.prepare("INSERT INTO gmail_sync_runs (id,connection_id,user_id,days,message_limit,status,started_at) VALUES (?,?,?,?,?,'completed',?)").run("parallel-run","parallel-connection","user-1",7,1,now);
  db.raw.prepare("INSERT INTO gmail_messages (id,connection_id,gmail_message_id,sync_run_id,parse_status,created_at) VALUES (?,?,?,?,?,?)").run("parallel-message","parallel-connection","parallel-gmail-id","parallel-run","parsed",now);
  db.raw.prepare("INSERT INTO gmail_import_candidates (id,connection_id,gmail_message_row_id,user_id,status,merchant_name,amount,occurred_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run("parallel-candidate","parallel-connection","parallel-message","user-1","ready","Shop",1000,now,now,now);
  const results=await Promise.all([importCandidate(db,{id:"user-1"},"parallel-candidate",{project_id:"personal-home"}),importCandidate(db,{id:"user-1"},"parallel-candidate",{project_id:"personal-home"})]);
  assert.equal(results[0].import.id,results[1].import.id);assert.equal(results[0].transaction.id,results[1].transaction.id);assert.equal(db.raw.prepare("SELECT count(*) AS n FROM transactions").get().n,1);
});

test("payment parsing requires a nonzero body amount and distinguishes review states", () => {
  assert.equal(parsePaymentNotification("newsletter", { date:"Fri, 10 Jul 2026 12:30:00 +0900" }).parse_status, "parse_error");
  assert.equal(parsePaymentNotification("merchant: Shop\ndate: 2026/07/10", {}).parse_status, "parse_error");
  assert.equal(parsePaymentNotification("amount: 1200\ndate: 2026/07/10", {}).parse_status, "needs_review");
  assert.equal(parsePaymentNotification("amount: 1200\nmerchant: Shop\ndate: 2026/07/10", {}).parse_status, "parsed");
  assert.equal(parsePaymentNotification("amount: 0\nmerchant: Shop\ndate: 2026/07/10", {}).parse_status, "parse_error");
});

test("sync records non-payment messages without creating candidates and does not count them as duplicates", async (t) => {
  const db=new Database();t.after(()=>db.close());seed(db);const now="2026-07-12T00:00:00.000Z";
  const env=environment(async(url)=>{
    if(String(url).includes("oauth2.googleapis.com/token"))return Response.json({access_token:"access-secret"});
    if(String(url).includes("/messages?"))return Response.json({messages:[{id:"newsletter-message"}]});
    return Response.json({id:"newsletter-message",payload:{mimeType:"text/plain",headers:[{name:"From",value:"news@example.test"},{name:"Date",value:"Fri, 10 Jul 2026 12:30:00 +0900"}],body:{data:base64Url("普通のお知らせ")}}});
  });
  const encrypted=await encryptRefreshToken(env,"nonpayment-connection","user-1","refresh-secret");
  db.raw.prepare("INSERT INTO gmail_connections (id,user_id,household_project_id,gmail_email,refresh_token_ciphertext,refresh_token_iv,key_generation,aad_version,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,1,'active',?,?)").run("nonpayment-connection","user-1","personal-home","mail@example.test",encrypted.ciphertext,encrypted.iv,1,now,now);
  const first=await syncGmail(db,env,{id:"user-1"},"nonpayment-connection",{days:7,limit:1});
  const second=await syncGmail(db,env,{id:"user-1"},"nonpayment-connection",{days:7,limit:1});
  assert.equal(first.run.candidate_count,0);assert.equal(db.raw.prepare("SELECT count(*) AS n FROM gmail_import_candidates").get().n,0);
  assert.equal(db.raw.prepare("SELECT parse_status FROM gmail_messages").get().parse_status,"parse_error");assert.equal(second.run.processed_count,1);assert.equal(second.run.candidate_count,0);assert.equal(second.run.duplicate_count,0);
});

test("candidate import rejects blank merchant names and zero or null amounts", async (t) => {
  const db=new Database();t.after(()=>db.close());seed(db);const now="2026-07-12T00:00:00.000Z";
  db.raw.prepare("INSERT INTO gmail_connections (id,user_id,household_project_id,gmail_email,refresh_token_ciphertext,refresh_token_iv,key_generation,aad_version,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,1,'active',?,?)").run("incomplete-connection","user-1","personal-home","mail@example.test","x","y",1,now,now);
  db.raw.prepare("INSERT INTO gmail_sync_runs (id,connection_id,user_id,days,message_limit,status,started_at) VALUES (?,?,?,?,?,'completed',?)").run("incomplete-run","incomplete-connection","user-1",7,3,now);
  for(const [id,merchant,amount] of [["blank-merchant","   ",1000],["zero-amount","Shop",0],["null-amount","Shop",null]]){
    db.raw.prepare("INSERT INTO gmail_messages (id,connection_id,gmail_message_id,sync_run_id,parse_status,created_at) VALUES (?,?,?,?,?,?)").run(`${id}-message`,"incomplete-connection",`${id}-gmail-message`,"incomplete-run","parse_error",now);
    db.raw.prepare("INSERT INTO gmail_import_candidates (id,connection_id,gmail_message_row_id,user_id,status,merchant_name,amount,occurred_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run(id,"incomplete-connection",`${id}-message`,"user-1","needs_review",merchant,amount,now,now,now);
    await assert.rejects(()=>importCandidate(db,{id:"user-1"},id), (error)=>error.status===409&&error.message==="candidate_incomplete");
  }
});

test("sync reparses existing messages without candidates and preserves all counts", async (t) => {
  const parsed = await syncFixture({ "reparse-parsed": "amount: 1200\ndate: 2026/07/10\nmerchant: Shop" }, [["reparse-parsed", false]]);
  t.after(() => parsed.db.close());
  const parsedResult = await syncGmail(parsed.db, parsed.env, { id: "user-1" }, "sync-fixture-connection", { days: 7, limit: 10 });
  assert.deepEqual({ status: parsedResult.run.status, processed: parsedResult.run.processed_count, candidates: parsedResult.run.candidate_count, duplicates: parsedResult.run.duplicate_count }, { status: "completed", processed: 1, candidates: 1, duplicates: 0 });
  assert.equal(parsed.db.raw.prepare("SELECT parse_status FROM gmail_messages").get().parse_status, "parsed");

  const review = await syncFixture({ "reparse-review": "amount: 1200\nmerchant: Shop" }, [["reparse-review", false]]);
  t.after(() => review.db.close());
  const reviewResult = await syncGmail(review.db, review.env, { id: "user-1" }, "sync-fixture-connection", { days: 7, limit: 10 });
  assert.equal(reviewResult.run.candidate_count, 1);
  assert.equal(review.db.raw.prepare("SELECT status FROM gmail_import_candidates").get().status, "needs_review");

  const error = await syncFixture({ "reparse-error": "newsletter" }, [["reparse-error", false]]);
  t.after(() => error.db.close());
  const errorResult = await syncGmail(error.db, error.env, { id: "user-1" }, "sync-fixture-connection", { days: 7, limit: 10 });
  assert.deepEqual({ status: errorResult.run.status, processed: errorResult.run.processed_count, candidates: errorResult.run.candidate_count, duplicates: errorResult.run.duplicate_count }, { status: "completed", processed: 1, candidates: 0, duplicates: 0 });
  assert.equal(error.db.raw.prepare("SELECT parse_status FROM gmail_messages").get().parse_status, "parse_error");

  const duplicate = await syncFixture({ "existing-candidate": "amount: 1200\ndate: 2026/07/10\nmerchant: Shop" }, [["existing-candidate", true]]);
  t.after(() => duplicate.db.close());
  const duplicateResult = await syncGmail(duplicate.db, duplicate.env, { id: "user-1" }, "sync-fixture-connection", { days: 7, limit: 10 });
  assert.equal(duplicate.detailCalls(), 0);
  assert.deepEqual({ processed: duplicateResult.run.processed_count, candidates: duplicateResult.run.candidate_count, duplicates: duplicateResult.run.duplicate_count }, { processed: 0, candidates: 0, duplicates: 1 });

  const mixed = await syncFixture({ valid: "amount: 1200\ndate: 2026/07/10\nmerchant: Shop", normal: "newsletter" });
  t.after(() => mixed.db.close());
  const mixedResult = await syncGmail(mixed.db, mixed.env, { id: "user-1" }, "sync-fixture-connection", { days: 7, limit: 10 });
  assert.deepEqual({ listed: mixedResult.run.listed_count, processed: mixedResult.run.processed_count, candidates: mixedResult.run.candidate_count, duplicates: mixedResult.run.duplicate_count }, { listed: 2, processed: 2, candidates: 1, duplicates: 0 });
});
