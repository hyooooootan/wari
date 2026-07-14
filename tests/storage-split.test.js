const test = require("node:test");
const assert = require("node:assert/strict");

const {
  STORAGE_KEY,
  LEGACY_STORAGE_KEY,
  createEmptyState,
  migrateLegacyData,
  loadState,
  saveState,
  mergeProjectGraph,
} = require("../public/modules/storage.js");
const {
  splitAmount,
  calculateSplit,
  validateProjectTransactions,
  aggregateHousehold,
} = require("../public/modules/split.js");

class MemoryStorage {
  constructor(entries = {}) {
    this.values = new Map(Object.entries(entries));
    this.removed = [];
  }

  getItem(key) {
    return this.values.has(key) ? this.values.get(key) : null;
  }

  setItem(key, value) {
    this.values.set(key, String(value));
  }

  removeItem(key) {
    this.removed.push(key);
    this.values.delete(key);
  }
}

function legacyFixture() {
  return {
    projects: [{ id: "p1", name: "Trip", created_at: "2026-01-01T00:00:00.000Z" }],
    members: [
      { id: "a", project_id: "p1", name: "A", created_at: "2026-01-01T00:00:00.000Z" },
      { id: "b", project_id: "p1", name: "B", created_at: "2026-01-01T00:00:00.000Z" },
      { id: "c", project_id: "p1", name: "C", created_at: "2026-01-01T00:00:00.000Z" },
    ],
    expenses: [
      {
        id: "e1",
        project_id: "p1",
        payer_member_id: "a",
        store_name: "Store 1",
        total_amount: 10,
        paid_at: "2026-01-02",
        receipt_image_url: null,
        created_at: "2026-01-02T00:00:00.000Z",
      },
      {
        id: "e2",
        project_id: "p1",
        payer_member_id: null,
        store_name: "Store 2",
        total_amount: 7,
        paid_at: "2026-01-03",
        receipt_image_url: "receipt.jpg",
        created_at: "2026-01-03T00:00:00.000Z",
      },
    ],
    expense_payments: [
      {
        id: "pay2",
        project_id: "p1",
        expense_id: "e2",
        member_id: "b",
        amount: 7,
        created_at: "2026-01-03T00:00:00.000Z",
      },
    ],
    items: [
      {
        id: "i2",
        project_id: "p1",
        expense_id: "e2",
        name: "Food",
        amount: 5,
        created_at: "2026-01-03T00:00:00.000Z",
      },
    ],
    item_members: [
      { id: "l1", project_id: "p1", item_id: "i2", member_id: "c", created_at: "2026-01-03T00:00:00.000Z" },
      { id: "l2", project_id: "p1", item_id: "i2", member_id: "a", created_at: "2026-01-03T00:00:00.000Z" },
      { id: "l3", project_id: "p1", item_id: "i2", member_id: "b", created_at: "2026-01-03T00:00:00.000Z" },
    ],
  };
}

test("splitAmount keeps integer totals and gives one-yen remainders in member order", () => {
  assert.deepEqual(splitAmount(10, ["a", "b", "c"]), [
    { mid: "a", amount: 4 },
    { mid: "b", amount: 3 },
    { mid: "c", amount: 3 },
  ]);
  assert.deepEqual(splitAmount(2, ["c", "a", "b"]), [
    { mid: "c", amount: 1 },
    { mid: "a", amount: 1 },
    { mid: "b", amount: 0 },
  ]);
  assert.deepEqual(splitAmount(-5, ["a", "b"]), [
    { mid: "a", amount: -3 },
    { mid: "b", amount: -2 },
  ]);
});

