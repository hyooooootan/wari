const STATE_KEYS = [
  "projects",
  "project_members",
  "transactions",
  "transaction_payments",
  "transaction_items",
  "item_allocations",
  "import_records",
];

let idSequence = 0;

class HouseholdStateError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "HouseholdStateError";
    this.code = code;
    Object.assign(this, details);
  }
}

function globalDependency(name) {
  return typeof globalThis !== "undefined" ? globalThis[name] : undefined;
}

function storageDependency(options = {}) {
  return options.storage || globalDependency("WariStorage");
}

function splitDependency(options = {}) {
  return options.split || globalDependency("WariSplit");
}

function copyState(state, options = {}) {
  const storage = storageDependency(options);
  const empty = storage && typeof storage.createEmptyState === "function"
    ? storage.createEmptyState()
    : Object.fromEntries(STATE_KEYS.map((key) => [key, []]));
  for (const key of STATE_KEYS) {
    empty[key] = Array.isArray(state?.[key]) ? state[key].map((row) => ({ ...row })) : [];
  }
  return empty;
}

function isoTimestamp(options = {}, fallback) {
  const source = fallback ?? (typeof options.now === "function" ? options.now() : options.now) ?? new Date();
  if (source instanceof Date) return source.toISOString();
  const text = String(source);
  if (!text) throw new HouseholdStateError("invalid_timestamp", "日時が空です");
  return text;
}

function defaultId(prefix) {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  idSequence += 1;
  return `${prefix}_${Date.now().toString(36)}_${idSequence.toString(36)}`;
}

function makeId(prefix, explicit, options = {}) {
  if (explicit !== undefined && explicit !== null && String(explicit) !== "") return String(explicit);
  const value = typeof options.makeId === "function" ? options.makeId(prefix) : defaultId(prefix);
  if (value === undefined || value === null || String(value) === "") {
    throw new HouseholdStateError("invalid_generated_id", "識別子を作成できません", { prefix });
  }
  return String(value);
}

function requireUniqueId(state, table, id) {
  if (state[table].some((row) => row.id === id)) {
    throw new HouseholdStateError("duplicate_id", "同じ識別子の行が存在します", { id, table });
  }
}

function requireProject(state, projectId) {
  const project = state.projects.find((row) => row.id === projectId);
  if (!project) throw new HouseholdStateError("project_not_found", "企画が見つかりません", { projectId });
  return project;
}

function requireHouseholdProject(state, projectId) {
  const project = requireProject(state, projectId);
  if (project.project_type !== "household") {
    throw new HouseholdStateError("household_project_required", "家計企画を指定してください", { projectId });
  }
  return project;
}

function safeInteger(value, field) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    throw new HouseholdStateError("integer_required", `${field}は整数で入力してください`, { field, value });
  }
  return number;
}

function transactionId(row) {
  return row?.transaction_id ?? row?.expense_id ?? null;
}

function transactionItemId(row) {
  return row?.transaction_item_id ?? row?.item_id ?? null;
}

function memberId(row) {
  return row?.project_member_id ?? row?.payer_member_id ?? row?.member_id ?? row?.mid ?? null;
}

function activeHouseholdMember(state, projectId, requestedMemberId) {
  const members = state.project_members.filter((row) => row.project_id === projectId && row.is_active !== 0);
  if (requestedMemberId) {
    const requested = members.find((row) => row.id === requestedMemberId);
    if (!requested) {
      throw new HouseholdStateError("household_member_not_found", "家計企画の参加者が見つかりません", {
        projectId,
        memberId: requestedMemberId,
      });
    }
    return requested;
  }
  const selected = members.find((row) => row.role === "owner")
    || members.find((row) => row.display_name === "自分")
    || members[0];
  if (!selected) {
    throw new HouseholdStateError("household_member_not_found", "家計企画に有効な参加者がいません", { projectId });
  }
  return selected;
}

