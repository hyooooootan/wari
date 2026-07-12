import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { decryptRefreshToken, disconnectGmail, encryptRefreshToken, finishGmailOAuth, importCandidate, startGmailOAuth, syncGmail } from "../functions/lib/gmail.js";
import { extractGmailText } from "../functions/lib/gmail-mime.js";
import { parsePaymentNotification } from "../functions/lib/gmail-parsers.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const schema = readFileSync(`${root}/db/schema.sql`, "utf8");

class Statement {
  constructor(database, sql, bindings = []) { this.database = database; this.sql = sql; this.bindings = bindings; }
  bind(...bindings) { return new Statement(this.database, this.sql, bindings); }
  async first() { return this.database.prepare(this.sql).get(...this.bindings) ?? null; }
  async all() { return { results: this.database.prepare(this.sql).all(...this.bindings) }; }
  async run() { if(this.database.owner?.failSqlOnce&&this.sql.includes(this.database.owner.failSqlOnce)){this.database.owner.failSqlOnce=null;throw new Error("injected_statement_failure");}const value = this.database.prepare(this.sql).run(...this.bindings); return { meta: { changes: Number(value.changes) } }; }
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

function base64Url(value) { return Buffer.from(value).toString("base64url"); }
function environment(fetch) { return { GMAIL_CLIENT_ID: "client", GMAIL_CLIENT_SECRET: "secret", GMAIL_TOKEN_KEY_CURRENT_GENERATION: "1", GMAIL_TOKEN_KEY_V1: Buffer.alloc(32, 7).toString("base64"), GMAIL_FETCH: fetch }; }
function seed(db) {
  const now = "2026-07-12T00:00:00.000Z";
  db.raw.prepare("INSERT INTO users (id,google_sub,email,created_at,updated_at) VALUES (?,?,?,?,?)").run("user-1","sub-1","user@example.test",now,now);
  db.raw.prepare("INSERT INTO projects (id,name,project_type,created_at,updated_at) VALUES (?,?,?,?,?)").run("personal-home","Personal","household",now,now);
  db.raw.prepare("INSERT INTO project_user_roles (project_id,user_id,role,created_at,updated_at) VALUES (?,?,?,?,?)").run("personal-home","user-1","owner",now,now);
}

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
  db.raw.prepare("INSERT INTO project_shares (id,project_id,token_hash,role,created_by_user_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run("share-after-start","personal-home","hash-after-start","viewer","user-1","2026-07-12T00:00:00.000Z","2026-07-12T00:00:00.000Z");
  await assert.rejects(()=>finishGmailOAuth(db,env,new Request(`https://example.test/api/gmail/oauth/callback?state=${encodeURIComponent(state)}&code=code`,{headers:{cookie}}),{id:"user-1"}),/gmail_personal_household_required/);
  assert.equal(fetchCalls,0);
  assert.equal(db.raw.prepare("SELECT project_id FROM gmail_oauth_states").get().project_id,"personal-home");
  assert.notEqual(db.raw.prepare("SELECT used_at FROM gmail_oauth_states").get().used_at,null);
});

test("legacy household shares follow active, expired, and revoked read behavior", async (t) => {
  const db=new Database();t.after(()=>db.close());seed(db);const env=environment(async()=>Response.json({}));const request=new Request("https://example.test/api/gmail/oauth/start");
  db.raw.prepare("UPDATE projects SET share_token=?,share_expires_at=NULL WHERE id=?").run("legacy-active-token","personal-home");
  await assert.rejects(()=>startGmailOAuth(db,env,request,{id:"user-1"},"personal-home"),/gmail_personal_household_required/);
  db.raw.prepare("UPDATE projects SET share_expires_at=? WHERE id=?").run("2000-01-01T00:00:00.000Z","personal-home");
  await startGmailOAuth(db,env,request,{id:"user-1"},"personal-home");
  db.raw.prepare("UPDATE projects SET share_token=NULL,share_expires_at=NULL WHERE id=?").run("personal-home");
  await startGmailOAuth(db,env,request,{id:"user-1"},"personal-home");
  assert.equal(db.raw.prepare("SELECT count(*) AS n FROM gmail_oauth_states").get().n,2);
});

