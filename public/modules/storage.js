(function () {
const STORAGE_KEY = "wari-data-v3";
const LEGACY_STORAGE_KEY = "wari-data-v2";
const MIGRATION_TIMESTAMP = "1970-01-01T00:00:00.000Z";
const STATE_KEYS = [
  "projects",
  "project_members",
  "transactions",
  "transaction_payments",
  "transaction_items",
  "item_allocations",
  "import_records",
];

function createEmptyState() {
  return {
    projects: [],
    project_members: [],
    transactions: [],
    transaction_payments: [],
    transaction_items: [],
    item_allocations: [],
    import_records: [],
  };
}

function copyState(value) {
  const state = createEmptyState();
  for (const key of STATE_KEYS) {
    state[key] = Array.isArray(value?.[key]) ? value[key].map((row) => ({ ...row })) : [];
  }
  return state;
}

function integer(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? Math.round(number) : 0;
}

function splitInteger(amount, memberIds) {
  if (memberIds.length === 0) return [];
  const base = Math.trunc(amount / memberIds.length);
  const remainder = amount - base * memberIds.length;
  const direction = Math.sign(remainder);
  return memberIds.map((projectMemberId, index) => ({
    projectMemberId,
    allocatedAmount: base + (index < Math.abs(remainder) ? direction : 0),
  }));
}

function transactionId(row) {
  return row?.transaction_id ?? row?.expense_id ?? null;
}

function transactionItemId(row) {
  return row?.transaction_item_id ?? row?.item_id ?? null;
}

function projectMemberId(row) {
  return row?.payer_member_id ?? row?.project_member_id ?? row?.member_id ?? null;
}

function createdAt(row, fallback) {
  return row?.created_at ?? row?.updated_at ?? fallback ?? MIGRATION_TIMESTAMP;
}

function encodedId(value) {
  return Array.from(new TextEncoder().encode(String(value)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function mapProject(row) {
  const created = createdAt(row);
  return {
    id: row.id,
    name: row.name ?? "",
    project_type: row.project_type ?? "split",
    currency: row.currency ?? "JPY",
    share_token: row.share_token ?? null,
    share_role: row.share_role ?? "editor",
    share_expires_at: row.share_expires_at ?? null,
    finalized_at: row.finalized_at ?? null,
    created_at: created,
    updated_at: row.updated_at ?? created,
  };
}

function mapProjectMember(row) {
  const created = createdAt(row);
  return {
    id: row.id,
    project_id: row.project_id,
    display_name: row.display_name ?? row.name ?? "",
    role: row.role ?? "member",
    is_active: row.is_active ?? 1,
    linked_household_project_id: row.linked_household_project_id ?? null,
    linked_at: row.linked_at ?? null,
    created_at: created,
    updated_at: row.updated_at ?? created,
  };
}

function mapTransaction(row) {
  const created = createdAt(row);
  const merchantName = row.merchant_name ?? row.store_name ?? row.title ?? "";
  const grossAmount = integer(row.gross_amount ?? row.total_amount ?? row.amount);
  const paidAmount = integer(row.paid_amount ?? row.total_amount ?? row.amount ?? grossAmount);
  return {
    id: row.id,
    project_id: row.project_id,
    merchant_name: merchantName,
    merchant_normalized: row.merchant_normalized ?? merchantName.trim().toLowerCase(),
    gross_amount: grossAmount,
    paid_amount: paidAmount,
    discount_amount: integer(row.discount_amount),
    point_amount: integer(row.point_amount),
    category: row.category ?? null,
    status: row.status ?? "confirmed",
    occurred_at: row.occurred_at ?? row.paid_at ?? created,
    settled_at: row.settled_at ?? null,
    note: row.note ?? null,
    entry_type: row.entry_type ?? row.type ?? row.transaction_type ?? row.kind ?? "purchase",
    origin_project_id: row.origin_project_id ?? null,
    origin_transaction_id: row.origin_transaction_id ?? null,
    origin_member_id: row.origin_member_id ?? null,
    generated_automatically: row.generated_automatically ?? 0,
    created_at: created,
    updated_at: row.updated_at ?? created,
  };
}

function mapPayment(row, legacyExpenses) {
  const relatedExpense = legacyExpenses.get(transactionId(row));
  const created = createdAt(row, createdAt(relatedExpense));
  return {
    id: row.id,
    transaction_id: transactionId(row),
    payer_member_id: projectMemberId(row),
    amount: integer(row.amount),
    payment_method: row.payment_method ?? "other",
    provider: row.provider ?? null,
    account_label: row.account_label ?? null,
    external_payment_id: row.external_payment_id ?? null,
    payment_status: row.payment_status ?? "confirmed",
    occurred_at: row.occurred_at ?? relatedExpense?.paid_at ?? created,
    created_at: created,
    updated_at: row.updated_at ?? created,
  };
}

function mapItem(row, sortOrder) {
  const created = createdAt(row);
  const itemType = row.item_type ?? (row.kind === "summary" || row.kind === "adjustment" ? row.kind : "product");
  return {
    id: row.id,
    transaction_id: transactionId(row),
    name: row.name ?? "",
    amount: integer(row.amount),
    quantity: row.quantity ?? 1,
    item_type: itemType,
    category: row.category ?? null,
    sort_order: Number.isSafeInteger(Number(row.sort_order)) ? Number(row.sort_order) : sortOrder,
    is_hidden: row.is_hidden ?? 0,
    created_at: created,
    updated_at: row.updated_at ?? created,
  };
}

function recordIdentity(row) {
  return row?.id === undefined || row?.id === null ? `row:${JSON.stringify(row)}` : `id:${String(row.id)}`;
}

function appendUnique(target, rows) {
  const identities = new Set(target.map(recordIdentity));
  for (const row of rows) {
    const identity = recordIdentity(row);
    if (identities.has(identity)) continue;
    target.push({ ...row });
    identities.add(identity);
  }
}

function migrationItemId(transactionIdValue, itemType) {
  return `migration:${itemType}:${encodedId(transactionIdValue)}`;
}

function migrationAllocationId(itemIdValue, projectMemberIdValue) {
  return `migration:allocation:${encodedId(itemIdValue)}:${encodedId(projectMemberIdValue)}`;
}

function migrationImportId(transactionIdValue) {
  return `migration:receipt:${encodedId(transactionIdValue)}`;
}

function hasLegacyArrays(value) {
  return ["members", "expenses", "expense_payments", "items", "item_members"].some((key) => Array.isArray(value?.[key]));
}

function migrateLegacyData(legacyData, existingState) {
  const legacy = legacyData && typeof legacyData === "object" ? legacyData : {};
  const hasLegacy = hasLegacyArrays(legacy);
  if (existingState === undefined && !hasLegacy) return copyState(legacy);
  const state = existingState === undefined ? createEmptyState() : copyState(existingState);
  if (existingState === undefined) {
    const v3Rows = copyState(legacy);
    for (const key of STATE_KEYS.slice(1)) appendUnique(state[key], v3Rows[key]);
  }
  const members = Array.isArray(legacy.members) ? legacy.members : [];
  const expenses = Array.isArray(legacy.expenses) ? legacy.expenses : [];
  const payments = Array.isArray(legacy.expense_payments) ? legacy.expense_payments : [];
  const items = Array.isArray(legacy.items) ? legacy.items : [];
  const links = Array.isArray(legacy.item_members) ? legacy.item_members : [];
  const mappedProjects = Array.isArray(legacy.projects) ? legacy.projects.map(mapProject) : [];
  const mappedMembers = members.map(mapProjectMember);
  const mappedTransactions = expenses.map(mapTransaction);
  const expenseById = new Map(expenses.map((expense) => [expense.id, expense]));
  const mappedPayments = payments.map((payment) => mapPayment(payment, expenseById));
  const sortOrders = new Map();
  const mappedItems = items.map((item) => {
    const relatedTransactionId = transactionId(item);
    const sortOrder = sortOrders.get(relatedTransactionId) ?? 0;
    sortOrders.set(relatedTransactionId, sortOrder + 1);
    return mapItem(item, sortOrder);
  });
  for (const expense of expenses) {
    const hasPayment = mappedPayments.some((payment) => transactionId(payment) === expense.id);
    if (!hasPayment && expense.payer_member_id) {
      const created = createdAt(expense);
      mappedPayments.push({
        id: `migration:payer:${encodedId(expense.id)}`,
        transaction_id: expense.id,
        payer_member_id: expense.payer_member_id,
        amount: integer(expense.total_amount),
        payment_method: "other",
        provider: null,
        account_label: null,
        external_payment_id: null,
        payment_status: "confirmed",
        occurred_at: expense.paid_at ?? created,
        created_at: created,
        updated_at: created,
      });
    }
  }
  for (const expense of expenses) {
    const expenseItems = mappedItems.filter((item) => transactionId(item) === expense.id);
    const transaction = mappedTransactions.find((row) => row.id === expense.id);
    const total = transaction ? integer(transaction.paid_amount) : integer(expense.total_amount);
    const created = createdAt(expense);
    if (expenseItems.length === 0) {
      mappedItems.push({
        id: migrationItemId(expense.id, "summary"),
        transaction_id: expense.id,
        name: "会計全体",
        amount: total,
        quantity: 1,
        item_type: "summary",
        category: null,
        sort_order: 0,
        is_hidden: 0,
        created_at: created,
        updated_at: created,
      });
      continue;
    }
    const itemTotal = expenseItems.reduce((sum, item) => sum + integer(item.amount), 0);
    if (itemTotal !== total) {
      mappedItems.push({
        id: migrationItemId(expense.id, "adjustment"),
        transaction_id: expense.id,
        name: "差額調整",
        amount: total - itemTotal,
        quantity: 1,
        item_type: "adjustment",
        category: null,
        sort_order: expenseItems.length,
        is_hidden: 1,
        created_at: created,
        updated_at: created,
      });
    }
  }
  const transactionById = new Map(mappedTransactions.map((transaction) => [transaction.id, transaction]));
  const sourceItemIds = new Set(items.map((item) => item.id));
  const mappedAllocations = [];
  for (const item of mappedItems) {
    const transaction = transactionById.get(transactionId(item));
    if (!transaction) continue;
    const linkedRows = sourceItemIds.has(item.id) ? links.filter((link) => transactionItemId(link) === item.id) : [];
    const distinctLinks = [];
    const linkedMemberIds = new Set();
    for (const link of linkedRows) {
      const linkedMemberId = projectMemberId(link);
      if (linkedMemberId === null || linkedMemberIds.has(linkedMemberId)) continue;
      linkedMemberIds.add(linkedMemberId);
      distinctLinks.push(link);
    }
    const projectMembers = mappedMembers.filter((member) => member.project_id === transaction.project_id);
    const allocationMembers = distinctLinks.length > 0
      ? distinctLinks.map((link) => ({ id: projectMemberId(link), link }))
      : projectMembers.map((member) => ({ id: member.id, link: null }));
    const shares = splitInteger(integer(item.amount), allocationMembers.map((member) => member.id));
    shares.forEach((share, index) => {
      const link = allocationMembers[index].link;
      const created = createdAt(link, item.created_at);
      mappedAllocations.push({
        id: link?.id ?? migrationAllocationId(item.id, share.projectMemberId),
        transaction_item_id: item.id,
        project_member_id: share.projectMemberId,
        allocated_amount: share.allocatedAmount,
        created_at: created,
        updated_at: link?.updated_at ?? created,
      });
    });
  }
  const mappedImports = expenses
    .filter((expense) => expense.receipt_image_url && String(expense.receipt_image_url).trim() !== "")
    .map((expense) => {
      const transaction = transactionById.get(expense.id);
      const created = createdAt(expense);
      return {
        id: migrationImportId(expense.id),
        project_id: expense.project_id,
        transaction_id: expense.id,
        source_type: "receipt",
        source_record_id: `legacy-expense:${encodedId(expense.id)}`,
        source_status: "linked",
        merchant_raw: expense.store_name ?? null,
        merchant_normalized: transaction?.merchant_normalized ?? expense.store_name ?? null,
        gross_amount_raw: transaction?.gross_amount ?? integer(expense.total_amount),
        paid_amount_raw: transaction?.paid_amount ?? integer(expense.total_amount),
        occurred_at_raw: expense.paid_at ?? null,
        settled_at_raw: null,
        payment_method_raw: null,
        external_transaction_id: null,
        image_url: expense.receipt_image_url,
        raw_text: null,
        raw_payload: null,
        parse_confidence: null,
        parser_version: "legacy-migration",
        match_score: null,
        match_reason_json: null,
        created_at: created,
        updated_at: created,
      };
    });
  appendUnique(state.projects, mappedProjects);
  appendUnique(state.project_members, mappedMembers);
  appendUnique(state.transactions, mappedTransactions);
  appendUnique(state.transaction_payments, mappedPayments);
  appendUnique(state.transaction_items, mappedItems);
  appendUnique(state.item_allocations, mappedAllocations);
  appendUnique(state.import_records, mappedImports);
  return state;
}

function defaultStorage() {
  return typeof globalThis !== "undefined" && globalThis.localStorage ? globalThis.localStorage : null;
}

function storageLike(value) {
  return value && typeof value.getItem === "function" && typeof value.setItem === "function";
}

function readStoredObject(storage, key) {
  try {
    const raw = storage.getItem(key);
    if (raw === null || raw === undefined || raw === "") return null;
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function loadState(storage = defaultStorage()) {
  if (!storageLike(storage)) return createEmptyState();
  const storedState = readStoredObject(storage, STORAGE_KEY);
  if (storedState) return copyState(storedState);
  const legacyState = readStoredObject(storage, LEGACY_STORAGE_KEY);
  const state = legacyState ? migrateLegacyData(legacyState) : createEmptyState();
  if (legacyState) storage.setItem(STORAGE_KEY, JSON.stringify(state));
  return state;
}

function saveState(state, storage = defaultStorage()) {
  let value = state;
  let target = storage;
  if (storageLike(state) && !storageLike(storage)) {
    target = state;
    value = storage;
  }
  if (!storageLike(target)) {
    throw new TypeError("A Storage-like object is required");
  }
  const normalized = copyState(value);
  target.setItem(STORAGE_KEY, JSON.stringify(normalized));
  return normalized;
}

function graphReferences(state, projectId) {
  const transactionIds = new Set(
    state.transactions.filter((transaction) => transaction.project_id === projectId).map((transaction) => transaction.id),
  );
  const itemIds = new Set(
    state.transaction_items
      .filter((item) => transactionIds.has(transactionId(item)))
      .map((item) => item.id),
  );
  return { transactionIds, itemIds };
}

function rowBelongsToProject(row, key, projectId, references) {
  if (key === "projects") return row?.id === projectId;
  if (key === "project_members" || key === "transactions" || key === "import_records") {
    return row?.project_id === projectId || references.transactionIds.has(transactionId(row));
  }
  if (key === "transaction_payments" || key === "transaction_items") {
    return row?.project_id === projectId || references.transactionIds.has(transactionId(row));
  }
  if (key === "item_allocations") {
    return row?.project_id === projectId || references.itemIds.has(transactionItemId(row));
  }
  return false;
}

function mergeProjectGraph(state, graph) {
  const current = copyState(state);
  const incoming = copyState(graph);
  const projectIds = incoming.projects.map((project) => project.id).filter((id) => id !== undefined && id !== null);
  let projectId = projectIds[0] ?? incoming.transactions[0]?.project_id ?? incoming.project_members[0]?.project_id ?? null;
  if (projectId === null) return current;
  if (projectIds.some((id) => id !== projectId)) {
    throw new TypeError("Project graph must contain one project");
  }
  const currentReferences = graphReferences(current, projectId);
  const incomingReferences = graphReferences(incoming, projectId);
  for (const key of STATE_KEYS) {
    if (key === "projects" && incoming.projects.length === 0) continue;
    const existingRows = current[key];
    const firstIndex = existingRows.findIndex((row) => rowBelongsToProject(row, key, projectId, currentReferences));
    const keptRows = existingRows.filter((row) => !rowBelongsToProject(row, key, projectId, currentReferences));
    const nextRows = incoming[key].filter((row) => rowBelongsToProject(row, key, projectId, incomingReferences));
    const uniqueRows = [];
    appendUnique(uniqueRows, nextRows);
    const insertAt = firstIndex < 0 ? keptRows.length : Math.min(firstIndex, keptRows.length);
    keptRows.splice(insertAt, 0, ...uniqueRows);
    current[key] = keptRows;
  }
  return current;
}

const api = {
  STORAGE_KEY,
  LEGACY_STORAGE_KEY,
  createEmptyState,
  migrateLegacyData,
  loadState,
  saveState,
  mergeProjectGraph,
};

if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof globalThis !== "undefined") globalThis.WariStorage = api;
})();