function createHouseholdProject(state, input = {}, options = {}) {
  const values = typeof input === "string" ? { name: input } : { ...(input || {}) };
  const next = copyState(state, options);
  const timestamp = isoTimestamp(options, values.created_at);
  const projectId = makeId("prj", values.id ?? values.project_id ?? options.projectId, options);
  const ownerId = makeId("mem", values.owner_member_id ?? values.member_id ?? options.memberId, options);
  requireUniqueId(next, "projects", projectId);
  requireUniqueId(next, "project_members", ownerId);
  const name = String(values.name || "家計簿").trim();
  if (!name) throw new HouseholdStateError("project_name_required", "家計企画の名前を入力してください");
  next.projects.push({
    id: projectId,
    name,
    project_type: "household",
    currency: String(values.currency || "JPY"),
    share_token: values.share_token ?? null,
    share_role: values.share_role || "editor",
    share_expires_at: values.share_expires_at ?? null,
    finalized_at: null,
    created_at: timestamp,
    updated_at: timestamp,
  });
  next.project_members.push({
    id: ownerId,
    project_id: projectId,
    display_name: String(values.owner_name || "自分"),
    role: "owner",
    is_active: 1,
    linked_household_project_id: null,
    linked_at: null,
    created_at: timestamp,
    updated_at: timestamp,
  });
  return next;
}

function createManualHouseholdTransaction(state, projectId, input = {}, options = {}) {
  const next = copyState(state, options);
  const project = requireHouseholdProject(next, projectId);
  if (project.finalized_at) {
    throw new HouseholdStateError("project_finalized", "確定済みの家計企画は編集できません", { projectId });
  }
  const amount = safeInteger(input.paid_amount ?? input.amount ?? input.total_amount, "金額");
  const grossAmount = safeInteger(input.gross_amount ?? amount, "購入額");
  const timestamp = isoTimestamp(options, input.created_at);
  const occurredAt = isoTimestamp(options, input.occurred_at ?? timestamp);
  const payer = activeHouseholdMember(
    next,
    projectId,
    input.payer_member_id ?? input.project_member_id ?? input.member_id,
  );
  const id = makeId("txn", input.id ?? input.transaction_id, options);
  const paymentId = makeId("pay", input.payment_id, options);
  const itemId = makeId("itm", input.summary_item_id ?? input.item_id, options);
  const allocationId = makeId("alc", input.allocation_id, options);
  requireUniqueId(next, "transactions", id);
  requireUniqueId(next, "transaction_payments", paymentId);
  requireUniqueId(next, "transaction_items", itemId);
  requireUniqueId(next, "item_allocations", allocationId);
  const merchantName = String(input.merchant_name ?? input.store_name ?? "手入力").trim() || "手入力";
  next.transactions.push({
    id,
    project_id: projectId,
    merchant_name: merchantName,
    merchant_normalized: String(input.merchant_normalized ?? merchantName.trim().toLowerCase()),
    gross_amount: grossAmount,
    paid_amount: amount,
    discount_amount: safeInteger(input.discount_amount ?? 0, "値引額"),
    point_amount: safeInteger(input.point_amount ?? 0, "ポイント額"),
    category: input.category ?? null,
    status: input.status || "confirmed",
    occurred_at: occurredAt,
    settled_at: input.settled_at ?? null,
    note: input.note ?? null,
    entry_type: input.entry_type || "purchase",
    origin_project_id: null,
    origin_transaction_id: null,
    origin_member_id: null,
    generated_automatically: 0,
    created_at: timestamp,
    updated_at: timestamp,
  });
  next.transaction_payments.push({
    id: paymentId,
    transaction_id: id,
    payer_member_id: payer.id,
    amount,
    payment_method: input.payment_method || "other",
    provider: input.provider ?? null,
    account_label: input.account_label ?? null,
    external_payment_id: input.external_payment_id ?? null,
    payment_status: input.payment_status || "confirmed",
    occurred_at: occurredAt,
    created_at: timestamp,
    updated_at: timestamp,
  });
  next.transaction_items.push({
    id: itemId,
    transaction_id: id,
    name: String(input.item_name || "合計"),
    amount,
    quantity: 1,
    item_type: "summary",
    category: input.category ?? null,
    sort_order: 0,
    is_hidden: 0,
    created_at: timestamp,
    updated_at: timestamp,
  });
  next.item_allocations.push({
    id: allocationId,
    transaction_item_id: itemId,
    project_member_id: payer.id,
    allocated_amount: amount,
    created_at: timestamp,
    updated_at: timestamp,
  });
  return next;
}

