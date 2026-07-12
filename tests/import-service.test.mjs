import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  createCsvImports,
  createNotificationImport,
  createReceiptImport,
  findCandidates,
  listImports,
  reconcileImport,
} from "../functions/lib/imports.js";

const schemaSql = readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8");

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
    return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
  }
}

class FakeD1 {
  constructor(database) {
    this.database = database;
  }

  prepare(sql) {
    return new D1Statement(this.database, sql);
  }

  async batch(statements) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

function openDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec(schemaSql);
  const now = "2026-07-01T00:00:00.000Z";
  database.prepare(`
    INSERT INTO projects (
      id, name, project_type, currency, share_role, created_at, updated_at
    ) VALUES (?, ?, 'household', 'JPY', 'editor', ?, ?)
  `).run("project-a", "Household", now, now);
  database.prepare(`
    INSERT INTO project_members (
      id, project_id, display_name, role, is_active, created_at, updated_at
    ) VALUES (?, 'project-a', ?, 'member', 1, ?, ?)
  `).run("member-a", "A", now, now);
  database.prepare(`
    INSERT INTO project_members (
      id, project_id, display_name, role, is_active, created_at, updated_at
    ) VALUES (?, 'project-a', ?, 'member', 1, ?, ?)
  `).run("member-b", "B", now, now);
  return { database, db: new FakeD1(database) };
}

function operationOptions() {
  let sequence = 0;
  return {
    now: "2026-07-11T00:00:00.000Z",
    idFactory(kind) {
      sequence += 1;
      return `${kind}:${sequence}`;
    },
  };
}

function scalar(database, sql, ...bindings) {
  return database.prepare(sql).get(...bindings).value;
}

function insertTransaction(database, id, values = {}) {
  const now = values.created_at ?? "2026-07-01T00:00:00.000Z";
  database.prepare(`
    INSERT INTO transactions (
      id, project_id, merchant_name, merchant_normalized, gross_amount, paid_amount,
      discount_amount, point_amount, category, status, occurred_at, settled_at,
      entry_type, generated_automatically, created_at, updated_at
    ) VALUES (?, 'project-a', ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, 'purchase', 0, ?, ?)
  `).run(
    id,
    values.merchant_name ?? "LAWSON",
    values.merchant_normalized ?? "ローソン",
    values.gross_amount ?? values.paid_amount ?? 800,
    values.paid_amount ?? 800,
    values.category ?? null,
    values.status ?? "confirmed",
    values.occurred_at ?? "2026-07-10T12:00:00+09:00",
    values.settled_at ?? null,
    now,
    now,
  );
}

test("レシート取込から取引、集計明細、均等配分、支払を作成する", async (t) => {
  const { database, db } = openDatabase();
  t.after(() => database.close());
  const result = await createReceiptImport(db, "project-a", {
    receipt_id: "receipt-1",
    merchant_name: "ローソン",
    total_amount: 1001,
    occurred_at: "2026-07-10T12:00:00+09:00",
    payment_method: "現金",
    payer_member_id: "member-a",
    raw_payload: {
      api_key: "secret-value",
      card_number: "4111111111111111",
      memo: "audit",
    },
  }, operationOptions());

  assert.equal(result.action, "create");
  assert.equal(result.source_status, "linked");
  assert.equal(result.transaction.status, "provisional");
  assert.equal(scalar(database, "SELECT COUNT(*) AS value FROM transactions"), 1);
  const item = database.prepare("SELECT * FROM transaction_items WHERE transaction_id = ?").get(result.transaction.id);
  assert.equal(item.item_type, "summary");
  assert.equal(item.amount, 1001);
  assert.deepEqual(
    database.prepare("SELECT allocated_amount FROM item_allocations WHERE transaction_item_id = ? ORDER BY project_member_id").all(item.id).map((row) => row.allocated_amount),
    [501, 500],
  );
  const payment = database.prepare("SELECT * FROM transaction_payments WHERE transaction_id = ?").get(result.transaction.id);
  assert.equal(payment.payer_member_id, "member-a");
  assert.equal(payment.amount, 1001);
  assert.equal(payment.payment_method, "cash");
  assert.equal(payment.payment_status, "provisional");
  const audit = JSON.parse(result.raw_payload);
  assert.equal(audit.api_key, "[REDACTED]");
  assert.equal(audit.card_number.endsWith("1111"), true);
  assert.equal(audit.memo, "audit");
  assert.equal((await listImports(db, "project-a")).length, 1);
});

