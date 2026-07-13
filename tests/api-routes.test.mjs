import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { onRequest } from "../functions/api/[[path]].js";
import { sha256Hex } from "../functions/lib/crypto.js";
import { createGoogleStart, finishGoogleCallback } from "../functions/lib/oauth.js";
import { encryptRefreshToken } from "../functions/lib/gmail.js";
import { createSession, ensureUser } from "../functions/lib/auth.js";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const schema = readFileSync(`${repositoryRoot}/db/schema.sql`, "utf8");

class D1Statement {
  constructor(database, sql, bindings = []) {
    this.database = database;
    this.sql = sql;
    this.bindings = bindings;
  }

  bind(...bindings) {
    return new D1Statement(this.database, this.sql, bindings);
  }

  async all() {
    return { results: this.database.prepare(this.sql).all(...this.bindings) };
  }

  async first() {
    return this.database.prepare(this.sql).get(...this.bindings) ?? null;
  }

  async run() {
    const result = this.database.prepare(this.sql).run(...this.bindings);
    return {
      success: true,
      meta: {
        changes: Number(result.changes),
        last_row_id: Number(result.lastInsertRowid),
      },
    };
  }
}

class D1Database {
  constructor() {
    this.database = new DatabaseSync(":memory:");
    this.database.exec(schema);
    this.session = null;
  }

  prepare(sql) {
    return new D1Statement(this.database, sql);
  }

  async batch(statements) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (let index=0;index<statements.length;index++) {
        if(this.failBatchAt===index)throw new Error("injected_batch_failure");
        results.push(await statements[index].run());
      }
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    } finally {
      this.failBatchAt=undefined;
    }
  }

  close() {
    this.database.close();
  }
}

async function testSession(db) {
  if (db.session) return db.session;
  const now = "2026-07-12T00:00:00.000Z";
  const sessionId = "test-session";
  const csrf = "test-csrf";
  db.database.prepare(`INSERT INTO users (
    id, google_sub, email, name, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?)`).run("test-user", "google-sub-test", "test@example.test", "Test User", now, now);
  db.database.prepare(`INSERT INTO sessions (
    id_hash, user_id, csrf_token, created_at, expires_at
  ) VALUES (?, ?, ?, ?, ?)`).run(await sha256Hex(sessionId), "test-user", csrf, now, "2099-01-01T00:00:00.000Z");
  db.session = { sessionId, csrf };
  return db.session;
}

async function request(db, method, path, body, extraEnv = {}) {
  const init = { method, headers: {} };
  if (db && extraEnv.auth !== false) {
    const session = await testSession(db);
    init.headers.cookie = `wari_session=${session.sessionId}; wari_csrf=${session.csrf}`;
    if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) init.headers["x-csrf-token"] = session.csrf;
  }
  if (body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const response = await onRequest({
    request: new Request(`https://example.test${path}`, init),
    env: { DB: db, ...extraEnv },
  });
  return { response, body: await response.json() };
}

async function createProject(db, project) {
  const result = await request(db, "POST", "/api/projects", project);
  assert.equal(result.response.status, 201);
  return result.body;
}

test("auth routes create sessions, require CSRF, and hide unowned projects", async (t) => {
  const db = new D1Database();
  t.after(() => db.close());

  const unauthenticated = await request(db, "GET", "/api/projects", undefined, { auth: false });
  assert.equal(unauthenticated.response.status, 401);

  const session = await request(db, "GET", "/api/auth/session");
  assert.equal(session.response.status, 200);
  assert.equal(session.body.authenticated, true);
  assert.equal(session.body.csrf_token, "test-csrf");

  const blockedCsrf = await request(db, "POST", "/api/projects", { id: "blocked", name: "Blocked" }, { auth: false });
  assert.equal(blockedCsrf.response.status, 401);

  db.database.prepare(`INSERT INTO projects (
    id, name, project_type, currency, share_role, created_at, updated_at
  ) VALUES ('owner-unknown-project', 'Hidden', 'split', 'JPY', 'editor', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`).run();
  const list = await request(db, "GET", "/api/projects");
  assert.equal(list.response.status, 200);
  assert.deepEqual(list.body.projects.map((project) => project.id), []);
});