function linkSplitMember(state, splitMemberId, householdProjectId, options = {}) {
  const next = copyState(state, options);
  const member = next.project_members.find((row) => row.id === splitMemberId);
  if (!member) {
    throw new HouseholdStateError("split_member_not_found", "割り勘企画の参加者が見つかりません", { splitMemberId });
  }
  const sourceProject = requireProject(next, member.project_id);
  if (sourceProject.project_type !== "split") {
    throw new HouseholdStateError("split_project_required", "割り勘企画の参加者を指定してください", { splitMemberId });
  }
  if (householdProjectId !== null && householdProjectId !== undefined && householdProjectId !== "") {
    requireHouseholdProject(next, householdProjectId);
  }
  const timestamp = isoTimestamp(options);
  member.linked_household_project_id = householdProjectId || null;
  member.linked_at = householdProjectId ? timestamp : null;
  member.updated_at = timestamp;
  return next;
}

function stablePart(value) {
  const text = String(value);
  if (typeof TextEncoder === "function") {
    return Array.from(new TextEncoder().encode(text), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  return encodeURIComponent(text).replace(/%/gu, "").replace(/[^A-Za-z0-9]/gu, (char) => char.charCodeAt(0).toString(16));
}

function originKey(householdProjectId, projectId, transactionIdValue, memberIdValue) {
  return [householdProjectId, projectId, transactionIdValue, memberIdValue].map(stablePart).join(":");
}

function generatedRowId(kind, projectId, transactionIdValue, memberIdValue, householdProjectId) {
  return ["household", kind, projectId, transactionIdValue, memberIdValue, householdProjectId]
    .map((value) => encodeURIComponent(String(value)))
    .join(":");
}

function generatedItemId(transaction, sourceItemId) {
  return [
    "household",
    "item",
    transaction.origin_project_id,
    transaction.origin_transaction_id,
    transaction.origin_member_id,
    transaction.project_id,
    sourceItemId,
  ].map((value) => encodeURIComponent(String(value))).join(":");
}

function generatedAllocationId(itemIdValue, householdMemberId) {
  return ["household", "allocation", itemIdValue, householdMemberId]
    .map((value) => encodeURIComponent(String(value)))
    .join(":");
}

function generatedIdentity(row) {
  return originKey(row.project_id, row.origin_project_id, row.origin_transaction_id, row.origin_member_id);
}

function generatedStatus(finalized) {
  return finalized ? "confirmed" : "provisional";
}

function paymentStatus(status) {
  if (status === "cancelled" || status === "refunded" || status === "provisional") return status;
  return "confirmed";
}

function replaceGeneratedChildren(state, transaction, targetMember, itemShares, amount, timestamp, status) {
  const transactionPayments = state.transaction_payments.filter((row) => transactionId(row) === transaction.id);
  const paymentId = generatedRowId(
    "payment",
    transaction.origin_project_id,
    transaction.origin_transaction_id,
    transaction.origin_member_id,
    transaction.project_id,
  );
  const existingPayment = transactionPayments.find((row) => row.id === paymentId) || transactionPayments[0];
  state.transaction_payments = state.transaction_payments.filter((row) => transactionId(row) !== transaction.id);
  state.transaction_payments.push({
    id: paymentId,
    transaction_id: transaction.id,
    payer_member_id: targetMember.id,
    amount,
    payment_method: existingPayment?.payment_method || "other",
    provider: existingPayment?.provider ?? null,
    account_label: existingPayment?.account_label ?? null,
    external_payment_id: existingPayment?.external_payment_id ?? null,
    payment_status: paymentStatus(status),
    occurred_at: transaction.occurred_at,
    created_at: existingPayment?.created_at || timestamp,
    updated_at: timestamp,
  });
  const transactionItems = state.transaction_items.filter((row) => transactionId(row) === transaction.id);
  const existingItems = new Map(transactionItems.map((row) => [row.id, row]));
  const removedItemIds = new Set(transactionItems.map((row) => row.id));
  const existingAllocations = new Map(
    state.item_allocations
      .filter((row) => removedItemIds.has(transactionItemId(row)))
      .map((row) => [transactionItemId(row), row]),
  );
  state.transaction_items = state.transaction_items.filter((row) => transactionId(row) !== transaction.id);
  state.item_allocations = state.item_allocations.filter((row) => !removedItemIds.has(transactionItemId(row)));
  itemShares.forEach(({ item, amount: itemAmount }, index) => {
    const itemId = generatedItemId(transaction, item.id);
    const existingItem = existingItems.get(itemId);
    const existingAllocation = existingAllocations.get(itemId);
    state.transaction_items.push({
      id: itemId,
      transaction_id: transaction.id,
      name: String(item.name || "品目"),
      amount: itemAmount,
      quantity: Number(item.quantity) > 0 ? Number(item.quantity) : 1,
      item_type: item.item_type || "product",
      category: item.category ?? transaction.category ?? null,
      sort_order: Number.isSafeInteger(Number(item.sort_order)) && Number(item.sort_order) >= 0
        ? Number(item.sort_order)
        : index,
      is_hidden: item.is_hidden ?? 0,
      created_at: existingItem?.created_at || timestamp,
      updated_at: timestamp,
    });
    state.item_allocations.push({
      id: existingAllocation?.id || generatedAllocationId(itemId, targetMember.id),
      transaction_item_id: itemId,
      project_member_id: targetMember.id,
      allocated_amount: itemAmount,
      created_at: existingAllocation?.created_at || timestamp,
      updated_at: timestamp,
    });
  });
}

function cancelGeneratedRow(state, transaction, timestamp) {
  transaction.gross_amount = 0;
  transaction.paid_amount = 0;
  transaction.discount_amount = 0;
  transaction.point_amount = 0;
  transaction.status = "cancelled";
  transaction.updated_at = timestamp;
  for (const payment of state.transaction_payments) {
    if (transactionId(payment) !== transaction.id) continue;
    payment.amount = 0;
    payment.payment_status = "cancelled";
    payment.updated_at = timestamp;
  }
  const itemIds = new Set();
  for (const item of state.transaction_items) {
    if (transactionId(item) !== transaction.id) continue;
    itemIds.add(item.id);
    item.amount = 0;
    item.updated_at = timestamp;
  }
  for (const allocation of state.item_allocations) {
    if (!itemIds.has(transactionItemId(allocation))) continue;
    allocation.allocated_amount = 0;
    allocation.updated_at = timestamp;
  }
}

function synchronizeSplitAllocations(state, splitProjectId, options = {}) {
  const next = copyState(state, options);
  const splitProject = requireProject(next, splitProjectId);
  if (splitProject.project_type !== "split") {
    throw new HouseholdStateError("split_project_required", "割り勘企画を指定してください", { splitProjectId });
  }
  const timestamp = isoTimestamp(options);
  const linkedMembers = next.project_members.filter(
    (row) => row.project_id === splitProjectId && row.is_active !== 0 && row.linked_household_project_id,
  );
  const transactions = next.transactions.filter(
    (row) => row.project_id === splitProjectId && row.generated_automatically !== 1,
  );
  const transactionIds = new Set(transactions.map((row) => row.id));
  const items = next.transaction_items.filter((row) => transactionIds.has(transactionId(row)));
  const itemTransaction = new Map(items.map((row) => [row.id, transactionId(row)]));
  const sourceItems = new Map(items.map((row) => [row.id, row]));
  const allocationShares = new Map();
  for (const allocation of next.item_allocations) {
    const sourceItemId = transactionItemId(allocation);
    const sourceTransactionId = itemTransaction.get(sourceItemId);
    if (!sourceTransactionId) continue;
    const sourceMemberId = memberId(allocation);
    const key = `${stablePart(sourceTransactionId)}:${stablePart(sourceMemberId)}`;
    const amount = safeInteger(allocation.allocated_amount ?? allocation.amount, "配分額");
    const shares = allocationShares.get(key) || new Map();
    shares.set(sourceItemId, (shares.get(sourceItemId) || 0) + amount);
    allocationShares.set(key, shares);
  }
  const expected = new Set();
  for (const sourceTransaction of transactions) {
    if (["cancelled", "refunded", "corrected"].includes(String(sourceTransaction.status || "").toLowerCase())) continue;
    for (const sourceMember of linkedMembers) {
      const totalKey = `${stablePart(sourceTransaction.id)}:${stablePart(sourceMember.id)}`;
      const shares = allocationShares.get(totalKey) || new Map();
      const itemShares = [...shares.entries()]
        .map(([sourceItemId, amount]) => ({ item: sourceItems.get(sourceItemId), amount }))
        .filter((entry) => entry.item && entry.amount !== 0)
        .sort((left, right) => Number(left.item.sort_order ?? 0) - Number(right.item.sort_order ?? 0));
      const amount = itemShares.reduce((sum, entry) => sum + entry.amount, 0);
      if (amount === 0) continue;
      const householdProjectId = sourceMember.linked_household_project_id;
      const householdProject = next.projects.find(
        (row) => row.id === householdProjectId && row.project_type === "household",
      );
      if (!householdProject) continue;
      const targetMember = activeHouseholdMember(next, householdProjectId);
      const identity = originKey(householdProjectId, splitProjectId, sourceTransaction.id, sourceMember.id);
      expected.add(identity);
      const desiredTransactionId = generatedRowId(
        "transaction",
        splitProjectId,
        sourceTransaction.id,
        sourceMember.id,
        householdProjectId,
      );
      const matches = next.transactions.filter(
        (row) => row.generated_automatically === 1
          && row.entry_type === "split_expense"
          && (generatedIdentity(row) === identity || row.id === desiredTransactionId),
      );
      const transaction = matches[0] || {
        id: desiredTransactionId,
        created_at: timestamp,
      };
      if (!matches.length) {
        requireUniqueId(next, "transactions", transaction.id);
        next.transactions.push(transaction);
      }
      for (const duplicate of matches.slice(1)) cancelGeneratedRow(next, duplicate, timestamp);
      const status = generatedStatus(Boolean(splitProject.finalized_at));
      Object.assign(transaction, {
        project_id: householdProjectId,
        merchant_name: String(sourceTransaction.merchant_name || "割り勘"),
        merchant_normalized: String(
          sourceTransaction.merchant_normalized
            || sourceTransaction.merchant_name
            || "割り勘",
        ).trim().toLowerCase(),
        gross_amount: amount,
        paid_amount: amount,
        discount_amount: 0,
        point_amount: 0,
        category: sourceTransaction.category ?? null,
        status,
        occurred_at: sourceTransaction.occurred_at || timestamp,
        settled_at: sourceTransaction.settled_at ?? null,
        note: sourceTransaction.note ?? null,
        entry_type: "split_expense",
        origin_project_id: splitProjectId,
        origin_transaction_id: sourceTransaction.id,
        origin_member_id: sourceMember.id,
        generated_automatically: 1,
        updated_at: timestamp,
      });
      replaceGeneratedChildren(next, transaction, targetMember, itemShares, amount, timestamp, status);
    }
  }
  for (const transaction of next.transactions) {
    if (transaction.generated_automatically !== 1 || transaction.origin_project_id !== splitProjectId) continue;
    if (!expected.has(generatedIdentity(transaction))) cancelGeneratedRow(next, transaction, timestamp);
  }
  return next;
}

function finalizeProjectState(state, projectId, options = {}) {
  const next = copyState(state, options);
  const project = requireProject(next, projectId);
  const split = splitDependency(options);
  if (options.validate !== false && split && typeof split.validateProjectTransactions === "function") {
    const validation = split.validateProjectTransactions(next, projectId);
    if (!validation.valid) {
      throw new HouseholdStateError("invalid_project_transactions", "取引の金額が一致していません", { validation });
    }
  }
  if (!project.finalized_at) {
    project.finalized_at = isoTimestamp(options);
    project.updated_at = project.finalized_at;
  }
  return project.project_type === "split" && options.synchronize !== false
    ? synchronizeSplitAllocations(next, projectId, options)
    : next;
}

function reopenProjectState(state, projectId, options = {}) {
  const next = copyState(state, options);
  const project = requireProject(next, projectId);
  project.finalized_at = null;
  project.updated_at = isoTimestamp(options);
  return project.project_type === "split" && options.synchronize !== false
    ? synchronizeSplitAllocations(next, projectId, options)
    : next;
}

function cancelGeneratedTransactionsForSource(state, sourceProjectId, sourceTransactionId, options = {}) {
  const next = copyState(state, options);
  const timestamp = isoTimestamp(options);
  for (const transaction of next.transactions) {
    if (transaction.generated_automatically !== 1) continue;
    if (transaction.origin_project_id !== sourceProjectId) continue;
    if (sourceTransactionId !== null && sourceTransactionId !== undefined
      && transaction.origin_transaction_id !== sourceTransactionId) continue;
    cancelGeneratedRow(next, transaction, timestamp);
  }
  return next;
}

function deleteSourceTransaction(state, sourceProjectId, sourceTransactionId, options = {}) {
  const next = cancelGeneratedTransactionsForSource(state, sourceProjectId, sourceTransactionId, options);
  const source = next.transactions.find(
    (row) => row.id === sourceTransactionId && row.project_id === sourceProjectId,
  );
  if (!source) return next;
  const itemIds = new Set(
    next.transaction_items.filter((row) => transactionId(row) === sourceTransactionId).map((row) => row.id),
  );
  next.transactions = next.transactions.filter((row) => row !== source);
  next.transaction_payments = next.transaction_payments.filter((row) => transactionId(row) !== sourceTransactionId);
  next.transaction_items = next.transaction_items.filter((row) => transactionId(row) !== sourceTransactionId);
  next.item_allocations = next.item_allocations.filter((row) => !itemIds.has(transactionItemId(row)));
  const timestamp = isoTimestamp(options);
  for (const transaction of next.transactions) {
    if (transaction.generated_automatically !== 1) continue;
    if (transaction.origin_project_id !== sourceProjectId) continue;
    if (transaction.origin_transaction_id !== sourceTransactionId) continue;
    transaction.origin_transaction_id = null;
    transaction.updated_at = timestamp;
  }
  next.import_records = next.import_records.map((row) => transactionId(row) === sourceTransactionId
    ? { ...row, transaction_id: null, updated_at: timestamp }
    : row);
  return next;
}

function createHouseholdHelpers(dependencies = {}) {
  const merge = (options) => ({ ...dependencies, ...(options || {}) });
  return {
    createHouseholdProject: (state, input, options) => createHouseholdProject(state, input, merge(options)),
    createManualHouseholdTransaction: (state, projectId, input, options) => createManualHouseholdTransaction(
      state,
      projectId,
      input,
      merge(options),
    ),
    linkSplitMember: (state, memberIdValue, householdProjectId, options) => linkSplitMember(
      state,
      memberIdValue,
      householdProjectId,
      merge(options),
    ),
    synchronizeSplitAllocations: (state, projectId, options) => synchronizeSplitAllocations(
      state,
      projectId,
      merge(options),
    ),
    finalizeProjectState: (state, projectId, options) => finalizeProjectState(state, projectId, merge(options)),
    reopenProjectState: (state, projectId, options) => reopenProjectState(state, projectId, merge(options)),
    cancelGeneratedTransactionsForSource: (state, sourceProjectId, sourceTransactionId, options) => (
      cancelGeneratedTransactionsForSource(state, sourceProjectId, sourceTransactionId, merge(options))
    ),
    deleteSourceTransaction: (state, sourceProjectId, sourceTransactionId, options) => deleteSourceTransaction(
      state,
      sourceProjectId,
      sourceTransactionId,
      merge(options),
    ),
  };
}

const api = {
  HouseholdStateError,
  createHouseholdHelpers,
  createHouseholdProject,
  createManualHouseholdTransaction,
  createHouseholdTransaction: createManualHouseholdTransaction,
  linkSplitMember,
  linkSplitMemberToHousehold: linkSplitMember,
  synchronizeSplitAllocations,
  syncSplitAllocations: synchronizeSplitAllocations,
  finalizeProjectState,
  finalizeProject: finalizeProjectState,
  reopenProjectState,
  reopenProject: reopenProjectState,
  cancelGeneratedTransactionsForSource,
  cancelGeneratedForSourceDeletion: cancelGeneratedTransactionsForSource,
  deleteSourceTransaction,
};

if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof globalThis !== "undefined") globalThis.WariHousehold = api;
