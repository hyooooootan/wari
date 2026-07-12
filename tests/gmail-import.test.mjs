import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { decryptRefreshToken, encryptRefreshToken, syncGmail } from "../functions/lib/gmail.js";
import { extractGmailText } from "../functions/lib/gmail-mime.js";
import { parsePaymentNotification } from "../functions/lib/gmail-parsers.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const schema = readFileSync(`${root}/db/schema.sql`, "utf8");

class Statement {
  constructor(database, sql, bindings = []) { this.database = database; this.sql = sql; this.bindings = bindings; }
  bind(...bindings) { return new Statement(this.database, this.sql, bindings); }
  async first() { return this.database.prepare(this.sql).get(...this.bindings) ?? null; }
  async all() { return { results: this.database.prepare(this.sql).all(...this.bindings) }; }
  async run() { const value = this.database.prepare(this.sql).run(...this.bindings); return { meta: { changes: Number(value.changes) } }; }
}
class Database {
  constructor() { this.raw = new DatabaseSync(":memory:"); this.raw.exec(schema); }
  prepare(sql) { return new Statement(this.raw, sql); }
  close() { this.raw.close(); }
}

function base64Url(value) { return Buffer.from(value).toString("base64url"); }
function environment(fetch) { return { GMAIL_CLIENT_ID: "client", GMAIL_CLIENT_SECRET: "secret", GMAIL_TOKEN_KEY_CURRENT_GENERATION: "1", GMAIL_TOKEN_KEY_V1: Buffer.alloc(32, 7).toString("base64"), GMAIL_FETCH: fetch }; }
function seed(db) {
  const now = "2026-07-12T00:00:00.000Z";
  db.raw.prepare("INSERT INTO users (id,google_sub,email,created_at,updated_at) VALUES (?,?,?,?,?)").run("user-1","sub-1","user@example.test",now,now);
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
  for (const [status, expected] of [[401,"reauthorization_required"],[429,"rate_limited"]]) {
    const db=new Database(); seed(db); const env=environment(async()=>new Response("denied",{status}));
    const encrypted=await encryptRefreshToken(env,`connection-${status}`,"user-1","refresh-secret");
    db.raw.prepare(`INSERT INTO gmail_connections (id,user_id,gmail_email,refresh_token_ciphertext,refresh_token_iv,key_generation,aad_version,status,created_at,updated_at) VALUES (?,?,?,?,?,?,1,'active',?,?)`).run(`connection-${status}`,"user-1",`${status}@example.test`,encrypted.ciphertext,encrypted.iv,1,"2026-07-12T00:00:00.000Z","2026-07-12T00:00:00.000Z");
    const result=await syncGmail(db,env,{id:"user-1"},`connection-${status}`,{days:7,limit:1}); assert.equal(result.run.status,expected); db.close();
  }
});