test("CSVを既存取引へ接続し、同一行の再取込を重複件数へ加える", async (t) => {
  const { database, db } = openDatabase();
  t.after(() => database.close());
  const options = operationOptions();
  const receipt = await createReceiptImport(db, "project-a", {
    merchant_name: "ローソン",
    paid_amount: 780,
    occurred_at: "2026-07-10T12:00:00+09:00",
    payment_method: "cash",
    external_transaction_id: "card-001",
  }, options);
  const csv = "利用日,利用店名,利用金額,取引番号\r\n2026/07/10 12:20,LAWSON,800,card-001";
  const first = await createCsvImports(db, "project-a", csv, "card", options);

  assert.equal(first.inserted, 1);
  assert.equal(first.duplicates, 0);
  assert.equal(first.results[0].action, "link");
  assert.equal(first.results[0].transaction.id, receipt.transaction.id);
  assert.equal(first.results[0].source_status, "linked");
  assert.equal(scalar(database, "SELECT COUNT(*) AS value FROM transactions"), 1);
  assert.equal(scalar(database, "SELECT COUNT(*) AS value FROM import_records WHERE transaction_id = ?", receipt.transaction.id), 2);
  const resolved = database.prepare("SELECT status, merchant_name, paid_amount FROM transactions WHERE id = ?").get(receipt.transaction.id);
  assert.equal(resolved.status, "confirmed");
  assert.equal(resolved.merchant_name, "ローソン");
  assert.equal(resolved.paid_amount, 800);
  const summary = database.prepare("SELECT id, amount FROM transaction_items WHERE transaction_id = ?").get(receipt.transaction.id);
  assert.equal(summary.amount, 800);
  assert.deepEqual(
    database.prepare("SELECT allocated_amount FROM item_allocations WHERE transaction_item_id = ? ORDER BY project_member_id").all(summary.id).map((row) => row.allocated_amount),
    [400, 400],
  );
  const payment = database.prepare("SELECT payment_method, payment_status FROM transaction_payments WHERE transaction_id = ?").get(receipt.transaction.id);
  assert.deepEqual({ ...payment }, { payment_method: "credit_card", payment_status: "confirmed" });

  const duplicate = await createCsvImports(db, "project-a", csv, "card", options);
  assert.equal(duplicate.inserted, 0);
  assert.equal(duplicate.duplicates, 1);
  assert.equal(duplicate.results[0].action, "duplicate");
  assert.equal(scalar(database, "SELECT COUNT(*) AS value FROM import_records"), 2);
});

