import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  calculateMemberBurden,
  cancelGeneratedForSource,
  cancelGeneratedHouseholdTransaction,
  syncSplitProjectToHouseholds,
  syncSplitTransactionToHouseholds,
  upsertGeneratedHouseholdTransaction,
  validateSplitProject,
} from "../functions/lib/household.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schemaSql = readFileSync(path.join(repositoryRoot, "db", "schema.sql"), "utf8");
const now = "2026-07-11T00:00:00.000Z";

class D1Statement {
  constructor(database, sql, values = []) {
    this.database = database;
    this.sql = sql;
    this.values = values;
  }

  bind(...values) {
    return new D1Statement(this.database, this.sql, values);
  }

  all() {
    return { results: this.database.prepare(this.sql).all(...this.values) };
  }

  first() {
    return this.database.prepare(this.sql).get(...this.values) ?? null;
  }

  run() {
    return this.runSync();
  }

  runSync() {
    const result = this.database.prepare(this.sql).run(...this.values);
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
  constructor(database) {
    this.database = database;
  }

  prepare(sql) {
    return new D1Statement(this.database, sql);
  }

  batch(statements) {
    if (this.beforeBatch) {
      const callback = this.beforeBatch;
      this.beforeBatch = undefined;
      callback();
    }
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement, index) => {
        if (this.failBatchAt === index) throw new Error("injected_batch_failure");
        return statement.runSync();
      });
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    } finally {
      this.failBatchAt = undefined;
    }
  }
}

function insertProject(database, id, name, projectType, finalizedAt = null) {
  database.prepare(
    `INSERT INTO projects (
       id, name, project_type, currency, share_token, share_role, share_expires_at,
       finalized_at, created_at, updated_at
     ) VALUES (?, ?, ?, 'JPY', NULL, 'editor', NULL, ?, ?, ?)`,
  ).run(id, name, projectType, finalizedAt, now, now);
}

function insertMember(database, id, projectId, displayName, role, householdProjectId = null) {
  database.prepare(
    `INSERT INTO project_members (
       id, project_id, display_name, role, is_active, linked_household_project_id,
       linked_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)`,
  ).run(id, projectId, displayName, role, householdProjectId, householdProjectId ? now : null, now, now);
}