test("project CRUD creates a household owner and enforces share expiry", async (t) => {
  const db = new D1Database();
  t.after(() => db.close());

  const created = await createProject(db, { id: "home", name: "家計", project_type: "household", currency: "jpy" });
  assert.equal(created.projects[0].id, "home");
  assert.equal(created.projects[0].currency, "JPY");
  assert.equal(created.project_members.length, 1);
  assert.equal(created.project_members[0].display_name, "自分");
  assert.equal(created.project_members[0].role, "owner");

  const list = await request(db, "GET", "/api/projects");
  assert.equal(list.response.status, 200);
  assert.equal(list.body.projects[0].member_count, 1);

  const patched = await request(db, "PATCH", "/api/projects/home", { name: "家庭会計" });
  assert.equal(patched.response.status, 200);
  assert.equal(patched.body.project.name, "家庭会計");

  const invalidPatch = await request(db, "PATCH", "/api/projects/home", { created_at: "2026-01-01" });
  assert.equal(invalidPatch.response.status, 400);
  assert.deepEqual(invalidPatch.body, { error: "unknown_field", field: "created_at" });

  const defaultShare = await request(db, "POST", "/api/projects/home/share");
  assert.equal(defaultShare.response.status, 200);
  assert.equal(defaultShare.body.role, "editor");

  const activeShare = await request(db, "POST", "/api/projects/home/share", { expires_at: "2099-01-01T00:00:00.000Z" });
  assert.equal(activeShare.response.status, 200);
  assert.equal(typeof activeShare.body.token, "string");
  assert.equal(db.database.prepare("SELECT share_token FROM projects WHERE id = 'home'").get().share_token, null);
  const storedShare = db.database.prepare("SELECT token_hash, role, expires_at FROM project_shares WHERE project_id = 'home' ORDER BY created_at DESC LIMIT 1").get();
  assert.equal(storedShare.token_hash === activeShare.body.token, false);
  assert.equal(storedShare.role, "editor");

  const shared = await request(db, "GET", `/api/share/${activeShare.body.token}`);
  assert.equal(shared.response.status, 200);
  assert.equal(shared.body.projects[0].id, "home");
  assert.equal(Object.hasOwn(shared.body.projects[0], "share_token"), false);
  assert.equal(shared.body.share.role, "editor");

  const projectGraph = await request(db, "GET", "/api/projects/home");
  assert.equal(projectGraph.response.status, 200);
  assert.equal(Object.hasOwn(projectGraph.body.projects[0], "share_token"), false);

  const expiredShare = await request(db, "POST", "/api/projects/home/share", { expires_at: "2020-01-01T00:00:00.000Z", rotate: true });
  assert.equal(expiredShare.response.status, 200);
  const oldShareAfterRotate = await request(db, "GET", `/api/share/${activeShare.body.token}`);
  assert.equal(oldShareAfterRotate.response.status, 404);
  const expiredRead = await request(db, "GET", `/api/share/${expiredShare.body.token}`);
  assert.equal(expiredRead.response.status, 404);
  assert.deepEqual(expiredRead.body, { error: "not_found" });
  const shareRows = db.database.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN revoked_at IS NOT NULL THEN 1 ELSE 0 END) AS revoked FROM project_shares WHERE project_id = 'home'").get();
  assert.equal(shareRows.total, 3);
  assert.equal(shareRows.revoked, 2);

  const householdFinalize = await request(db, "POST", "/api/projects/home/finalize");
  assert.equal(householdFinalize.response.status, 409);
  assert.deepEqual(householdFinalize.body, { error: "project_not_split" });
});

test("household creation rolls back project, member, and owner role when owner insertion fails", async (t) => {
  const db=new D1Database();t.after(()=>db.close());
  db.failBatchAt=2;
  const result=await request(db,"POST","/api/projects",{id:"failed-home",name:"Failed",project_type:"household",initial_member:{id:"failed-owner",display_name:"Owner"}});
  assert.equal(result.response.status,500);
  assert.equal(db.database.prepare("SELECT count(*) AS n FROM projects WHERE id=?").get("failed-home").n,0);
  assert.equal(db.database.prepare("SELECT count(*) AS n FROM project_members WHERE project_id=?").get("failed-home").n,0);
  assert.equal(db.database.prepare("SELECT count(*) AS n FROM project_user_roles WHERE project_id=?").get("failed-home").n,0);
});

