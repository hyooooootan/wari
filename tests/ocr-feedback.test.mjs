import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildReceiptFeedback,
  countOcrCorrections,
  deleteOcrCorrections,
  normalizeOcrValue,
  registerOcrCorrections,
  storeCorrectionCandidates,
  stringSimilarity,
} from "../functions/lib/ocr-feedback.js";
import { createOcrFeedbackToken, verifyOcrFeedbackToken } from "../functions/lib/ocr-feedback-token.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const schema = readFileSync(`${root}/db/schema.sql`, "utf8");
const env = { OCR_FEEDBACK_TOKEN_KEY_V1: "x".repeat(48) };

class Statement {
  constructor(database, sql, bindings = []) { this.database = database; this.sql = sql; this.bindings = bindings; }
  bind(...bindings) { return new Statement(this.database, this.sql, bindings); }
  async first() { return this.database.prepare(this.sql).get(...this.bindings) ?? null; }
  async all() { return { results: this.database.prepare(this.sql).all(...this.bindings) }; }
  async run() {
    const result = this.database.prepare(this.sql).run(...this.bindings);
    return { meta: { changes: Number(result.changes) } };
  }
}

class Database {
  constructor() { this.database = new DatabaseSync(":memory:"); this.database.exec(schema); }
  prepare(sql) { return new Statement(this.database, sql); }
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
  close() { this.database.close(); }
}