test("migrateLegacyData creates the seven-array state and explicit integer allocations", () => {
  const state = migrateLegacyData(legacyFixture());
  assert.deepEqual(Object.keys(state), [
    "projects",
    "project_members",
    "transactions",
    "transaction_payments",
    "transaction_items",
    "item_allocations",
    "import_records",
  ]);
  assert.equal(state.transactions.length, 2);
  assert.deepEqual(
    {
      entry_type: state.transactions[0].entry_type,
      status: state.transactions[0].status,
      merchant_name: state.transactions[0].merchant_name,
      gross_amount: state.transactions[0].gross_amount,
      paid_amount: state.transactions[0].paid_amount,
      occurred_at: state.transactions[0].occurred_at,
    },
    {
      entry_type: "purchase",
      status: "confirmed",
      merchant_name: "Store 1",
      gross_amount: 10,
      paid_amount: 10,
      occurred_at: "2026-01-02",
    },
  );
  assert.equal(state.projects[0].project_type, "split");
  assert.equal(state.projects[0].currency, "JPY");
  assert.equal(state.project_members[0].display_name, "A");
  const generatedPayment = state.transaction_payments.find((row) => row.transaction_id === "e1");
  assert.equal(generatedPayment.id, "migration:payer:6531");
  assert.equal(generatedPayment.payer_member_id, "a");
  assert.equal(generatedPayment.amount, 10);
  const summary = state.transaction_items.find((row) => row.item_type === "summary");
  const adjustment = state.transaction_items.find((row) => row.item_type === "adjustment");
  assert.equal(summary.transaction_id, "e1");
  assert.equal(summary.amount, 10);
  assert.equal(adjustment.transaction_id, "e2");
  assert.equal(adjustment.amount, 2);
  assert.equal(adjustment.is_hidden, 1);
  assert.deepEqual(
    state.item_allocations
      .filter((row) => row.transaction_item_id === "i2")
      .map((row) => [row.project_member_id, row.allocated_amount]),
    [
      ["c", 2],
      ["a", 2],
      ["b", 1],
    ],
  );
  assert.deepEqual(
    state.item_allocations
      .filter((row) => row.transaction_item_id === adjustment.id)
      .map((row) => [row.project_member_id, row.allocated_amount]),
    [
      ["a", 1],
      ["b", 1],
      ["c", 0],
    ],
  );
  assert.equal(state.import_records.length, 1);
  assert.equal(state.import_records[0].id, "migration:receipt:6532");
  assert.equal(state.import_records[0].transaction_id, "e2");
  assert.equal(state.import_records[0].source_record_id, "legacy-expense:6532");
  assert.equal(state.import_records[0].image_url, "receipt.jpg");
  assert.equal(validateProjectTransactions(state, "p1").valid, true);
});

test("migrateLegacyData is idempotent", () => {
  const legacy = legacyFixture();
  const once = migrateLegacyData(legacy);
  const twice = migrateLegacyData(legacy, once);
  assert.deepEqual(twice, once);
  assert.deepEqual(migrateLegacyData(once), once);
});

test("loadState writes v3 through injected storage and retains the legacy key", () => {
  const legacyText = JSON.stringify(legacyFixture());
  const storage = new MemoryStorage({ [LEGACY_STORAGE_KEY]: legacyText });
  const first = loadState(storage);
  const second = loadState(storage);
  assert.deepEqual(second, first);
  assert.equal(storage.getItem(LEGACY_STORAGE_KEY), legacyText);
  assert.deepEqual(JSON.parse(storage.getItem(STORAGE_KEY)), first);
  assert.deepEqual(storage.removed, []);
  const empty = createEmptyState();
  empty.projects.push({ id: "saved", name: "Saved" });
  assert.deepEqual(saveState(empty, storage), empty);
  assert.deepEqual(JSON.parse(storage.getItem(STORAGE_KEY)), empty);
  assert.deepEqual(loadState(storage).projects.map((project) => project.id), ["saved"]);
  assert.equal(storage.getItem(LEGACY_STORAGE_KEY), legacyText);
});

test("mergeProjectGraph replaces one graph and preserves other projects", () => {
  const state = createEmptyState();
  state.projects.push({ id: "p1", name: "Old" }, { id: "p2", name: "Keep" });
  state.project_members.push(
    { id: "old", project_id: "p1", name: "Old member" },
    { id: "keep", project_id: "p2", name: "Keep member" },
  );
  state.transactions.push({ id: "old-tx", project_id: "p1", entry_type: "split_expense", status: "confirmed", paid_amount: 1 });
  state.transaction_payments.push({ id: "old-pay", transaction_id: "old-tx", payer_member_id: "old", amount: 1 });
  state.transaction_items.push({ id: "old-item", transaction_id: "old-tx", amount: 1 });
  state.item_allocations.push({ id: "old-allocation", transaction_item_id: "old-item", project_member_id: "old", allocated_amount: 1 });
  const graph = createEmptyState();
  graph.projects.push({ id: "p1", name: "New" });
  graph.project_members.push({ id: "new", project_id: "p1", name: "New member" });
  graph.transactions.push({ id: "new-tx", project_id: "p1", entry_type: "split_expense", status: "confirmed", paid_amount: 2 });
  graph.transaction_payments.push({ id: "new-pay", transaction_id: "new-tx", payer_member_id: "new", amount: 2 });
  graph.transaction_items.push({ id: "new-item", transaction_id: "new-tx", amount: 2 });
  graph.item_allocations.push({ id: "new-allocation", transaction_item_id: "new-item", project_member_id: "new", allocated_amount: 2 });
  const merged = mergeProjectGraph(state, graph);
  assert.deepEqual(merged.projects.map((row) => row.name), ["New", "Keep"]);
  assert.deepEqual(merged.project_members.map((row) => row.id), ["new", "keep"]);
  assert.deepEqual(merged.transactions.map((row) => row.id), ["new-tx"]);
  assert.deepEqual(merged.transaction_payments.map((row) => row.id), ["new-pay"]);
  assert.deepEqual(merged.transaction_items.map((row) => row.id), ["new-item"]);
  assert.deepEqual(merged.item_allocations.map((row) => row.id), ["new-allocation"]);
  assert.equal(state.projects[0].name, "Old");
});