test("household creation preserves the client member and validates the project payload", async (t) => {
  const db=new D1Database();t.after(()=>db.close());
  const created=await request(db,"POST","/api/projects",{id:"device-home",name:"Device home",project_type:"household",initial_member:{id:"device-member",display_name:"Device owner"}});
  assert.equal(created.response.status,201);assert.deepEqual(created.body.project_members.map((member)=>[member.id,member.display_name,member.role]),[["device-member","Device owner","owner"]]);
  const unknownProjectField=await request(db,"POST","/api/projects",{id:"unknown-project",name:"Unknown",unexpected:true});
  assert.equal(unknownProjectField.response.status,400);assert.deepEqual(unknownProjectField.body,{error:"unknown_field",field:"unexpected"});
  const unknownMemberField=await request(db,"POST","/api/projects",{id:"unknown-member",name:"Unknown",project_type:"household",initial_member:{id:"member",display_name:"Owner",role:"owner"}});
  assert.equal(unknownMemberField.response.status,400);assert.deepEqual(unknownMemberField.body,{error:"unknown_field",field:"role"});
  const splitWithMember=await request(db,"POST","/api/projects",{id:"split-member",name:"Split",project_type:"split",initial_member:{id:"member",display_name:"Owner"}});
  assert.equal(splitWithMember.response.status,400);assert.deepEqual(splitWithMember.body,{error:"invalid_field",field:"initial_member"});
  const split=await request(db,"POST","/api/projects",{id:"plain-split",name:"Split",project_type:"split"});
  assert.equal(split.response.status,201);assert.equal(split.body.project_members.length,0);
});