function createFixture() {
  const database = new DatabaseSync(":memory:");
  database.exec(schemaSql);
  insertProject(database, "split", "Trip", "split");
  for (const suffix of ["a", "b", "c", "d"]) {
    insertProject(database, `house-${suffix}`, `House ${suffix.toUpperCase()}`, "household");
    insertMember(database, `owner-${suffix}`, `house-${suffix}`, `Owner ${suffix.toUpperCase()}`, "owner");
  }
  insertMember(database, "A", "split", "A", "member", "house-a");
  insertMember(database, "B", "split", "B", "member", "house-b");
  insertMember(database, "C", "split", "C", "member", "house-c");
  insertMember(database, "D", "split", "D", "member");
  database.prepare(
    `INSERT INTO transactions (
       id, project_id, merchant_name, merchant_normalized, gross_amount, paid_amount,
       discount_amount, point_amount, category, status, occurred_at, settled_at, note,
       entry_type, origin_project_id, origin_transaction_id, origin_member_id,
       generated_automatically, created_at, updated_at
     ) VALUES (
       'tx-source', 'split', 'Market and Taxi', 'market and taxi', 100, 100,
       0, 0, 'trip', 'confirmed', '2026-07-10T12:00:00+09:00', NULL, 'Source note',
       'purchase', NULL, NULL, NULL, 0, ?, ?
     )`,
  ).run(now, now);
  database.prepare(
    `INSERT INTO transaction_payments (
       id, transaction_id, payer_member_id, amount, payment_method, provider, account_label,
       external_payment_id, payment_status, occurred_at, created_at, updated_at
     ) VALUES (
       'payment-source', 'tx-source', 'A', 100, 'credit_card', NULL, NULL,
       NULL, 'confirmed', '2026-07-10T12:00:00+09:00', ?, ?
     )`,
  ).run(now, now);
  database.prepare(
    `INSERT INTO transaction_items (
       id, transaction_id, name, amount, quantity, item_type, category, sort_order,
       is_hidden, created_at, updated_at
     ) VALUES (?, 'tx-source', ?, ?, 1, 'product', ?, ?, 0, ?, ?)`,
  ).run("item-food", "Food", 60, "food", 0, now, now);
  database.prepare(
    `INSERT INTO transaction_items (
       id, transaction_id, name, amount, quantity, item_type, category, sort_order,
       is_hidden, created_at, updated_at
     ) VALUES (?, 'tx-source', ?, ?, 1, 'product', ?, ?, 0, ?, ?)`,
  ).run("item-travel", "Taxi", 40, "travel", 1, now, now);
  const allocations = [
    ["item-food", "A", 30],
    ["item-food", "B", 20],
    ["item-food", "C", 10],
    ["item-food", "D", 0],
    ["item-travel", "A", 0],
    ["item-travel", "B", 10],
    ["item-travel", "C", 10],
    ["item-travel", "D", 20],
  ];
  for (const [itemId, memberId, amount] of allocations) {
    database.prepare(
      `INSERT INTO item_allocations (
         id, transaction_item_id, project_member_id, allocated_amount, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(`allocation-${itemId}-${memberId}`, itemId, memberId, amount, now, now);
  }
  return { database, db: new D1Database(database) };
}

function grantFixtureAccess(database) {
  database.prepare(
    "INSERT INTO users (id, google_sub, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run("sync-user", "sync-sub", "sync@example.test", now, now);
  for (const projectId of ["split", "house-a", "house-b", "house-c", "house-d"]) {
    database.prepare(
      `INSERT INTO project_user_roles (project_id, user_id, role, created_at, updated_at)
       VALUES (?, 'sync-user', 'owner', ?, ?)`,
    ).run(projectId, now, now);
  }
  return { id: "sync-user" };
}

function generatedGraph(database) {
  return {
    transactions: queryAll(database, "SELECT * FROM transactions WHERE generated_automatically = 1 ORDER BY id"),
    payments: queryAll(database, `SELECT payments.* FROM transaction_payments payments
      JOIN transactions ON transactions.id = payments.transaction_id
      WHERE transactions.generated_automatically = 1 ORDER BY payments.id`),
    items: queryAll(database, `SELECT items.* FROM transaction_items items
      JOIN transactions ON transactions.id = items.transaction_id
      WHERE transactions.generated_automatically = 1 ORDER BY items.id`),
    allocations: queryAll(database, `SELECT allocations.* FROM item_allocations allocations
      JOIN transaction_items items ON items.id = allocations.transaction_item_id
      JOIN transactions ON transactions.id = items.transaction_id
      WHERE transactions.generated_automatically = 1 ORDER BY allocations.id`),
  };
}

function queryAll(database, sql, ...values) {
  return database.prepare(sql).all(...values).map((row) => ({ ...row }));
}

function queryOne(database, sql, ...values) {
  const row = database.prepare(sql).get(...values);
  return row ? { ...row } : null;
}

test("explicit allocations determine A, B, C, and D burdens and validation totals", async () => {
  const { database, db } = createFixture();
  try {
    assert.deepEqual(await calculateMemberBurden(db, "tx-source"), { A: 30, B: 30, C: 20, D: 20 });
    assert.equal(await calculateMemberBurden(db, "tx-source", "B"), 30);
    assert.equal((await validateSplitProject(db, "split")).valid, true);

    database.prepare("UPDATE transaction_payments SET amount = 99 WHERE id = 'payment-source'").run();
    database.prepare("UPDATE transaction_items SET amount = 59 WHERE id = 'item-food'").run();
    database.prepare("UPDATE item_allocations SET allocated_amount = 29 WHERE id = 'allocation-item-food-A'").run();
    const invalid = await validateSplitProject(db, "split");
    assert.equal(invalid.valid, false);
    assert.equal(invalid.errors.includes("payment_total_mismatch"), true);
    assert.equal(invalid.errors.includes("item_total_mismatch"), true);
    assert.equal(invalid.errors.includes("allocation_total_mismatch"), true);
  } finally {
    database.close();
  }
});

test("transaction sync creates provisional household rows, remains idempotent, and never chains", async () => {
  const { database, db } = createFixture();
  try {
    const firstSync = await syncSplitTransactionToHouseholds(db, "tx-source", { now });
    assert.equal(firstSync.status, "synced");
    assert.equal(firstSync.upserted.length, 3);
    assert.deepEqual(
      queryAll(
        database,
        `SELECT project_id, origin_member_id, paid_amount, status
         FROM transactions
         WHERE generated_automatically = 1
         ORDER BY origin_member_id`,
      ),
      [
        { project_id: "house-a", origin_member_id: "A", paid_amount: 30, status: "provisional" },
        { project_id: "house-b", origin_member_id: "B", paid_amount: 30, status: "provisional" },
        { project_id: "house-c", origin_member_id: "C", paid_amount: 20, status: "provisional" },
      ],
    );
    assert.equal(
      queryOne(database, "SELECT COUNT(*) AS count FROM transactions WHERE origin_member_id = 'D'").count,
      0,
    );

    const generatedB = queryOne(
      database,
      "SELECT id FROM transactions WHERE generated_automatically = 1 AND origin_member_id = 'B'",
    );
    assert.deepEqual(
      queryAll(
        database,
        "SELECT name, amount, category FROM transaction_items WHERE transaction_id = ? ORDER BY sort_order",
        generatedB.id,
      ),
      [
        { name: "Food", amount: 20, category: "food" },
        { name: "Taxi", amount: 10, category: "travel" },
      ],
    );
    assert.deepEqual(
      queryAll(
        database,
        `SELECT allocations.project_member_id, allocations.allocated_amount, items.amount
         FROM item_allocations allocations
         JOIN transaction_items items ON items.id = allocations.transaction_item_id
         WHERE items.transaction_id = ?
         ORDER BY items.sort_order`,
        generatedB.id,
      ),
      [
        { project_member_id: "owner-b", allocated_amount: 20, amount: 20 },
        { project_member_id: "owner-b", allocated_amount: 10, amount: 10 },
      ],
    );

    const itemIds = queryAll(
      database,
      `SELECT transaction_items.id
       FROM transaction_items
       JOIN transactions ON transactions.id = transaction_items.transaction_id
       WHERE transactions.generated_automatically = 1
       ORDER BY transaction_items.id`,
    );
    const secondSync = await syncSplitTransactionToHouseholds(db, "tx-source", { now });
    assert.equal(secondSync.upserted.every((entry) => entry.action === "updated"), true);
    assert.equal(queryOne(database, "SELECT COUNT(*) AS count FROM transactions WHERE generated_automatically = 1").count, 3);
    assert.deepEqual(
      queryAll(
        database,
        `SELECT transaction_items.id
         FROM transaction_items
         JOIN transactions ON transactions.id = transaction_items.transaction_id
         WHERE transactions.generated_automatically = 1
         ORDER BY transaction_items.id`,
      ),
      itemIds,
    );

    database.prepare("UPDATE transactions SET status = 'corrected' WHERE id = 'tx-source'").run();
    await syncSplitTransactionToHouseholds(db, "tx-source", { now });
    assert.equal(
      queryOne(database, "SELECT COUNT(*) AS count FROM transactions WHERE generated_automatically = 1 AND status = 'cancelled'").count,
      0,
    );

    const generatedA = queryOne(
      database,
      "SELECT id FROM transactions WHERE generated_automatically = 1 AND origin_member_id = 'A'",
    );
    assert.equal((await syncSplitTransactionToHouseholds(db, generatedA.id, { now })).reason, "generated_source");
    assert.equal((await syncSplitProjectToHouseholds(db, "house-a", { now })).reason, "source_project_not_split");
    assert.equal(queryOne(database, "SELECT COUNT(*) AS count FROM transactions WHERE generated_automatically = 1").count, 3);
  } finally {
    database.close();
  }
});

test("updates replace removed items, copy categories, link after finalization, reopen, and cancel deleted sources", async () => {
  const { database, db } = createFixture();
  try {
    await syncSplitProjectToHouseholds(db, "split", { now });
    database.prepare("UPDATE transaction_items SET category = 'transport' WHERE id = 'item-travel'").run();
    await syncSplitProjectToHouseholds(db, "split", { now });
    const generatedB = queryOne(
      database,
      "SELECT id FROM transactions WHERE generated_automatically = 1 AND origin_member_id = 'B'",
    );
    assert.equal(
      queryOne(
        database,
        "SELECT category FROM transaction_items WHERE transaction_id = ? AND name = 'Taxi'",
        generatedB.id,
      ).category,
      "transport",
    );

    database.prepare("DELETE FROM transaction_items WHERE id = 'item-travel'").run();
    database.prepare("UPDATE transactions SET gross_amount = 60, paid_amount = 60 WHERE id = 'tx-source'").run();
    database.prepare("UPDATE transaction_payments SET amount = 60 WHERE id = 'payment-source'").run();
    database.prepare("UPDATE item_allocations SET allocated_amount = 25 WHERE transaction_item_id = 'item-food' AND project_member_id = 'A'").run();
    database.prepare("UPDATE item_allocations SET allocated_amount = 15 WHERE transaction_item_id = 'item-food' AND project_member_id = 'B'").run();
    database.prepare("UPDATE item_allocations SET allocated_amount = 10 WHERE transaction_item_id = 'item-food' AND project_member_id = 'C'").run();
    database.prepare("UPDATE item_allocations SET allocated_amount = 10 WHERE transaction_item_id = 'item-food' AND project_member_id = 'D'").run();
    await syncSplitProjectToHouseholds(db, "split", { now });
    assert.deepEqual(
      queryAll(
        database,
        `SELECT origin_member_id, paid_amount
         FROM transactions
         WHERE generated_automatically = 1 AND status <> 'cancelled'
         ORDER BY origin_member_id`,
      ),
      [
        { origin_member_id: "A", paid_amount: 25 },
        { origin_member_id: "B", paid_amount: 15 },
        { origin_member_id: "C", paid_amount: 10 },
      ],
    );
    assert.equal(queryOne(database, "SELECT COUNT(*) AS count FROM transaction_items WHERE transaction_id = ?", generatedB.id).count, 1);
    assert.equal(queryOne(database, "SELECT name FROM transaction_items WHERE transaction_id = ?", generatedB.id).name, "Food");

    database.prepare("UPDATE projects SET finalized_at = ?, updated_at = ? WHERE id = 'split'").run(now, now);
    database.prepare(
      `UPDATE project_members
       SET linked_household_project_id = 'house-d', linked_at = ?, updated_at = ?
       WHERE id = 'D'`,
    ).run(now, now);
    await syncSplitProjectToHouseholds(db, "split", { now });
    assert.deepEqual(
      queryAll(
        database,
        `SELECT origin_member_id, paid_amount, status
         FROM transactions
         WHERE generated_automatically = 1 AND status <> 'cancelled'
         ORDER BY origin_member_id`,
      ),
      [
        { origin_member_id: "A", paid_amount: 25, status: "confirmed" },
        { origin_member_id: "B", paid_amount: 15, status: "confirmed" },
        { origin_member_id: "C", paid_amount: 10, status: "confirmed" },
        { origin_member_id: "D", paid_amount: 10, status: "confirmed" },
      ],
    );

    database.prepare("UPDATE projects SET finalized_at = NULL, updated_at = ? WHERE id = 'split'").run(now);
    await syncSplitProjectToHouseholds(db, "split", { now });
    assert.equal(
      queryOne(
        database,
        `SELECT COUNT(*) AS count
         FROM transactions
         WHERE generated_automatically = 1 AND status = 'provisional'`,
      ).count,
      4,
    );

    database.prepare("DELETE FROM transactions WHERE id = 'tx-source'").run();
    await syncSplitProjectToHouseholds(db, "split", { now });
    assert.equal(
      queryOne(
        database,
        `SELECT COUNT(*) AS count
         FROM transactions
         WHERE generated_automatically = 1 AND status = 'cancelled' AND paid_amount = 0`,
      ).count,
      4,
    );
    assert.equal(
      queryOne(
        database,
        `SELECT COUNT(*) AS count
         FROM transaction_items items
         JOIN transactions ON transactions.id = items.transaction_id
         WHERE transactions.generated_automatically = 1 AND items.amount <> 0`,
      ).count,
      0,
    );
    for (const householdId of ["house-a", "house-b", "house-c", "house-d"]) {
      assert.equal((await validateSplitProject(db, householdId)).valid, true);
    }
  } finally {
    database.close();
  }
});

test("direct upsert and cancellation helpers reuse the generated transaction", async () => {
  const { database, db } = createFixture();
  try {
    const created = await upsertGeneratedHouseholdTransaction(db, "tx-source", "A", { now });
    assert.equal(created.status, "upserted");
    assert.equal(created.action, "created");
    assert.equal(created.burden, 30);
    assert.equal((await cancelGeneratedHouseholdTransaction(db, created.transaction_id, { now })).status, "cancelled");
    assert.equal(queryOne(database, "SELECT status FROM transactions WHERE id = ?", created.transaction_id).status, "cancelled");

    const restored = await upsertGeneratedHouseholdTransaction(db, "tx-source", "A", { now });
    assert.equal(restored.transaction_id, created.transaction_id);
    assert.equal(restored.action, "updated");
    assert.equal(queryOne(database, "SELECT paid_amount FROM transactions WHERE id = ?", created.transaction_id).paid_amount, 30);

    const cancellation = await cancelGeneratedForSource(db, "split", "tx-source", { now });
    assert.equal(cancellation.count, 1);
    assert.equal(queryOne(database, "SELECT status FROM transactions WHERE id = ?", created.transaction_id).status, "cancelled");
  } finally {
    database.close();
  }
});

test("household synchronization rolls back every target statement when a batch statement fails", async () => {
  const { database, db } = createFixture();
  try {
    await syncSplitTransactionToHouseholds(db, "tx-source", { now });
    const before = queryAll(database, `SELECT id,paid_amount,status,updated_at FROM transactions WHERE generated_automatically=1 ORDER BY id`);
    database.prepare("UPDATE item_allocations SET allocated_amount=allocated_amount+5 WHERE transaction_item_id='item-food'").run();
    db.failBatchAt = 4;
    await assert.rejects(() => syncSplitTransactionToHouseholds(db, "tx-source", { now, validate: false }), /injected_batch_failure/);
    const after = queryAll(database, `SELECT id,paid_amount,status,updated_at FROM transactions WHERE generated_automatically=1 ORDER BY id`);
    assert.deepEqual(after, before);
  } finally {
    database.close();
  }
});

test("target permission guards stop creation, updates, and cancellation after preflight access is revoked", async (t) => {
  for (const action of ["create", "update", "cancel"]) {
    await t.test(action, async () => {
      const { database, db } = createFixture();
      try {
        const user = grantFixtureAccess(database);
        if (action !== "create") await syncSplitTransactionToHouseholds(db, "tx-source", { now, user });
        if (action === "update") {
          database.prepare("UPDATE item_allocations SET allocated_amount = allocated_amount + 5 WHERE transaction_item_id = 'item-food'").run();
        }
        if (action === "cancel") {
          database.prepare("UPDATE transactions SET status = 'cancelled' WHERE id = 'tx-source'").run();
        }
        const before = generatedGraph(database);
        db.beforeBatch = () => database.prepare(
          "UPDATE project_user_roles SET revoked_at = ? WHERE project_id = 'house-b' AND user_id = ?",
        ).run(now, user.id);
        await assert.rejects(
          () => syncSplitTransactionToHouseholds(db, "tx-source", { now, user, validate: false }),
          /household_sync_access_denied/,
        );
        assert.deepEqual(generatedGraph(database), before);
      } finally {
        database.close();
      }
    });
  }
});

test("household synchronization rejects derived writes after account deletion starts", async () => {
  const { database, db } = createFixture();
  try {
    const user = grantFixtureAccess(database);
    const before = generatedGraph(database);
    db.beforeBatch = () => database.prepare("UPDATE users SET deletion_started_at = ? WHERE id = ?").run(now, user.id);
    await assert.rejects(
      () => syncSplitTransactionToHouseholds(db, "tx-source", { now, user, validate: false }),
      /household_sync_access_denied/,
    );
    assert.deepEqual(generatedGraph(database), before);
  } finally {
    database.close();
  }
});