function seed(db) {
  const timestamp = "2026-07-15T00:00:00.000Z";
  db.database.prepare("INSERT INTO users (id,google_sub,email,created_at,updated_at) VALUES (?,?,?,?,?)").run("user-a", "sub-a", "a@example.test", timestamp, timestamp);
  db.database.prepare("INSERT INTO users (id,google_sub,email,created_at,updated_at) VALUES (?,?,?,?,?)").run("user-b", "sub-b", "b@example.test", timestamp, timestamp);
  db.database.prepare("INSERT INTO projects (id,name,project_type,owner_user_id,created_at,updated_at) VALUES (?,?,?,?,?,?)").run("house-a", "House", "household", "user-a", timestamp, timestamp);
  db.database.prepare(`INSERT INTO transactions (id,project_id,merchant_name,merchant_normalized,gross_amount,paid_amount,occurred_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run("txn-a", "house-a", "たまや 浜見平店", "たまや 浜見平店", 5382, 5382, "2026-07-11", timestamp, timestamp);
}

function result(id = "ocr_12345678") {
  return {
    ocr_result_id: id,
    ocr_engine_version: "PP-OCRv6_small_rec",
    store_name: "たまた 浜見平店",
    total_amount: 5382,
    paid_at: "2026-07-11",
    paid_time: "13:16",
    items: [{ source_id: "item:0", name: "牛乳", amount: 198 }],
    field_evidence: {
      store_name: { source_id: "store:0", source_text: "たまた 浜見平店", bounding_box: [0.1, 0.02, 0.8, 0.12], confidence: 0.64, preprocessing: "adaptive" },
      total_amount: { source_id: "total:0", source_text: "合計 5,382", bounding_box: [0.5, 0.7, 0.9, 0.8], confidence: 0.95, preprocessing: "contrast" },
      paid_at: { source_id: "date:0", source_text: "2026年07月11日", bounding_box: [0.1, 0.2, 0.8, 0.25], confidence: 0.9, preprocessing: "contrast" },
      paid_time: { source_id: "date:0", source_text: "13:16", bounding_box: [0.6, 0.2, 0.8, 0.25], confidence: 0.9, preprocessing: "contrast" },
    },
  };
}

async function signedInput(id = "ocr_12345678", storeName = "たまや 浜見平店") {
  const token = await createOcrFeedbackToken(env, "user-a", "house-a", result(id), new Date("2026-07-15T00:00:00.000Z"));
  const claims = await verifyOcrFeedbackToken(env, token, "user-a", new Date("2026-07-15T01:00:00.000Z"));
  return {
    claims,
    input: {
      transaction_id: "txn-a",
      feedback_token: token,
      confirmed: {
        store_name: storeName,
        total_amount: 5382,
        paid_at: "2026-07-11",
        paid_time: "13:16",
        items: [{ source_id: "item:0", name: "牛乳", amount: 198 }],
      },
    },
  };
}

test("OCR feedback token rejects tampering, expiry, and another user", async () => {
  const token = await createOcrFeedbackToken(env, "user-a", "house-a", result(), new Date("2026-07-15T00:00:00.000Z"));
  await assert.rejects(() => verifyOcrFeedbackToken(env, `${token}x`, "user-a", new Date("2026-07-15T01:00:00.000Z")), /invalid_ocr_feedback_token/);
  await assert.rejects(() => verifyOcrFeedbackToken(env, token, "user-b", new Date("2026-07-15T01:00:00.000Z")), /ocr_feedback_token_mismatch/);
  await assert.rejects(() => verifyOcrFeedbackToken(env, token, "user-a", new Date("2026-07-17T01:00:00.000Z")), /expired_ocr_feedback_token/);
});

test("registering feedback stores changed fields, outcomes, and remains idempotent", async (t) => {
  const db = new Database();
  t.after(() => db.close());
  seed(db);
  const { claims, input } = await signedInput();
  const first = await registerOcrCorrections(db, { id: "user-a" }, input, claims);
  const second = await registerOcrCorrections(db, { id: "user-a" }, input, claims);
  assert.equal(first.accepted_events, 1);
  assert.equal(first.accepted_outcomes, 6);
  assert.deepEqual(second, { accepted_outcomes: 0, accepted_events: 0 });
  assert.equal((await countOcrCorrections(db, { id: "user-a" })).correction_count, 1);
  assert.equal((await countOcrCorrections(db, { id: "user-b" })).correction_count, 0);
  const stored = db.database.prepare("SELECT field_name,original_value,corrected_value,bounding_box_json FROM receipt_ocr_correction_events").get();
  assert.equal(stored.field_name, "store_name");
  assert.equal(stored.original_value, "たまた 浜見平店");
  assert.equal(stored.corrected_value, "たまや 浜見平店");
  assert.deepEqual(JSON.parse(stored.bounding_box_json), [0.1, 0.02, 0.8, 0.12]);
});

test("amount, date, time, item, and previously missing values are recorded from signed originals", async (t) => {
  const db = new Database();
  t.after(() => db.close());
  seed(db);
  const changed = result("ocr_changed_values");
  changed.store_name = null;
  const token = await createOcrFeedbackToken(env, "user-a", "house-a", changed, new Date("2026-07-15T00:00:00.000Z"));
  const claims = await verifyOcrFeedbackToken(env, token, "user-a", new Date("2026-07-15T01:00:00.000Z"));
  await registerOcrCorrections(db, { id: "user-a" }, {
    transaction_id: "txn-a",
    feedback_token: token,
    confirmed: {
      store_name: "たまや 浜見平店",
      total_amount: 5332,
      paid_at: "2026-07-12",
      paid_time: "13:17",
      items: [{ source_id: "item:0", name: "低脂肪乳", amount: 208 }],
    },
  }, claims);
  const rows = db.database.prepare("SELECT field_name, original_value, corrected_value FROM receipt_ocr_correction_events ORDER BY field_name").all();
  assert.deepEqual(rows.map((row) => row.field_name), ["item_amount", "item_name", "paid_at", "paid_time", "store_name", "total_amount"]);
  assert.equal(rows.find((row) => row.field_name === "store_name").original_value, "");
  assert.equal(rows.find((row) => row.field_name === "total_amount").corrected_value, "5332");
});

test("feedback deletion is scoped to the current user", async (t) => {
  const db = new Database();
  t.after(() => db.close());
  seed(db);
  const { claims, input } = await signedInput();
  await registerOcrCorrections(db, { id: "user-a" }, input, claims);
  const deleted = await deleteOcrCorrections(db, { id: "user-b" });
  assert.deepEqual(deleted, { deleted_corrections: 0, deleted_outcomes: 0 });
  assert.equal((await countOcrCorrections(db, { id: "user-a" })).correction_count, 1);
  await deleteOcrCorrections(db, { id: "user-a" });
  assert.equal((await countOcrCorrections(db, { id: "user-a" })).correction_count, 0);
});

test("five signed outcomes produce bounded preprocessing statistics and store candidates", async (t) => {
  const db = new Database();
  t.after(() => db.close());
  seed(db);
  for (let index = 0; index < 5; index += 1) {
    const { claims, input } = await signedInput(`ocr_result_${index}`);
    await registerOcrCorrections(db, { id: "user-a" }, input, claims);
  }
  const feedback = await buildReceiptFeedback(db, "user-a");
  assert.equal(feedback.store_corrections[0].count, 5);
  assert.ok(feedback.character_confusions.some((entry) => entry.observed === "た" && entry.confirmed === "や"));
  assert.ok(feedback.preprocessing_stats.some((entry) => entry.field_name === "store_name" && entry.confirmed_count === 5));
  assert.ok(new TextEncoder().encode(JSON.stringify(feedback)).byteLength <= 32 * 1024);
});

test("normalization preserves Japanese long vowels and similarity filters unrelated stores", () => {
  assert.equal(normalizeOcrValue("スーパー  A", "store_name"), "スーパー a");
  assert.equal(stringSimilarity("たまた 浜見平店", "たまや 浜見平店") > 0.8, true);
  assert.deepEqual(storeCorrectionCandidates("無関係店", { store_corrections: [{ original: "たまた 浜見平店", corrected: "たまや 浜見平店", count: 3 }] }), []);
});

test("registration rejects unknown image fields and invalid confirmed values", async (t) => {
  const db = new Database();
  t.after(() => db.close());
  seed(db);
  const { claims, input } = await signedInput();
  await assert.rejects(() => registerOcrCorrections(db, { id: "user-a" }, { ...input, image_data_url: "data:image/png;base64,AAAA" }, claims), /invalid_field/);
  await assert.rejects(() => registerOcrCorrections(db, { id: "user-a" }, { ...input, confirmed: { ...input.confirmed, paid_time: "29:99" } }, claims), /invalid_paid_time/);
  await assert.rejects(() => registerOcrCorrections(db, { id: "user-a" }, { ...input, confirmed: { ...input.confirmed, store_name: "" } }, claims), /invalid_store_name/);
});