test("Gmail OAuth start validates the selected household and requires a JSON project identifier", async (t) => {
  const db = new D1Database();
  t.after(() => db.close());
  await createProject(db, { id: "shared-home", name: "共有中", project_type: "household" });
  await createProject(db, { id: "private-home", name: "個人用", project_type: "household" });
  await request(db, "POST", "/api/projects/shared-home/share");
  const env = { GMAIL_CLIENT_ID: "test-client", GMAIL_CLIENT_SECRET: "test-secret" };

  const empty = await request(db, "POST", "/api/gmail/oauth/start", undefined, env);
  assert.equal(empty.response.status, 400);
  assert.deepEqual(empty.body, { error: "invalid_json" });

  const shared = await request(db, "POST", "/api/gmail/oauth/start", { project_id: "shared-home" }, env);
  assert.equal(shared.response.status, 403);
  assert.deepEqual(shared.body, { error: "gmail_personal_household_required" });
  assert.equal(db.database.prepare("SELECT COUNT(*) AS total FROM gmail_oauth_states").get().total, 0);

  const personal = await request(db, "POST", "/api/gmail/oauth/start", { project_id: "private-home" }, env);
  assert.equal(personal.response.status, 200);
  assert.match(personal.body.url, /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
  assert.equal(db.database.prepare("SELECT project_id FROM gmail_oauth_states").get().project_id, "private-home");
});

test("household links require target edit access and revoked access blocks later derived writes", async (t) => {
  const db = new D1Database();
  t.after(() => db.close());
  await createProject(db, { id: "allowed-home", name: "Allowed", project_type: "household" });
  await createProject(db, { id: "split-access", name: "Split", project_type: "split" });
  await request(db, "POST", "/api/projects/split-access/members", { id: "linked-member", display_name: "Member" });
  const now = "2026-07-12T00:00:00.000Z";
  db.database.prepare("INSERT INTO users (id,google_sub,email,created_at,updated_at) VALUES (?,?,?,?,?)").run("other-user", "other-sub", "other@example.test", now, now);
  db.database.prepare("INSERT INTO projects (id,name,project_type,created_at,updated_at) VALUES (?,?,?,?,?)").run("forbidden-home", "Forbidden", "household", now, now);
  db.database.prepare("INSERT INTO project_members (id,project_id,display_name,role,is_active,created_at,updated_at) VALUES (?,?,?,?,1,?,?)").run("forbidden-owner", "forbidden-home", "Owner", "owner", now, now);
  db.database.prepare("INSERT INTO project_user_roles (project_id,user_id,role,created_at,updated_at) VALUES (?,?,?,?,?)").run("forbidden-home", "other-user", "owner", now, now);

  const forbidden = await request(db, "PATCH", "/api/project-members/linked-member/household-link", { action: "link", household_project_id: "forbidden-home" });
  assert.equal(forbidden.response.status, 404);
  assert.equal(db.database.prepare("SELECT linked_household_project_id FROM project_members WHERE id='linked-member'").get().linked_household_project_id, null);

  const linked = await request(db, "PATCH", "/api/project-members/linked-member/household-link", { action: "link", household_project_id: "allowed-home" });
  assert.equal(linked.response.status, 200);
  await request(db, "POST", "/api/projects/split-access/transactions", { id: "access-txn", merchant_name: "Store", paid_amount: 100, occurred_at: "2026-07-12" });
  await request(db, "POST", "/api/transactions/access-txn/items", { id: "access-item", name: "Item", amount: 100 });
  await request(db, "PUT", "/api/items/access-item/allocations", { allocations: [{ id: "access-allocation", project_member_id: "linked-member", allocated_amount: 100 }] });
  const generated = db.database.prepare("SELECT id,paid_amount,status FROM transactions WHERE project_id='allowed-home' AND origin_transaction_id='access-txn'").get();
  assert.equal(generated.paid_amount, 100);

  db.database.prepare("UPDATE project_user_roles SET revoked_at=? WHERE project_id='allowed-home' AND user_id='test-user'").run(now);
  const updated = await request(db, "PUT", "/api/items/access-item/allocations", { allocations: [{ id: "access-allocation", project_member_id: "linked-member", allocated_amount: 40 }] });
  assert.equal(updated.response.status, 200);
  const afterUpdate = db.database.prepare("SELECT paid_amount,status FROM transactions WHERE id=?").get(generated.id);
  assert.deepEqual({ ...afterUpdate }, { paid_amount: 100, status: "provisional" });
  const removed = await request(db, "DELETE", "/api/transactions/access-txn");
  assert.equal(removed.response.status, 200);
  const afterDelete = db.database.prepare("SELECT paid_amount,status FROM transactions WHERE id=?").get(generated.id);
  assert.deepEqual({ ...afterDelete }, { paid_amount: 100, status: "provisional" });
});

test("Google login state is claimed once before mock profile handling", async (t) => {
  const db = new D1Database();
  t.after(() => db.close());
  const env = { GOOGLE_CLIENT_ID: "client", OAUTH_MOCK_USER_JSON: JSON.stringify({ sub: "sub", email: "user@example.test" }) };
  const started = await createGoogleStart(db, env, new Request("https://example.test/api/auth/google/start"));
  const state = new URL(started.url).searchParams.get("state");
  const cookie = started.cookie.split(";", 1)[0];
  const callback = () => finishGoogleCallback(db, env, new Request(`https://example.test/api/auth/google/callback?state=${encodeURIComponent(state)}&code=code`, { headers: { cookie } }));
  const results = await Promise.allSettled([callback(), callback()]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected" && result.reason?.code === "invalid_oauth_state").length, 1);
});

test("account deletion can retry revocation and leaves no connection ciphertext", async (t) => {
  const db = new D1Database();
  t.after(() => db.close());
  await testSession(db);
  const key = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
  const encrypted = await encryptRefreshToken({ GMAIL_TOKEN_KEY_CURRENT_GENERATION: "1", GMAIL_TOKEN_KEY_V1: key }, "delete-connection", "test-user", "refresh-token");
  const now = "2026-07-12T00:00:00.000Z";
  db.database.prepare(`INSERT INTO gmail_connections (id,user_id,gmail_email,refresh_token_ciphertext,refresh_token_iv,key_generation,aad_version,status,created_at,updated_at)
    VALUES (?,?,?,?,?,?,1,'active',?,?)`).run("delete-connection", "test-user", "mail@example.test", encrypted.ciphertext, encrypted.iv, encrypted.key_generation, now, now);
  let revokeAttempts = 0;
  const env = { GMAIL_TOKEN_KEY_CURRENT_GENERATION: "1", GMAIL_TOKEN_KEY_V1: key, GMAIL_FETCH: async () => {
    revokeAttempts += 1;
    return revokeAttempts === 1 ? Response.json({ error: "server_error" }, { status: 500 }) : new Response(null, { status: 200 });
  } };
  const failed = await request(db, "DELETE", "/api/account", undefined, env);
  assert.equal(failed.response.status, 502);
  const started = db.database.prepare("SELECT deletion_started_at,deleted_at FROM users WHERE id='test-user'").get();
  assert.equal(typeof started.deletion_started_at, "string");
  assert.equal(started.deleted_at, null);
  assert.notEqual(db.database.prepare("SELECT refresh_token_ciphertext FROM gmail_connections WHERE id='delete-connection'").get().refresh_token_ciphertext, "");
  assert.equal((await request(db, "GET", "/api/projects", undefined, env)).response.status, 401);
  await assert.rejects(() => ensureUser(db, { sub: "google-sub-test", email: "test@example.test" }), /account_unavailable/);
  await assert.rejects(() => createSession(db, "test-user"), /account_unavailable/);

  const retried = await request(db, "DELETE", "/api/account", undefined, env);
  assert.equal(retried.response.status, 200);
  assert.equal(revokeAttempts, 2);
  const completed = db.database.prepare("SELECT deleted_at FROM users WHERE id='test-user'").get();
  assert.equal(typeof completed.deleted_at, "string");
  const connection = db.database.prepare("SELECT refresh_token_ciphertext,refresh_token_iv,status FROM gmail_connections WHERE id='delete-connection'").get();
  assert.deepEqual({ ...connection }, { refresh_token_ciphertext: "", refresh_token_iv: "", status: "disconnected" });
});

test("row CRUD stays project-scoped and household records follow finalize and reopen", async (t) => {
  const db = new D1Database();
  t.after(() => db.close());

  await createProject(db, { id: "home", name: "家計", project_type: "household" });
  await createProject(db, { id: "trip", name: "旅行", project_type: "split" });
  await createProject(db, { id: "other", name: "別件", project_type: "split" });

  const memberA = await request(db, "POST", "/api/projects/trip/members", { id: "member-a", display_name: "A", role: "owner" });
  const memberB = await request(db, "POST", "/api/projects/trip/members", { id: "member-b", display_name: "B" });
  assert.equal(memberA.response.status, 201);
  assert.equal(memberB.response.status, 201);

  const wrongScope = await request(db, "PATCH", "/api/projects/other/members/member-a", { display_name: "別人" });
  assert.equal(wrongScope.response.status, 404);

  const link = await request(db, "PATCH", "/api/project-members/member-a/household-link", { action: "link", household_project_id: "home" });
  assert.equal(link.response.status, 200);
  assert.equal(link.body.project_member.linked_household_project_id, "home");

  const transaction = await request(db, "POST", "/api/projects/trip/transactions", {
    id: "transaction-1",
    merchant_name: "食料品店",
    gross_amount: 1200,
    paid_amount: 1200,
    occurred_at: "2026-07-10T12:00:00+09:00",
    status: "confirmed",
  });
  assert.equal(transaction.response.status, 201);

  const payment = await request(db, "POST", "/api/transactions/transaction-1/payments", {
    id: "payment-1",
    payer_member_id: "member-a",
    amount: 1200,
    payment_method: "cash",
  });
  assert.equal(payment.response.status, 201);

  const item = await request(db, "POST", "/api/transactions/transaction-1/items", {
    id: "item-1",
    name: "食材",
    amount: 1200,
  });
  assert.equal(item.response.status, 201);

  const allocations = await request(db, "PUT", "/api/items/item-1/allocations", {
    allocations: [
      { id: "allocation-a", project_member_id: "member-a", allocated_amount: 700 },
      { id: "allocation-b", project_member_id: "member-b", allocated_amount: 500 },
    ],
  });
  assert.equal(allocations.response.status, 200);
  assert.equal(allocations.body.item_allocations.length, 2);

  const transactionGraph = await request(db, "GET", "/api/transactions/transaction-1");
  assert.equal(transactionGraph.response.status, 200);
  assert.equal(transactionGraph.body.transactions.length, 1);
  assert.equal(transactionGraph.body.transaction_payments.length, 1);
  assert.equal(transactionGraph.body.transaction_items.length, 1);
  assert.equal(transactionGraph.body.item_allocations.length, 2);

  const filtered = await request(db, "GET", "/api/projects/trip/transactions?status=confirmed&member_id=member-a&limit=1");
  assert.equal(filtered.response.status, 200);
  assert.equal(filtered.body.total, 1);
  assert.equal(filtered.body.next_cursor, null);

  const patchPayment = await request(db, "PATCH", "/api/payments/payment-1", { payment_method: "credit_card", provider: "発行会社" });
  assert.equal(patchPayment.response.status, 200);
  assert.equal(patchPayment.body.transaction_payment.payment_method, "credit_card");

  const patchItem = await request(db, "PATCH", "/api/transaction-items/item-1", { category: "食費" });
  assert.equal(patchItem.response.status, 200);
  assert.equal(patchItem.body.transaction_item.category, "食費");

  const patchTransaction = await request(db, "PATCH", "/api/transactions/transaction-1", { note: "夕食" });
  assert.equal(patchTransaction.response.status, 200);
  assert.equal(patchTransaction.body.transaction.note, "夕食");

  const householdBeforeFinalize = await request(db, "GET", "/api/projects/home");
  const generatedBeforeFinalize = householdBeforeFinalize.body.transactions.find((row) => row.origin_transaction_id === "transaction-1");
  assert.equal(generatedBeforeFinalize.status, "provisional");
  assert.equal(generatedBeforeFinalize.paid_amount, 700);

  const finalize = await request(db, "POST", "/api/projects/trip/finalize");
  assert.equal(finalize.response.status, 200);
  assert.equal(finalize.body.validation.valid, true);
  assert.equal(finalize.body.project.finalized_at !== null, true);

  const householdAfterFinalize = await request(db, "GET", "/api/projects/home");
  const generatedAfterFinalize = householdAfterFinalize.body.transactions.find((row) => row.origin_transaction_id === "transaction-1");
  assert.equal(generatedAfterFinalize.status, "confirmed");

  const blockedEdit = await request(db, "PATCH", "/api/transactions/transaction-1", { note: "変更" });
  assert.equal(blockedEdit.response.status, 409);
  assert.deepEqual(blockedEdit.body, { error: "project_finalized" });

  const reopen = await request(db, "POST", "/api/projects/trip/reopen");
  assert.equal(reopen.response.status, 200);
  assert.equal(reopen.body.project.finalized_at, null);

  const householdAfterReopen = await request(db, "GET", "/api/projects/home");
  const generatedAfterReopen = householdAfterReopen.body.transactions.find((row) => row.origin_transaction_id === "transaction-1");
  assert.equal(generatedAfterReopen.status, "provisional");
  assert.equal(generatedAfterReopen.paid_amount, 700);

  const settlementRecord = await request(db, "POST", "/api/projects/trip/transactions", {
    id: "settlement-1",
    merchant_name: "精算送金",
    gross_amount: 500,
    paid_amount: 500,
    occurred_at: "2026-07-11T12:00:00+09:00",
    status: "confirmed",
    entry_type: "settlement_out",
  });
  assert.equal(settlementRecord.response.status, 201);

  const summaries = await request(db, "GET", "/api/projects/trip/summaries");
  assert.equal(summaries.response.status, 200);
  assert.equal(summaries.body.summary.transaction_count, 1);
  assert.equal(summaries.body.summary.confirmed_total, 1200);
  assert.deepEqual(summaries.body.by_payment_method, [{ payment_method: "credit_card", transaction_count: 1, total_amount: 1200 }]);
  assert.equal(summaries.body.member_balances.length, 2);

  const removed = await request(db, "DELETE", "/api/projects/trip");
  assert.equal(removed.response.status, 200);

  const householdAfterDelete = await request(db, "GET", "/api/projects/home");
  const generatedAfterDelete = householdAfterDelete.body.transactions.find((row) => row.generated_automatically === 1);
  assert.equal(generatedAfterDelete.status, "cancelled");
  assert.equal(generatedAfterDelete.paid_amount, 0);
  assert.equal(generatedAfterDelete.origin_project_id, null);
});

test("referenced members are deactivated while unreferenced members are removed", async (t) => {
  const db = new D1Database();
  t.after(() => db.close());

  await createProject(db, { id: "split", name: "精算", project_type: "split" });
  await request(db, "POST", "/api/projects/split/members", { id: "used", display_name: "使用中" });
  await request(db, "POST", "/api/projects/split/members", { id: "unused", display_name: "未使用" });
  await request(db, "POST", "/api/projects/split/transactions", {
    id: "txn",
    merchant_name: "店",
    paid_amount: 100,
    occurred_at: "2026-07-01",
  });
  await request(db, "POST", "/api/transactions/txn/payments", { id: "pay", payer_member_id: "used", amount: 100 });

  const usedDelete = await request(db, "DELETE", "/api/project-members/used");
  assert.equal(usedDelete.response.status, 200);
  assert.equal(usedDelete.body.deactivated, true);

  const unusedDelete = await request(db, "DELETE", "/api/project-members/unused");
  assert.equal(unusedDelete.response.status, 200);
  assert.equal(unusedDelete.body.deactivated, false);

  const members = await request(db, "GET", "/api/projects/split/members?include_inactive=true");
  assert.equal(members.body.project_members.length, 1);
  assert.equal(members.body.project_members[0].id, "used");
  assert.equal(members.body.project_members[0].is_active, 0);
});

test("receipt, notification, CSV, and reconciliation routes persist scoped imports", async (t) => {
  const db = new D1Database();
  t.after(() => db.close());

  await createProject(db, { id: "ledger", name: "家計簿", project_type: "household" });

  const receipt = await request(db, "POST", "/api/projects/ledger/imports/receipt", {
    source_record_id: "receipt-1",
    merchant_name: "青果店",
    paid_amount: 500,
    occurred_at: "2026-07-01T10:00:00+09:00",
    confidence: 0.9,
  });
  assert.equal(receipt.response.status, 201);
  assert.equal(receipt.body.import.source_type, "receipt");

  const notification = await request(db, "POST", "/api/projects/ledger/imports/notification", {
    message_id: "message-1",
    merchant_name: "通知店舗",
    paid_amount: 650,
    occurred_at: "2026-07-02T11:00:00+09:00",
    provider: "mail",
  });
  assert.equal(notification.response.status, 201);
  assert.equal(notification.body.import.source_type, "gmail_notification");

  const csv = await request(db, "POST", "/api/projects/ledger/imports/csv", {
    profile: "card",
    csv: "merchant,amount,date\n書店,800,2026-07-03",
  });
  assert.equal(csv.response.status, 201);
  assert.equal(csv.body.processed, 1);

  const imports = await request(db, "GET", "/api/projects/ledger/imports?limit=10");
  assert.equal(imports.response.status, 200);
  assert.equal(imports.body.imports.length, 3);

  const reconciled = await request(db, "POST", `/api/imports/${receipt.body.import.id}/reconcile`, { action: "unlink" });
  assert.equal(reconciled.response.status, 200);
  assert.equal(reconciled.body.import.source_status, "parsed");
  assert.equal(reconciled.body.import.transaction_id, null);

  const invalidImport = await request(db, "POST", "/api/projects/ledger/imports/receipt", {
    merchant_name: "店",
    paid_amount: 1.5,
    occurred_at: "2026-07-01",
  });
  assert.equal(invalidImport.response.status, 400);
  assert.equal(invalidImport.body.error, "invalid_integer");
});

test("method, field, integer, scope, and OCR errors expose restrained responses", async (t) => {
  const db = new D1Database();
  t.after(() => db.close());

  await createProject(db, { id: "one", name: "一", project_type: "split" });
  await createProject(db, { id: "two", name: "二", project_type: "split" });

  const wrongMethod = await request(db, "PUT", "/api/projects", {});
  assert.equal(wrongMethod.response.status, 405);
  assert.equal(wrongMethod.response.headers.get("allow"), "GET, POST");
  assert.deepEqual(wrongMethod.body, { error: "method_not_allowed" });

  const unknown = await request(db, "GET", "/api/unknown");
  assert.equal(unknown.response.status, 404);
  assert.deepEqual(unknown.body, { error: "not_found" });

  const invalidTransaction = await request(db, "POST", "/api/projects/one/transactions", {
    merchant_name: "店",
    paid_amount: 10.5,
    occurred_at: "2026-07-01",
  });
  assert.equal(invalidTransaction.response.status, 400);
  assert.deepEqual(invalidTransaction.body, { error: "invalid_integer", field: "paid_amount" });

  await request(db, "POST", "/api/projects/one/transactions", {
    id: "scoped",
    merchant_name: "店",
    paid_amount: 10,
    occurred_at: "2026-07-01",
  });
  const wrongProject = await request(db, "GET", "/api/projects/two/transactions/scoped");
  assert.equal(wrongProject.response.status, 404);
  assert.equal(Object.hasOwn(wrongProject.body, "message"), false);

  const unauthenticatedOcr = await request(db, "POST", "/api/ocr-receipt", { project_id: "one", image_data_url: "data:image/png;base64,AA==" }, { auth: false });
  assert.equal(unauthenticatedOcr.response.status, 401);
  assert.deepEqual(unauthenticatedOcr.body, { error: "authentication_required" });

  const missingProject = await request(db, "POST", "/api/ocr-receipt", { image_data_url: "data:image/png;base64,AA==" });
  assert.equal(missingProject.response.status, 400);
  assert.deepEqual(missingProject.body, { error: "missing_field", field: "project_id" });

  const invalidMime = await request(db, "POST", "/api/ocr-receipt", { project_id: "one", image_data_url: "data:text/plain;base64,QQ==" });
  assert.equal(invalidMime.response.status, 415);
  assert.deepEqual(invalidMime.body, { error: "unsupported_image_type" });

  const invalidBase64 = await request(db, "POST", "/api/ocr-receipt", { project_id: "one", image_data_url: "data:image/png;base64,***" });
  assert.equal(invalidBase64.response.status, 400);
  assert.deepEqual(invalidBase64.body, { error: "invalid_image" });

  const largeImage = Buffer.alloc(1025, 1).toString("base64");
  const tooLarge = await request(db, "POST", "/api/ocr-receipt", { project_id: "one", image_data_url: `data:image/png;base64,${largeImage}` }, { OCR_MAX_IMAGE_BYTES: "1024" });
  assert.equal(tooLarge.response.status, 413);
  assert.deepEqual(tooLarge.body, { error: "image_too_large", max_bytes: 1024 });

  const editorShare = await request(db, "POST", "/api/projects/one/share", { role: "editor" });
  assert.equal(editorShare.response.status, 200);
  const sharedEditorOcr = await request(db, "POST", "/api/ocr-receipt", {
    project_id: "one",
    share_token: editorShare.body.token,
    image_data_url: "data:image/png;base64,AA==",
  }, { auth: false, OCR_BACKEND: "openai" });
  assert.equal(sharedEditorOcr.response.status, 503);
  assert.deepEqual(sharedEditorOcr.body, { error: "missing_api_key" });

  const viewerShare = await request(db, "POST", "/api/projects/one/share", { role: "viewer" });
  assert.equal(viewerShare.response.status, 200);
  const sharedViewerOcr = await request(db, "POST", "/api/ocr-receipt", {
    project_id: "one",
    share_token: viewerShare.body.token,
    image_data_url: "data:image/png;base64,AA==",
  }, { auth: false, OCR_BACKEND: "openai" });
  assert.equal(sharedViewerOcr.response.status, 404);
  assert.deepEqual(sharedViewerOcr.body, { error: "not_found" });

  const noKey = await request(db, "POST", "/api/ocr-receipt", { project_id: "one", image_data_url: "data:image/png;base64,AA==" }, { OCR_BACKEND: "openai" });
  assert.equal(noKey.response.status, 503);
  assert.deepEqual(noKey.body, { error: "missing_api_key" });
});

test("OCR upstream failures are restrained and time out", async (t) => {
  const db = new D1Database();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    db.close();
  });
  await createProject(db, { id: "ocr-ledger", name: "OCR", project_type: "household" });

  globalThis.fetch = async () => new Response(JSON.stringify({ error: "private_error", message: "secret value" }), { status: 401 });
  const upstreamFailure = await request(db, "POST", "/api/ocr-receipt", { project_id: "ocr-ledger", image_data_url: "data:image/png;base64,AA==" }, {
    OCR_BACKEND: "remote",
    RECEIPT_OCR_API_URL: "https://ocr.example.test",
  });
  assert.equal(upstreamFailure.response.status, 502);
  assert.deepEqual(upstreamFailure.body, { error: "remote_ocr_error" });

  globalThis.fetch = async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  });
  const timedOut = await request(db, "POST", "/api/ocr-receipt", { project_id: "ocr-ledger", image_data_url: "data:image/png;base64,AA==" }, {
    OCR_BACKEND: "remote",
    RECEIPT_OCR_API_URL: "https://ocr.example.test",
    OCR_TIMEOUT_MS: "100",
  });
  assert.equal(timedOut.response.status, 504);
  assert.deepEqual(timedOut.body, { error: "ocr_timeout" });
});