test("calculateSplit derives burdens, advances, balances, and deterministic settlements", () => {
  const state = migrateLegacyData(legacyFixture());
  const result = calculateSplit(state, "p1");
  assert.deepEqual(result.burdens, { a: 7, b: 5, c: 5 });
  assert.deepEqual(result.advances, { a: 10, b: 7, c: 0 });
  assert.deepEqual(
    result.balances.map((row) => [row.member_id, row.balance]),
    [
      ["a", 3],
      ["b", 2],
      ["c", -5],
    ],
  );
  assert.deepEqual(result.settlements, [
    { from_member_id: "c", to_member_id: "a", amount: 3 },
    { from_member_id: "c", to_member_id: "b", amount: 2 },
  ]);
  const withCancelledPayment = structuredClone(state);
  withCancelledPayment.transaction_payments.push({
    id: "cancelled",
    transaction_id: "e1",
    payer_member_id: "c",
    amount: 100,
    payment_status: "cancelled",
  });
  assert.deepEqual(calculateSplit(withCancelledPayment, "p1").advances, result.advances);
  assert.equal(validateProjectTransactions(withCancelledPayment, "p1").valid, true);
  const changed = structuredClone(state);
  changed.item_allocations[0].allocated_amount += 1;
  changed.transaction_payments[0].amount = 1.5;
  const validation = validateProjectTransactions(changed, "p1");
  assert.equal(validation.valid, false);
  assert.equal(validation.errors.includes("payment_amount_not_integer"), true);
  assert.equal(validation.errors.includes("item_allocation_total_mismatch"), true);
  assert.equal(validation.errors.includes("allocation_total_mismatch"), true);
});

test("aggregateHousehold counts each confirmed purchase or split expense once", () => {
  const state = createEmptyState();
  state.projects.push({ id: "home", name: "Home" });
  state.transactions.push(
    { id: "purchase", project_id: "home", entry_type: "purchase", status: "confirmed", paid_amount: 100 },
    { id: "split", project_id: "home", entry_type: "split_expense", status: "confirmed", paid_amount: 50 },
    { id: "advance", project_id: "home", entry_type: "advance", status: "confirmed", paid_amount: 30 },
    { id: "settlement-out", project_id: "home", entry_type: "settlement_out", status: "confirmed", paid_amount: 20 },
    { id: "settlement-in", project_id: "home", entry_type: "settlement_in", status: "confirmed", paid_amount: 20 },
    { id: "draft", project_id: "home", entry_type: "purchase", status: "provisional", paid_amount: 200 },
    { id: "purchase", project_id: "home", entry_type: "purchase", status: "confirmed", paid_amount: 100 },
  );
  state.transaction_payments.push({ id: "payment", transaction_id: "purchase", payer_member_id: "a", amount: 100 });
  state.transaction_items.push({ id: "item", transaction_id: "purchase", amount: 100 });
  state.item_allocations.push({ id: "allocation", transaction_item_id: "item", project_member_id: "a", allocated_amount: 100 });
  const result = aggregateHousehold(state, "home");
  assert.equal(result.total_amount, 150);
  assert.equal(result.transaction_count, 2);
  assert.deepEqual(result.by_type, {
    purchase: { count: 1, amount: 100 },
    split_expense: { count: 1, amount: 50 },
  });
});