test("OAuth callback rejects sharing added after its final read and before connection storage", async (t) => {
  const db=new Database();t.after(()=>db.close());seed(db);let profileRequested=false;const env=environment(async(url)=>{
    if(String(url).includes("/token"))return Response.json({access_token:"access-secret",refresh_token:"refresh-secret"});
    profileRequested=true;
    db.raw.prepare("INSERT INTO project_shares (id,project_id,token_hash,role,created_by_user_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run("oauth-race-share","personal-home","oauth-race-hash","viewer","user-1","2026-07-12T00:00:00.000Z","2026-07-12T00:00:00.000Z");
    return Response.json({emailAddress:"mail@example.test"});
  });
  const started=await startGmailOAuth(db,env,new Request("https://example.test/api/gmail/oauth/start"),{id:"user-1"},"personal-home");
  const state=new URL(started.url).searchParams.get("state");const cookie=started.cookie.split(";",1)[0];
  await assert.rejects(()=>finishGmailOAuth(db,env,new Request(`https://example.test/api/gmail/oauth/callback?state=${encodeURIComponent(state)}&code=code`,{headers:{cookie}}),{id:"user-1"}),/gmail_personal_household_required/);
  assert.equal(profileRequested,true);
  assert.equal(db.raw.prepare("SELECT count(*) AS n FROM gmail_connections").get().n,0);
});

test("multiple message and candidate writes roll back together and permit a later sync retry", async (t) => {
  const db=new Database();t.after(()=>db.close());seed(db);const env=environment(async(url)=>{
    if(String(url).includes("oauth2.googleapis.com/token"))return Response.json({access_token:"access-secret"});
    if(String(url).includes("/messages?"))return Response.json({messages:[{id:"retry-message-1"},{id:"retry-message-2"}]});
    return Response.json({payload:{mimeType:"text/plain",headers:[{name:"From",value:"notice@jcb.co.jp"}],body:{data:base64Url("amount 1200 2026/07/10 shop")}}});
  });
  const encrypted=await encryptRefreshToken(env,"retry-connection","user-1","refresh-secret");
  db.raw.prepare(`INSERT INTO gmail_connections (id,user_id,gmail_email,refresh_token_ciphertext,refresh_token_iv,key_generation,aad_version,status,created_at,updated_at) VALUES (?,?,?,?,?,?,1,'active',?,?)`).run("retry-connection","user-1","retry@example.test",encrypted.ciphertext,encrypted.iv,1,"2026-07-12T00:00:00.000Z","2026-07-12T00:00:00.000Z");
  db.failBatchAt=4;const failed=await syncGmail(db,env,{id:"user-1"},"retry-connection",{days:7,limit:2});
  assert.equal(failed.run.error_count,1);assert.equal(db.raw.prepare("SELECT count(*) AS n FROM gmail_messages").get().n,0);assert.equal(db.raw.prepare("SELECT count(*) AS n FROM gmail_import_candidates").get().n,0);
  const retried=await syncGmail(db,env,{id:"user-1"},"retry-connection",{days:7,limit:2});
  assert.equal(retried.run.candidate_count,2);assert.equal(db.raw.prepare("SELECT count(*) AS n FROM gmail_import_candidates").get().n,2);
});

test("sync revalidates its selected personal household against each sharing mechanism", async (t) => {
  const cases=[
    ["hashed share",(db,now)=>db.raw.prepare("INSERT INTO project_shares (id,project_id,token_hash,role,created_by_user_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run("race-share","personal-home","race-hash","viewer","user-1",now,now)],
    ["legacy share",(db)=>db.raw.prepare("UPDATE projects SET share_token=?,share_expires_at=NULL WHERE id=?").run("legacy-race-token","personal-home")],
    ["other user role",(db,now)=>{db.raw.prepare("INSERT INTO users (id,google_sub,email,created_at,updated_at) VALUES (?,?,?,?,?)").run("user-2","sub-2","user2@example.test",now,now);db.raw.prepare("INSERT INTO project_user_roles (project_id,user_id,role,created_at,updated_at) VALUES (?,?,?,?,?)").run("personal-home","user-2","viewer",now,now);}],
  ];
  for(const [name,share] of cases){await t.test(name,async()=>{
    const db=new Database();seed(db);const now="2026-07-12T00:00:00.000Z";
    db.raw.prepare("INSERT INTO projects (id,name,project_type,created_at,updated_at) VALUES (?,?,?,?,?)").run("later-personal-home","Later","household","2026-07-13T00:00:00.000Z","2026-07-13T00:00:00.000Z");
    db.raw.prepare("INSERT INTO project_user_roles (project_id,user_id,role,created_at,updated_at) VALUES (?,?,?,?,?)").run("later-personal-home","user-1","owner",now,now);
    const env=environment(async(url)=>{
      if(String(url).includes("oauth2.googleapis.com/token"))return Response.json({access_token:"access-secret"});
      if(String(url).includes("/messages?"))return Response.json({messages:[{id:"race-message-1"},{id:"race-message-2"}]});
      return Response.json({payload:{mimeType:"text/plain",headers:[{name:"From",value:"notice@jcb.co.jp"}],body:{data:base64Url("amount 1200 2026/07/10 shop")}}});
    });
    const encrypted=await encryptRefreshToken(env,"sync-race-connection","user-1","refresh-secret");
    db.raw.prepare("INSERT INTO gmail_connections (id,user_id,gmail_email,refresh_token_ciphertext,refresh_token_iv,key_generation,aad_version,status,created_at,updated_at) VALUES (?,?,?,?,?,?,1,'active',?,?)").run("sync-race-connection","user-1","race@example.test",encrypted.ciphertext,encrypted.iv,1,now,now);
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

test("failed revocation retains encrypted token for retry", async (t) => {
  const db=new Database();t.after(()=>db.close());seed(db);const env=environment(async()=>new Response("unavailable",{status:503}));
  const encrypted=await encryptRefreshToken(env,"revoke-connection","user-1","refresh-secret");
  db.raw.prepare(`INSERT INTO gmail_connections (id,user_id,gmail_email,refresh_token_ciphertext,refresh_token_iv,key_generation,aad_version,status,created_at,updated_at) VALUES (?,?,?,?,?,?,1,'active',?,?)`).run("revoke-connection","user-1","revoke@example.test",encrypted.ciphertext,encrypted.iv,1,"2026-07-12T00:00:00.000Z","2026-07-12T00:00:00.000Z");
  await assert.rejects(()=>disconnectGmail(db,env,{id:"user-1"},"revoke-connection"),/gmail_revocation_failed/);
  const row=db.raw.prepare("SELECT status,refresh_token_ciphertext FROM gmail_connections WHERE id=?").get("revoke-connection");assert.equal(row.status,"active");assert.equal(row.refresh_token_ciphertext,encrypted.ciphertext);
});

test("shared household rejects Gmail candidate import", async (t) => {
  const db=new Database();t.after(()=>db.close());seed(db);const now="2026-07-12T00:00:00.000Z";
  db.raw.prepare("INSERT INTO projects (id,name,project_type,created_at,updated_at) VALUES (?,?,?,?,?)").run("shared-home","Home","household",now,now);
  db.raw.prepare("INSERT INTO project_user_roles (project_id,user_id,role,created_at,updated_at) VALUES (?,?,?,?,?)").run("shared-home","user-1","owner",now,now);
  db.raw.prepare("INSERT INTO project_shares (id,project_id,token_hash,role,created_by_user_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run("share-1","shared-home","hash-1","viewer","user-1",now,now);
  db.raw.prepare("INSERT INTO gmail_connections (id,user_id,gmail_email,refresh_token_ciphertext,refresh_token_iv,key_generation,aad_version,status,created_at,updated_at) VALUES (?,?,?,?,?,?,1,'active',?,?)").run("c1","user-1","mail@example.test","x","y",1,now,now);
  db.raw.prepare("INSERT INTO gmail_sync_runs (id,connection_id,user_id,days,message_limit,status,started_at) VALUES (?,?,?,?,?,'completed',?)").run("run-1","c1","user-1",7,1,now);
  db.raw.prepare("INSERT INTO gmail_messages (id,connection_id,gmail_message_id,sync_run_id,parse_status,created_at) VALUES (?,?,?,?,?,?)").run("m1","c1","gm1","run-1","parsed",now);
  db.raw.prepare("INSERT INTO gmail_import_candidates (id,connection_id,gmail_message_row_id,user_id,status,merchant_name,amount,occurred_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run("candidate-1","c1","m1","user-1","ready","Shop",1000,now,now,now);
  await assert.rejects(()=>importCandidate(db,{id:"user-1"},"candidate-1",{project_id:"shared-home"}),/gmail_import_target_forbidden/);
  assert.equal(db.raw.prepare("SELECT count(*) AS n FROM transactions WHERE project_id=?").get("shared-home").n,0);
});

test("candidate import rejects a role added between permission read and its write batch", async (t) => {
  const db=new Database();t.after(()=>db.close());seed(db);const now="2026-07-12T00:00:00.000Z";
  db.raw.prepare("INSERT INTO project_members (id,project_id,display_name,role,is_active,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run("personal-member","personal-home","Owner","owner",1,now,now);
  db.raw.prepare("INSERT INTO gmail_connections (id,user_id,gmail_email,refresh_token_ciphertext,refresh_token_iv,key_generation,aad_version,status,created_at,updated_at) VALUES (?,?,?,?,?,?,1,'active',?,?)").run("race-connection","user-1","race@example.test","x","y",1,now,now);
  db.raw.prepare("INSERT INTO gmail_sync_runs (id,connection_id,user_id,days,message_limit,status,started_at) VALUES (?,?,?,?,?,'completed',?)").run("race-run","race-connection","user-1",7,1,now);
  db.raw.prepare("INSERT INTO gmail_messages (id,connection_id,gmail_message_id,sync_run_id,parse_status,created_at) VALUES (?,?,?,?,?,?)").run("race-message","race-connection","race-gmail-id","race-run","parsed",now);
  db.raw.prepare("INSERT INTO gmail_import_candidates (id,connection_id,gmail_message_row_id,user_id,status,merchant_name,amount,occurred_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run("race-candidate","race-connection","race-message","user-1","ready","Shop",1000,now,now,now);
  db.beforeBatch=async()=>{
    db.raw.prepare("INSERT INTO users (id,google_sub,email,created_at,updated_at) VALUES (?,?,?,?,?)").run("user-2","sub-2","user2@example.test",now,now);
    db.raw.prepare("INSERT INTO project_user_roles (project_id,user_id,role,created_at,updated_at) VALUES (?,?,?,?,?)").run("personal-home","user-2","viewer",now,now);
  };
  await assert.rejects(()=>importCandidate(db,{id:"user-1"},"race-candidate",{project_id:"personal-home"}),/gmail_import_target_forbidden/);
  assert.equal(db.raw.prepare("SELECT count(*) AS n FROM import_records WHERE project_id=?").get("personal-home").n,0);
  assert.equal(db.raw.prepare("SELECT count(*) AS n FROM transactions WHERE project_id=?").get("personal-home").n,0);
  assert.equal(db.raw.prepare("SELECT status FROM gmail_import_candidates WHERE id=?").get("race-candidate").status,"ready");
});

test("sync remains available when a shared household and a personal household coexist", async (t) => {
  const db=new Database();t.after(()=>db.close());seed(db);const now="2026-07-12T00:00:00.000Z";
  db.raw.prepare("INSERT INTO projects (id,name,project_type,created_at,updated_at) VALUES (?,?,?,?,?)").run("shared-a","Shared","household",now,now);
  db.raw.prepare("INSERT INTO project_user_roles (project_id,user_id,role,created_at,updated_at) VALUES (?,?,?,?,?)").run("shared-a","user-1","owner",now,now);
  db.raw.prepare("INSERT INTO project_shares (id,project_id,token_hash,role,created_by_user_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run("shared-a-link","shared-a","shared-a-hash","viewer","user-1",now,now);
  const env=environment(async(url)=>String(url).includes("/token")?Response.json({access_token:"access-secret"}):Response.json({messages:[]}));
  const encrypted=await encryptRefreshToken(env,"mixed-connection","user-1","refresh-secret");
  db.raw.prepare("INSERT INTO gmail_connections (id,user_id,gmail_email,refresh_token_ciphertext,refresh_token_iv,key_generation,aad_version,status,created_at,updated_at) VALUES (?,?,?,?,?,?,1,'active',?,?)").run("mixed-connection","user-1","mixed@example.test",encrypted.ciphertext,encrypted.iv,1,now,now);
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
  db.raw.prepare(`INSERT INTO gmail_connections (id,user_id,gmail_email,refresh_token_ciphertext,refresh_token_iv,key_generation,aad_version,status,created_at,updated_at) VALUES (?,?,?,?,?,?,1,'active',?,?)`).run("connection-1","user-1","mail@example.test",encrypted.ciphertext,encrypted.iv,1,"2026-07-12T00:00:00.000Z","2026-07-12T00:00:00.000Z");
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
    db.raw.prepare(`INSERT INTO gmail_connections (id,user_id,gmail_email,refresh_token_ciphertext,refresh_token_iv,key_generation,aad_version,status,created_at,updated_at) VALUES (?,?,?,?,?,?,1,'active',?,?)`).run(`connection-${status}`,"user-1",`${status}@example.test`,encrypted.ciphertext,encrypted.iv,1,"2026-07-12T00:00:00.000Z","2026-07-12T00:00:00.000Z");
    const result=await syncGmail(db,env,{id:"user-1"},`connection-${status}`,{days:7,limit:1}); assert.equal(result.run.status,expected); db.close();
  }
});

test("token invalid_grant requests reauthorization without Gmail API calls", async (t) => {
  const db=new Database();t.after(()=>db.close());seed(db);let calls=0;const env=environment(async()=>{calls++;return Response.json({error:"invalid_grant"},{status:400});});
  const encrypted=await encryptRefreshToken(env,"invalid-grant","user-1","refresh-secret");
  db.raw.prepare(`INSERT INTO gmail_connections (id,user_id,gmail_email,refresh_token_ciphertext,refresh_token_iv,key_generation,aad_version,status,created_at,updated_at) VALUES (?,?,?,?,?,?,1,'active',?,?)`).run("invalid-grant","user-1","invalid@example.test",encrypted.ciphertext,encrypted.iv,1,"2026-07-12T00:00:00.000Z","2026-07-12T00:00:00.000Z");
  const result=await syncGmail(db,env,{id:"user-1"},"invalid-grant",{days:7,limit:1});assert.equal(result.run.status,"reauthorization_required");assert.equal(calls,1);
});

test("candidate import retry repairs its final status without a second transaction", async (t) => {
  const db=new Database();t.after(()=>db.close());seed(db);const now="2026-07-12T00:00:00.000Z";
  db.raw.prepare("INSERT INTO projects (id,name,project_type,created_at,updated_at) VALUES (?,?,?,?,?)").run("private-home","Home","household",now,now);
  db.raw.prepare("INSERT INTO project_user_roles (project_id,user_id,role,created_at,updated_at) VALUES (?,?,?,?,?)").run("private-home","user-1","owner",now,now);
  db.raw.prepare("INSERT INTO project_members (id,project_id,display_name,role,is_active,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run("member-1","private-home","Owner","owner",1,now,now);
  db.raw.prepare("INSERT INTO gmail_connections (id,user_id,gmail_email,refresh_token_ciphertext,refresh_token_iv,key_generation,aad_version,status,created_at,updated_at) VALUES (?,?,?,?,?,?,1,'active',?,?)").run("c2","user-1","mail2@example.test","x","y",1,now,now);
  db.raw.prepare("INSERT INTO gmail_sync_runs (id,connection_id,user_id,days,message_limit,status,started_at) VALUES (?,?,?,?,?,'completed',?)").run("run-2","c2","user-1",7,1,now);
  db.raw.prepare("INSERT INTO gmail_messages (id,connection_id,gmail_message_id,sync_run_id,parse_status,created_at) VALUES (?,?,?,?,?,?)").run("m2","c2","gm2","run-2","parsed",now);
  db.raw.prepare("INSERT INTO gmail_import_candidates (id,connection_id,gmail_message_row_id,user_id,status,merchant_name,amount,occurred_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run("candidate-2","c2","m2","user-1","ready","Shop",1000,now,now,now);
  db.failSqlOnce="UPDATE gmail_import_candidates SET status='imported'";
  await assert.rejects(()=>importCandidate(db,{id:"user-1"},"candidate-2",{project_id:"private-home"}),/injected_statement_failure/);
  await importCandidate(db,{id:"user-1"},"candidate-2",{project_id:"private-home"});
  assert.equal(db.raw.prepare("SELECT count(*) AS n FROM transactions WHERE project_id=?").get("private-home").n,1);assert.equal(db.raw.prepare("SELECT status FROM gmail_import_candidates WHERE id=?").get("candidate-2").status,"imported");
});