test("通知取込は確定済みの取引値と支払値を変更しない", async (t) => {
  const { database, db } = openDatabase();
  t.after(() => database.close());
  insertTransaction(database, "confirmed-transaction", {
    merchant_name: "LAWSON",
    merchant_normalized: "ローソン",
    paid_amount: 800,
    category: "food",
    occurred_at: "2026-07-10T12:00:00+09:00",
    settled_at: "2026-07-11",
  });
  database.prepare(`
    INSERT INTO transaction_payments (
      id, transaction_id, payer_member_id, amount, payment_method, payment_status,
      occurred_at, created_at, updated_at
    ) VALUES ('manual-payment', 'confirmed-transaction', 'member-a', 800, 'credit_card', 'confirmed', ?, ?, ?)
  `).run("2026-07-10T12:00:00+09:00", "2026-07-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z");

  const result = await createNotificationImport(db, "project-a", {
    message_id: "message-1",
    merchant_name: "ローソン",
    paid_amount: 800,
    occurred_at: "2026-07-10T12:20:00+09:00",
    settled_at: "2026-07-12",
    category: "other",
    payment_method: "paypay",
  }, operationOptions());

  assert.equal(result.action, "link");
  assert.equal(result.transaction.id, "confirmed-transaction");
  assert.deepEqual(
    { ...database.prepare("SELECT merchant_name, paid_amount, category, status, occurred_at, settled_at FROM transactions WHERE id = 'confirmed-transaction'").get() },
    {
      merchant_name: "LAWSON",
      paid_amount: 800,
      category: "food",
      status: "confirmed",
      occurred_at: "2026-07-10T12:00:00+09:00",
      settled_at: "2026-07-11",
    },
  );
  assert.deepEqual(
    { ...database.prepare("SELECT amount, payment_method, payment_status FROM transaction_payments WHERE id = 'manual-payment'").get() },
    { amount: 800, payment_method: "credit_card", payment_status: "confirmed" },
  );
});

test("同点候補を確認待ちにし、接続、解除、作成、却下を反映する", async (t) => {
  const { database, db } = openDatabase();
  t.after(() => database.close());
  insertTransaction(database, "candidate-a");
  insertTransaction(database, "candidate-b");
  const options = operationOptions();
  const pending = await createReceiptImport(db, "project-a", {
    merchant_name: "ローソン",
    paid_amount: 800,
    occurred_at: "2026-07-10T12:10:00+09:00",
  }, options);

  assert.equal(pending.action, "review");
  assert.equal(pending.source_status, "review");
  assert.equal(pending.transaction_id, null);
  const linked = await reconcileImport(db, pending.id, "link", { ...options, transaction_id: "candidate-a" });
  assert.equal(linked.source_status, "linked");
  assert.equal(linked.transaction_id, "candidate-a");
  const unlinked = await reconcileImport(db, pending.id, "unlink", options);
  assert.equal(unlinked.source_status, "parsed");
  assert.equal(unlinked.transaction_id, null);
  const created = await reconcileImport(db, pending.id, "create", options);
  assert.equal(created.source_status, "linked");
  assert.notEqual(created.transaction.id, "candidate-a");
  assert.equal(scalar(database, "SELECT COUNT(*) AS value FROM transactions"), 3);
  const rejected = await reconcileImport(db, pending.id, "reject", options);
  assert.equal(rejected.source_status, "rejected");
  assert.equal(rejected.transaction_id, null);
  assert.equal(scalar(database, "SELECT COUNT(*) AS value FROM transactions"), 3);
});

test("候補を50件、CSV処理を指定行数で打ち切る", async (t) => {
  const { database, db } = openDatabase();
  t.after(() => database.close());
  for (let index = 0; index < 55; index += 1) {
    insertTransaction(database, `candidate-${String(index).padStart(2, "0")}`, {
      merchant_name: `Store ${index}`,
      merchant_normalized: `store${index}`,
      paid_amount: 500,
      occurred_at: "2026-07-10T12:00:00+09:00",
    });
  }
  const classification = await findCandidates(db, "project-a", {
    source_type: "receipt",
    merchant_raw: "Store 1",
    paid_amount_raw: 500,
    occurred_at_raw: "2026-07-10T12:00:00+09:00",
  });
  assert.equal(classification.candidates.length, 50);

  const csv = [
    "date,merchant,amount",
    "2026-07-20,Alpha,101",
    "2026-07-21,Beta,102",
    "2026-07-22,Gamma,103",
  ].join("\n");
  const imported = await createCsvImports(db, "project-a", {
    csv_text: csv,
    profile: "card",
    max_rows: 2,
  }, operationOptions());
  assert.equal(imported.total_rows, 3);
  assert.equal(imported.processed, 2);
  assert.equal(imported.truncated, 1);
});
