import { normalizeMerchant } from "./normalization.js";
import { ApiError } from "./responses.js";
import { sha256Hex } from "./crypto.js";

export const PROJECT_GRAPH_KEYS = Object.freeze([
  "projects",
  "project_members",
  "transactions",
  "transaction_payments",
  "transaction_items",
  "item_allocations",
  "import_records",
]);

const PROJECT_TYPES = new Set(["split", "household", "shared_household"]);
const PROJECT_ROLES = new Set(["owner", "editor", "member", "viewer"]);
const SHARE_ROLES = new Set(["editor", "viewer"]);
const TRANSACTION_STATUSES = new Set(["provisional", "confirmed", "cancelled", "refunded", "corrected"]);
const ENTRY_TYPES = new Set(["purchase", "split_expense", "advance", "settlement_out", "settlement_in", "refund", "adjustment"]);
const PAYMENT_METHODS = new Set(["cash", "credit_card", "paypay", "suica", "pasmo", "bank", "point", "other"]);
const PAYMENT_STATUSES = new Set(["provisional", "confirmed", "cancelled", "refunded"]);
const ITEM_TYPES = new Set(["product", "summary", "adjustment"]);

export async function listProjects(db) {
  const results = await all(
    db.prepare(`SELECT
      projects.*,
      (SELECT COUNT(*) FROM project_members WHERE project_id = projects.id AND is_active = 1) AS member_count,
      (SELECT COUNT(*) FROM transactions WHERE project_id = projects.id) AS transaction_count,
      (SELECT COUNT(*) FROM import_records WHERE project_id = projects.id) AS import_count,
      COALESCE((SELECT SUM(paid_amount) FROM transactions
        WHERE project_id = projects.id
          AND status IN ('confirmed', 'refunded', 'corrected')
          AND entry_type IN ('purchase', 'split_expense', 'refund', 'adjustment')), 0) AS confirmed_total
    FROM projects
    ORDER BY updated_at DESC, created_at DESC, id`),
  );
  return { projects: sanitizeProjects(results) };
}

export async function listProjectsForUser(db, user) {
  const results = await all(
    db.prepare(`SELECT
      projects.*,
      roles.role AS access_role,
      (SELECT COUNT(*) FROM project_members WHERE project_id = projects.id AND is_active = 1) AS member_count,
      (SELECT COUNT(*) FROM transactions WHERE project_id = projects.id) AS transaction_count,
      (SELECT COUNT(*) FROM import_records WHERE project_id = projects.id) AS import_count,
      COALESCE((SELECT SUM(paid_amount) FROM transactions
        WHERE project_id = projects.id
          AND status IN ('confirmed', 'refunded', 'corrected')
          AND entry_type IN ('purchase', 'split_expense', 'refund', 'adjustment')), 0) AS confirmed_total
    FROM projects
    JOIN project_user_roles roles
      ON roles.project_id = projects.id
     AND roles.user_id = ?
     AND roles.revoked_at IS NULL
    ORDER BY projects.updated_at DESC, projects.created_at DESC, projects.id`).bind(user.id),
  );
  return { projects: sanitizeProjects(results) };
}

export async function createProject(db, input, ownerUser = null) {
  assertObject(input);
  assertAllowed(input, ["id", "name", "project_type", "currency"]);
  const timestamp = now();
  const project = {
    id: optionalId(input, "id") || makeId("prj"),
    name: requiredString(input, "name", 1, 200),
    project_type: optionalEnum(input, "project_type", PROJECT_TYPES, "split"),
    currency: optionalCurrency(input, "currency", "JPY"),
    share_token: null,
    share_role: "editor",
    share_expires_at: null,
    finalized_at: null,
    created_at: timestamp,
    updated_at: timestamp,
  };
  await assertIdAvailable(db, "projects", project.id);
  const statements = [
    db.prepare(`INSERT INTO projects (
      id, name, project_type, currency, share_token, share_role, share_expires_at, finalized_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      project.id,
      project.name,
      project.project_type,
      project.currency,
      project.share_token,
      project.share_role,
      project.share_expires_at,
      project.finalized_at,
      project.created_at,
      project.updated_at,
    ),
  ];
  if (project.project_type === "household") {
    statements.push(
      db.prepare(`INSERT INTO project_members (
        id, project_id, display_name, role, is_active, linked_household_project_id, linked_at, created_at, updated_at
      ) VALUES (?, ?, ?, 'owner', 1, NULL, NULL, ?, ?)`).bind(makeId("mem"), project.id, "自分", timestamp, timestamp),
    );
  }
  if (ownerUser) {
    const ownerUserId = boundedString(ownerUser.id, "user_id", 1, 128, true);
    statements.push(
      db.prepare(`INSERT INTO project_user_roles (
        project_id, user_id, role, created_at, updated_at, revoked_at
      ) VALUES (?, ?, 'owner', ?, ?, NULL)`).bind(project.id, ownerUserId, timestamp, timestamp),
    );
  }
  await db.batch(statements);
  return getProjectGraph(db, project.id);
}

export async function getProjectGraph(db, projectId) {
  const id = pathId(projectId);
  const graph = emptyGraph();
  graph.projects = sanitizeProjects(await all(db.prepare("SELECT * FROM projects WHERE id = ?").bind(id)));
  if (graph.projects.length === 0) return graph;
  graph.project_members = await all(db.prepare("SELECT * FROM project_members WHERE project_id = ? ORDER BY created_at, id").bind(id));
  graph.transactions = await all(db.prepare("SELECT * FROM transactions WHERE project_id = ? ORDER BY occurred_at, created_at, id").bind(id));
  graph.transaction_payments = await all(
    db.prepare(`SELECT payments.*
      FROM transaction_payments payments
      JOIN transactions ON transactions.id = payments.transaction_id
      WHERE transactions.project_id = ?
      ORDER BY payments.occurred_at, payments.created_at, payments.id`).bind(id),
  );
  graph.transaction_items = await all(
    db.prepare(`SELECT items.*
      FROM transaction_items items
      JOIN transactions ON transactions.id = items.transaction_id
      WHERE transactions.project_id = ?
      ORDER BY items.transaction_id, items.sort_order, items.created_at, items.id`).bind(id),
  );
  graph.item_allocations = await all(
    db.prepare(`SELECT allocations.*
      FROM item_allocations allocations
      JOIN transaction_items items ON items.id = allocations.transaction_item_id
      JOIN transactions ON transactions.id = items.transaction_id
      WHERE transactions.project_id = ?
      ORDER BY allocations.transaction_item_id, allocations.created_at, allocations.id`).bind(id),
  );
  graph.import_records = await all(db.prepare("SELECT * FROM import_records WHERE project_id = ? ORDER BY created_at, id").bind(id));
  return graph;
}

export async function updateProject(db, projectId, input) {
  const id = pathId(projectId);
  assertObject(input);
  assertAllowed(input, ["name", "project_type", "currency"]);
  assertNonEmpty(input);
  await requireProject(db, id);
  const assignments = [];
  const bindings = [];
  if (has(input, "name")) addAssignment(assignments, bindings, "name", requiredString(input, "name", 1, 200));
  if (has(input, "project_type")) addAssignment(assignments, bindings, "project_type", requiredEnum(input, "project_type", PROJECT_TYPES));
  if (has(input, "currency")) addAssignment(assignments, bindings, "currency", requiredCurrency(input, "currency"));
  addAssignment(assignments, bindings, "updated_at", now());
  await db.prepare(`UPDATE projects SET ${assignments.join(", ")} WHERE id = ?`).bind(...bindings, id).run();
  return { project: sanitizeProject(await db.prepare("SELECT * FROM projects WHERE id = ?").bind(id).first()) };
}

export async function deleteProject(db, projectId) {
  const id = pathId(projectId);
  await requireProject(db, id);
  const timestamp = now();
  await db.batch([
    db.prepare(`UPDATE transactions
      SET status = 'cancelled', updated_at = ?
      WHERE origin_project_id = ? AND generated_automatically = 1 AND status <> 'cancelled'`).bind(timestamp, id),
    db.prepare("DELETE FROM projects WHERE id = ?").bind(id),
  ]);
  return { ok: true };
}

export async function createProjectShare(db, projectId, input = {}, user = null) {
  const id = pathId(projectId);
  assertObject(input);
  assertAllowed(input, ["role", "expires_at", "rotate"]);
  const project = await requireProject(db, id);
  const role = optionalEnum(input, "role", SHARE_ROLES, project.share_role || "editor");
  const expiresAtValue = has(input, "expires_at") ? nullableDate(input, "expires_at") : project.share_expires_at;
  const expiresAt = expiresAtValue === null ? null : new Date(expiresAtValue).toISOString();
  const rotate = has(input, "rotate") ? requiredBoolean(input, "rotate") : false;
  const timestamp = now();
  const statements = [];
  if (rotate) {
    statements.push(
      db.prepare(`UPDATE project_shares
        SET revoked_at = ?, updated_at = ?
        WHERE project_id = ? AND revoked_at IS NULL`).bind(timestamp, timestamp, id),
    );
  }
  let token = null;
  if (!rotate) {
    const activeShare = await db.prepare(`SELECT * FROM project_shares
      WHERE project_id = ?
        AND role = ?
        AND revoked_at IS NULL
        AND ((expires_at IS NULL AND ? IS NULL) OR expires_at = ?)
      ORDER BY created_at DESC
      LIMIT 1`).bind(id, role, expiresAt, expiresAt).first();
    if (activeShare) token = null;
  }
  token = token || makeToken();
  statements.push(
    db.prepare(`INSERT INTO project_shares (
      id, project_id, token_hash, role, expires_at, revoked_at, created_by_user_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`).bind(
      makeId("shr"),
      id,
      await sha256Hex(token),
      role,
      expiresAt,
      user?.id || null,
      timestamp,
      timestamp,
    ),
  );
  statements.push(
    db.prepare(`UPDATE projects
      SET share_token = ?, share_role = ?, share_expires_at = ?, updated_at = ?
      WHERE id = ?`).bind(rotate ? null : project.share_token, role, expiresAt, timestamp, id),
  );
  await db.batch(statements);
  return { project_id: id, token, role, expires_at: expiresAt };
}

export async function getSharedProject(db, tokenValue) {
  const token = boundedString(tokenValue, "token", 16, 256, false);
  const timestamp = now();
  const share = await db.prepare(`SELECT shares.*, projects.share_token
    FROM project_shares shares
    JOIN projects ON projects.id = shares.project_id
    WHERE shares.token_hash = ?
      AND shares.revoked_at IS NULL
      AND (shares.expires_at IS NULL OR shares.expires_at > ?)
    LIMIT 1`).bind(await sha256Hex(token), timestamp).first();
  if (share) {
    const graph = await getProjectGraph(db, share.project_id);
    return {
      ...graph,
      share: {
        project_id: share.project_id,
        token,
        role: share.role,
        expires_at: share.expires_at,
      },
    };
  }
  const project = await db.prepare(`SELECT * FROM projects
    WHERE share_token = ? AND (share_expires_at IS NULL OR share_expires_at > ?)
    LIMIT 1`).bind(token, timestamp).first();
  if (!project) throw new ApiError(404, "not_found");
  const graph = await getProjectGraph(db, project.id);
  return {
    ...graph,
    share: {
      project_id: project.id,
      token: project.share_token,
      role: project.share_role,
      expires_at: project.share_expires_at,
    },
  };
}

export async function listProjectMembers(db, projectId, includeInactive = false) {
  const id = pathId(projectId);
  await requireProject(db, id);
  const projectMembers = includeInactive
    ? await all(db.prepare("SELECT * FROM project_members WHERE project_id = ? ORDER BY is_active DESC, created_at, id").bind(id))
    : await all(db.prepare("SELECT * FROM project_members WHERE project_id = ? AND is_active = 1 ORDER BY created_at, id").bind(id));
  return { project_members: projectMembers };
}

export async function createProjectMember(db, projectId, input) {
  const id = pathId(projectId);
  assertObject(input);
  assertAllowed(input, ["id", "display_name", "role", "is_active"]);
  await requireProject(db, id);
  const timestamp = now();
  const member = {
    id: optionalId(input, "id") || makeId("mem"),
    project_id: id,
    display_name: requiredString(input, "display_name", 1, 160),
    role: optionalEnum(input, "role", PROJECT_ROLES, "member"),
    is_active: has(input, "is_active") ? requiredBooleanInteger(input, "is_active") : 1,
    linked_household_project_id: null,
    linked_at: null,
    created_at: timestamp,
    updated_at: timestamp,
  };
  await assertIdAvailable(db, "project_members", member.id);
  await db.prepare(`INSERT INTO project_members (
    id, project_id, display_name, role, is_active, linked_household_project_id, linked_at, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)`).bind(
    member.id,
    member.project_id,
    member.display_name,
    member.role,
    member.is_active,
    member.created_at,
    member.updated_at,
  ).run();
  return { project_member: member };
}

export async function updateProjectMember(db, memberId, input, expectedProjectId = null) {
  const id = pathId(memberId);
  assertObject(input);
  assertAllowed(input, ["display_name", "role", "is_active"]);
  assertNonEmpty(input);
  const member = await requireMember(db, id, expectedProjectId);
  const assignments = [];
  const bindings = [];
  if (has(input, "display_name")) addAssignment(assignments, bindings, "display_name", requiredString(input, "display_name", 1, 160));
  if (has(input, "role")) addAssignment(assignments, bindings, "role", requiredEnum(input, "role", PROJECT_ROLES));
  if (has(input, "is_active")) addAssignment(assignments, bindings, "is_active", requiredBooleanInteger(input, "is_active"));
  addAssignment(assignments, bindings, "updated_at", now());
  await db.prepare(`UPDATE project_members SET ${assignments.join(", ")} WHERE id = ? AND project_id = ?`).bind(...bindings, id, member.project_id).run();
  return { project_member: await db.prepare("SELECT * FROM project_members WHERE id = ?").bind(id).first() };
}

export async function deleteProjectMember(db, memberId, expectedProjectId = null) {
  const id = pathId(memberId);
  const member = await requireMember(db, id, expectedProjectId);
  const reference = await db.prepare(`SELECT
    (SELECT COUNT(*) FROM transaction_payments WHERE payer_member_id = ?) +
    (SELECT COUNT(*) FROM item_allocations WHERE project_member_id = ?) +
    (SELECT COUNT(*) FROM transactions WHERE origin_member_id = ?) AS reference_count`).bind(id, id, id).first();
  const referenced = Number(reference?.reference_count || 0) > 0;
  if (referenced) {
    await db.prepare("UPDATE project_members SET is_active = 0, updated_at = ? WHERE id = ? AND project_id = ?").bind(now(), id, member.project_id).run();
    return { ok: true, deactivated: true };
  }
  await db.prepare("DELETE FROM project_members WHERE id = ? AND project_id = ?").bind(id, member.project_id).run();
  return { ok: true, deactivated: false };
}

export async function updateMemberHouseholdLink(db, memberId, input) {
  const id = pathId(memberId);
  assertObject(input);
  assertAllowed(input, ["action", "household_project_id"]);
  const member = await requireMember(db, id);
  const action = optionalEnum(input, "action", new Set(["link", "unlink"]), has(input, "household_project_id") ? "link" : "unlink");
  if (action === "unlink") {
    if (has(input, "household_project_id")) throw new ApiError(400, "invalid_field_combination");
    await db.prepare(`UPDATE project_members
      SET linked_household_project_id = NULL, linked_at = NULL, updated_at = ?
      WHERE id = ? AND project_id = ?`).bind(now(), id, member.project_id).run();
  } else {
    const householdProjectId = requiredId(input, "household_project_id");
    if (householdProjectId === member.project_id) throw new ApiError(400, "invalid_household_project");
    const household = await requireProject(db, householdProjectId);
    if (household.project_type !== "household") throw new ApiError(400, "invalid_household_project");
    const timestamp = now();
    await db.prepare(`UPDATE project_members
      SET linked_household_project_id = ?, linked_at = ?, updated_at = ?
      WHERE id = ? AND project_id = ?`).bind(householdProjectId, timestamp, timestamp, id, member.project_id).run();
  }
  return { project_member: await db.prepare("SELECT * FROM project_members WHERE id = ?").bind(id).first() };
}

export async function listTransactions(db, projectId, searchParams = new URLSearchParams()) {
  const id = pathId(projectId);
  await requireProject(db, id);
  const filters = transactionFilters(searchParams);
  const where = ["transactions.project_id = ?"];
  const bindings = [id];
  if (filters.statuses.length > 0) {
    where.push(`transactions.status IN (${filters.statuses.map(() => "?").join(", ")})`);
    bindings.push(...filters.statuses);
  }
  if (filters.entryTypes.length > 0) {
    where.push(`transactions.entry_type IN (${filters.entryTypes.map(() => "?").join(", ")})`);
    bindings.push(...filters.entryTypes);
  }
  if (filters.category !== null) {
    where.push("transactions.category = ?");
    bindings.push(filters.category);
  }
  if (filters.dateFrom !== null) {
    where.push("transactions.occurred_at >= ?");
    bindings.push(filters.dateFrom);
  }
  if (filters.dateTo !== null) {
    where.push("transactions.occurred_at <= ?");
    bindings.push(filters.dateTo);
  }
  if (filters.minimumAmount !== null) {
    where.push("transactions.paid_amount >= ?");
    bindings.push(filters.minimumAmount);
  }
  if (filters.maximumAmount !== null) {
    where.push("transactions.paid_amount <= ?");
    bindings.push(filters.maximumAmount);
  }
  if (filters.query !== null) {
    where.push("(transactions.merchant_name LIKE ? ESCAPE '\\' OR transactions.note LIKE ? ESCAPE '\\')");
    const pattern = `%${escapeLike(filters.query)}%`;
    bindings.push(pattern, pattern);
  }
  if (filters.memberId !== null) {
    where.push(`(
      EXISTS (SELECT 1 FROM transaction_payments payments WHERE payments.transaction_id = transactions.id AND payments.payer_member_id = ?)
      OR EXISTS (
        SELECT 1 FROM transaction_items items
        JOIN item_allocations allocations ON allocations.transaction_item_id = items.id
        WHERE items.transaction_id = transactions.id AND allocations.project_member_id = ?
      )
    )`);
    bindings.push(filters.memberId, filters.memberId);
  }
  const whereSql = where.join(" AND ");
  const totalRow = await db.prepare(`SELECT COUNT(*) AS total FROM transactions WHERE ${whereSql}`).bind(...bindings).first();
  const transactions = await all(
    db.prepare(`SELECT transactions.*
      FROM transactions
      WHERE ${whereSql}
      ORDER BY transactions.occurred_at DESC, transactions.id DESC
      LIMIT ? OFFSET ?`).bind(...bindings, filters.limit, filters.offset),
  );
  const total = Number(totalRow?.total || 0);
  const nextOffset = filters.offset + transactions.length;
  return {
    transactions,
    page: Math.floor(filters.offset / filters.limit) + 1,
    limit: filters.limit,
    offset: filters.offset,
    total,
    has_more: nextOffset < total,
    next_cursor: nextOffset < total ? String(nextOffset) : null,
  };
}

export async function createTransaction(db, projectId, input) {
  const id = pathId(projectId);
  assertObject(input);
  assertAllowed(input, [
    "id",
    "merchant_name",
    "gross_amount",
    "paid_amount",
    "discount_amount",
    "point_amount",
    "category",
    "status",
    "occurred_at",
    "settled_at",
    "note",
    "entry_type",
  ]);
  const project = await requireWritableProject(db, id);
  const timestamp = now();
  const transactionId = optionalId(input, "id") || makeId("txn");
  await assertIdAvailable(db, "transactions", transactionId);
  if (!has(input, "gross_amount") && !has(input, "paid_amount")) throw new ApiError(400, "missing_field", { field: "paid_amount" });
  const grossAmount = has(input, "gross_amount") ? requiredInteger(input, "gross_amount") : requiredInteger(input, "paid_amount");
  const paidAmount = has(input, "paid_amount") ? requiredInteger(input, "paid_amount") : grossAmount;
  const merchantName = requiredString(input, "merchant_name", 1, 300);
  const transaction = {
    id: transactionId,
    project_id: project.id,
    merchant_name: merchantName,
    merchant_normalized: normalizeMerchant(merchantName).slice(0, 300),
    gross_amount: grossAmount,
    paid_amount: paidAmount,
    discount_amount: optionalNonNegativeInteger(input, "discount_amount", 0),
    point_amount: optionalNonNegativeInteger(input, "point_amount", 0),
    category: optionalNullableString(input, "category", 120, null),
    status: optionalEnum(input, "status", TRANSACTION_STATUSES, "confirmed"),
    occurred_at: requiredDate(input, "occurred_at"),
    settled_at: optionalNullableDate(input, "settled_at", null),
    note: optionalNullableString(input, "note", 4_000, null),
    entry_type: optionalEnum(input, "entry_type", ENTRY_TYPES, "purchase"),
    created_at: timestamp,
    updated_at: timestamp,
  };
  await db.prepare(`INSERT INTO transactions (
    id, project_id, merchant_name, merchant_normalized, gross_amount, paid_amount, discount_amount, point_amount,
    category, status, occurred_at, settled_at, note, entry_type, origin_project_id, origin_transaction_id,
    origin_member_id, generated_automatically, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 0, ?, ?)`).bind(
    transaction.id,
    transaction.project_id,
    transaction.merchant_name,
    transaction.merchant_normalized,
    transaction.gross_amount,
    transaction.paid_amount,
    transaction.discount_amount,
    transaction.point_amount,
    transaction.category,
    transaction.status,
    transaction.occurred_at,
    transaction.settled_at,
    transaction.note,
    transaction.entry_type,
    transaction.created_at,
    transaction.updated_at,
  ).run();
  return { transaction };
}

export async function getTransactionGraph(db, transactionId) {
  const id = pathId(transactionId);
  const transaction = await db.prepare("SELECT * FROM transactions WHERE id = ?").bind(id).first();
  if (!transaction) throw new ApiError(404, "not_found");
  const graph = emptyGraph();
  graph.projects = await all(db.prepare("SELECT * FROM projects WHERE id = ?").bind(transaction.project_id));
  graph.project_members = await all(db.prepare("SELECT * FROM project_members WHERE project_id = ? ORDER BY created_at, id").bind(transaction.project_id));
  graph.transactions = [transaction];
  graph.transaction_payments = await all(db.prepare("SELECT * FROM transaction_payments WHERE transaction_id = ? ORDER BY occurred_at, created_at, id").bind(id));
  graph.transaction_items = await all(db.prepare("SELECT * FROM transaction_items WHERE transaction_id = ? ORDER BY sort_order, created_at, id").bind(id));
  graph.item_allocations = await all(
    db.prepare(`SELECT allocations.*
      FROM item_allocations allocations
      JOIN transaction_items items ON items.id = allocations.transaction_item_id
      WHERE items.transaction_id = ?
      ORDER BY allocations.transaction_item_id, allocations.created_at, allocations.id`).bind(id),
  );
  graph.import_records = await all(db.prepare("SELECT * FROM import_records WHERE transaction_id = ? ORDER BY created_at, id").bind(id));
  return graph;
}

export async function updateTransaction(db, transactionId, input) {
  const id = pathId(transactionId);
  assertObject(input);
  assertAllowed(input, [
    "merchant_name",
    "gross_amount",
    "paid_amount",
    "discount_amount",
    "point_amount",
    "category",
    "status",
    "occurred_at",
    "settled_at",
    "note",
    "entry_type",
  ]);
  assertNonEmpty(input);
  const transaction = await requireMutableTransaction(db, id);
  await requireWritableProject(db, transaction.project_id);
  const assignments = [];
  const bindings = [];
  if (has(input, "merchant_name")) {
    const merchantName = requiredString(input, "merchant_name", 1, 300);
    addAssignment(assignments, bindings, "merchant_name", merchantName);
    addAssignment(assignments, bindings, "merchant_normalized", normalizeMerchant(merchantName).slice(0, 300));
  }
  if (has(input, "gross_amount")) addAssignment(assignments, bindings, "gross_amount", requiredInteger(input, "gross_amount"));
  if (has(input, "paid_amount")) addAssignment(assignments, bindings, "paid_amount", requiredInteger(input, "paid_amount"));
  if (has(input, "discount_amount")) addAssignment(assignments, bindings, "discount_amount", requiredNonNegativeInteger(input, "discount_amount"));
  if (has(input, "point_amount")) addAssignment(assignments, bindings, "point_amount", requiredNonNegativeInteger(input, "point_amount"));
  if (has(input, "category")) addAssignment(assignments, bindings, "category", nullableString(input, "category", 120));
  if (has(input, "status")) addAssignment(assignments, bindings, "status", requiredEnum(input, "status", TRANSACTION_STATUSES));
  if (has(input, "occurred_at")) addAssignment(assignments, bindings, "occurred_at", requiredDate(input, "occurred_at"));
  if (has(input, "settled_at")) addAssignment(assignments, bindings, "settled_at", nullableDate(input, "settled_at"));
  if (has(input, "note")) addAssignment(assignments, bindings, "note", nullableString(input, "note", 4_000));
  if (has(input, "entry_type")) addAssignment(assignments, bindings, "entry_type", requiredEnum(input, "entry_type", ENTRY_TYPES));
  addAssignment(assignments, bindings, "updated_at", now());
  await db.prepare(`UPDATE transactions SET ${assignments.join(", ")} WHERE id = ? AND project_id = ?`).bind(...bindings, id, transaction.project_id).run();
  return { transaction: await db.prepare("SELECT * FROM transactions WHERE id = ?").bind(id).first() };
}

export async function deleteTransaction(db, transactionId) {
  const id = pathId(transactionId);
  const transaction = await requireMutableTransaction(db, id);
  await requireWritableProject(db, transaction.project_id);
  await db.prepare("DELETE FROM transactions WHERE id = ? AND project_id = ?").bind(id, transaction.project_id).run();
  return { ok: true, project_id: transaction.project_id };
}

export async function createTransactionPayment(db, transactionId, input) {
  const transaction = await requireMutableTransaction(db, pathId(transactionId));
  await requireWritableProject(db, transaction.project_id);
  assertObject(input);
  assertAllowed(input, [
    "id",
    "payer_member_id",
    "amount",
    "payment_method",
    "provider",
    "account_label",
    "external_payment_id",
    "payment_status",
    "occurred_at",
  ]);
  const timestamp = now();
  const payment = {
    id: optionalId(input, "id") || makeId("pay"),
    transaction_id: transaction.id,
    payer_member_id: has(input, "payer_member_id") ? nullableId(input, "payer_member_id") : null,
    amount: requiredInteger(input, "amount"),
    payment_method: optionalEnum(input, "payment_method", PAYMENT_METHODS, "other"),
    provider: optionalNullableString(input, "provider", 160, null),
    account_label: optionalNullableString(input, "account_label", 160, null),
    external_payment_id: optionalNullableString(input, "external_payment_id", 300, null),
    payment_status: optionalEnum(input, "payment_status", PAYMENT_STATUSES, "confirmed"),
    occurred_at: has(input, "occurred_at") ? requiredDate(input, "occurred_at") : transaction.occurred_at,
    created_at: timestamp,
    updated_at: timestamp,
  };
  await assertIdAvailable(db, "transaction_payments", payment.id);
  if (payment.payer_member_id !== null) await requireActiveMember(db, payment.payer_member_id, transaction.project_id);
  if (payment.external_payment_id !== null) await assertExternalPaymentAvailable(db, payment.external_payment_id, null);
  await db.prepare(`INSERT INTO transaction_payments (
    id, transaction_id, payer_member_id, amount, payment_method, provider, account_label, external_payment_id,
    payment_status, occurred_at, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
    payment.id,
    payment.transaction_id,
    payment.payer_member_id,
    payment.amount,
    payment.payment_method,
    payment.provider,
    payment.account_label,
    payment.external_payment_id,
    payment.payment_status,
    payment.occurred_at,
    payment.created_at,
    payment.updated_at,
  ).run();
  return { transaction_payment: payment, project_id: transaction.project_id };
}

export async function updateTransactionPayment(db, paymentId, input) {
  const id = pathId(paymentId);
  assertObject(input);
  assertAllowed(input, [
    "payer_member_id",
    "amount",
    "payment_method",
    "provider",
    "account_label",
    "external_payment_id",
    "payment_status",
    "occurred_at",
  ]);
  assertNonEmpty(input);
  const context = await requirePayment(db, id);
  if (context.generated_automatically) throw new ApiError(409, "generated_record_read_only");
  await requireWritableProject(db, context.project_id);
  const assignments = [];
  const bindings = [];
  if (has(input, "payer_member_id")) {
    const memberId = nullableId(input, "payer_member_id");
    if (memberId !== null) await requireActiveMember(db, memberId, context.project_id);
    addAssignment(assignments, bindings, "payer_member_id", memberId);
  }
  if (has(input, "amount")) addAssignment(assignments, bindings, "amount", requiredInteger(input, "amount"));
  if (has(input, "payment_method")) addAssignment(assignments, bindings, "payment_method", requiredEnum(input, "payment_method", PAYMENT_METHODS));
  if (has(input, "provider")) addAssignment(assignments, bindings, "provider", nullableString(input, "provider", 160));
  if (has(input, "account_label")) addAssignment(assignments, bindings, "account_label", nullableString(input, "account_label", 160));
  if (has(input, "external_payment_id")) {
    const externalId = nullableString(input, "external_payment_id", 300);
    if (externalId !== null) await assertExternalPaymentAvailable(db, externalId, id);
    addAssignment(assignments, bindings, "external_payment_id", externalId);
  }
  if (has(input, "payment_status")) addAssignment(assignments, bindings, "payment_status", requiredEnum(input, "payment_status", PAYMENT_STATUSES));
  if (has(input, "occurred_at")) addAssignment(assignments, bindings, "occurred_at", requiredDate(input, "occurred_at"));
  addAssignment(assignments, bindings, "updated_at", now());
  await db.prepare(`UPDATE transaction_payments SET ${assignments.join(", ")} WHERE id = ? AND transaction_id = ?`).bind(...bindings, id, context.transaction_id).run();
  return {
    transaction_payment: await db.prepare("SELECT * FROM transaction_payments WHERE id = ?").bind(id).first(),
    project_id: context.project_id,
  };
}

export async function deleteTransactionPayment(db, paymentId) {
  const id = pathId(paymentId);
  const context = await requirePayment(db, id);
  if (context.generated_automatically) throw new ApiError(409, "generated_record_read_only");
  await requireWritableProject(db, context.project_id);
  await db.prepare("DELETE FROM transaction_payments WHERE id = ? AND transaction_id = ?").bind(id, context.transaction_id).run();
  return { ok: true, project_id: context.project_id };
}

export async function createTransactionItem(db, transactionId, input) {
  const transaction = await requireMutableTransaction(db, pathId(transactionId));
  await requireWritableProject(db, transaction.project_id);
  assertObject(input);
  assertAllowed(input, ["id", "name", "amount", "quantity", "item_type", "category", "sort_order", "is_hidden"]);
  const timestamp = now();
  const nextSort = has(input, "sort_order") ? requiredSortOrder(input, "sort_order") : await nextItemSortOrder(db, transaction.id);
  const item = {
    id: optionalId(input, "id") || makeId("itm"),
    transaction_id: transaction.id,
    name: requiredString(input, "name", 1, 300),
    amount: requiredInteger(input, "amount"),
    quantity: optionalPositiveNumber(input, "quantity", 1),
    item_type: optionalEnum(input, "item_type", ITEM_TYPES, "product"),
    category: optionalNullableString(input, "category", 120, null),
    sort_order: nextSort,
    is_hidden: has(input, "is_hidden") ? requiredBooleanInteger(input, "is_hidden") : 0,
    created_at: timestamp,
    updated_at: timestamp,
  };
  await assertIdAvailable(db, "transaction_items", item.id);
  await db.prepare(`INSERT INTO transaction_items (
    id, transaction_id, name, amount, quantity, item_type, category, sort_order, is_hidden, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
    item.id,
    item.transaction_id,
    item.name,
    item.amount,
    item.quantity,
    item.item_type,
    item.category,
    item.sort_order,
    item.is_hidden,
    item.created_at,
    item.updated_at,
  ).run();
  return { transaction_item: item, project_id: transaction.project_id };
}

export async function updateTransactionItem(db, itemId, input) {
  const id = pathId(itemId);
  assertObject(input);
  assertAllowed(input, ["name", "amount", "quantity", "item_type", "category", "sort_order", "is_hidden"]);
  assertNonEmpty(input);
  const context = await requireItem(db, id);
  if (context.generated_automatically) throw new ApiError(409, "generated_record_read_only");
  await requireWritableProject(db, context.project_id);
  const assignments = [];
  const bindings = [];
  if (has(input, "name")) addAssignment(assignments, bindings, "name", requiredString(input, "name", 1, 300));
  if (has(input, "amount")) addAssignment(assignments, bindings, "amount", requiredInteger(input, "amount"));
  if (has(input, "quantity")) addAssignment(assignments, bindings, "quantity", requiredPositiveNumber(input, "quantity"));
  if (has(input, "item_type")) addAssignment(assignments, bindings, "item_type", requiredEnum(input, "item_type", ITEM_TYPES));
  if (has(input, "category")) addAssignment(assignments, bindings, "category", nullableString(input, "category", 120));
  if (has(input, "sort_order")) addAssignment(assignments, bindings, "sort_order", requiredSortOrder(input, "sort_order"));
  if (has(input, "is_hidden")) addAssignment(assignments, bindings, "is_hidden", requiredBooleanInteger(input, "is_hidden"));
  addAssignment(assignments, bindings, "updated_at", now());
  await db.prepare(`UPDATE transaction_items SET ${assignments.join(", ")} WHERE id = ? AND transaction_id = ?`).bind(...bindings, id, context.transaction_id).run();
  return {
    transaction_item: await db.prepare("SELECT * FROM transaction_items WHERE id = ?").bind(id).first(),
    project_id: context.project_id,
  };
}

export async function deleteTransactionItem(db, itemId) {
  const id = pathId(itemId);
  const context = await requireItem(db, id);
  if (context.generated_automatically) throw new ApiError(409, "generated_record_read_only");
  await requireWritableProject(db, context.project_id);
  await db.prepare("DELETE FROM transaction_items WHERE id = ? AND transaction_id = ?").bind(id, context.transaction_id).run();
  return { ok: true, project_id: context.project_id, transaction_id: context.transaction_id };
}

export async function replaceItemAllocations(db, itemId, input) {
  const id = pathId(itemId);
  const context = await requireItem(db, id);
  if (context.generated_automatically) throw new ApiError(409, "generated_record_read_only");
  await requireWritableProject(db, context.project_id);
  const values = allocationInput(input);
  const timestamp = now();
  const members = new Set();
  const allocationIds = new Set();
  const existingRows = await all(db.prepare("SELECT * FROM item_allocations WHERE transaction_item_id = ?").bind(id));
  const existingByMember = new Map(existingRows.map((row) => [row.project_member_id, row]));
  const allocations = [];
  for (const value of values) {
    assertObject(value);
    assertAllowed(value, ["id", "project_member_id", "allocated_amount"]);
    const memberId = requiredId(value, "project_member_id");
    if (members.has(memberId)) throw new ApiError(400, "duplicate_allocation_member", { field: "project_member_id" });
    members.add(memberId);
    await requireActiveMember(db, memberId, context.project_id);
    const current = existingByMember.get(memberId);
    const allocationId = optionalId(value, "id") || current?.id || makeId("alc");
    if (allocationIds.has(allocationId)) throw new ApiError(400, "duplicate_allocation_id", { field: "id" });
    allocationIds.add(allocationId);
    if (allocationId !== current?.id) await assertIdAvailable(db, "item_allocations", allocationId);
    allocations.push({
      id: allocationId,
      transaction_item_id: id,
      project_member_id: memberId,
      allocated_amount: requiredInteger(value, "allocated_amount"),
      created_at: current?.created_at || timestamp,
      updated_at: timestamp,
    });
  }
  const statements = [db.prepare("DELETE FROM item_allocations WHERE transaction_item_id = ?").bind(id)];
  for (const allocation of allocations) {
    statements.push(
      db.prepare(`INSERT INTO item_allocations (
        id, transaction_item_id, project_member_id, allocated_amount, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)`).bind(
        allocation.id,
        allocation.transaction_item_id,
        allocation.project_member_id,
        allocation.allocated_amount,
        allocation.created_at,
        allocation.updated_at,
      ),
    );
  }
  await db.batch(statements);
  return { item_allocations: allocations, project_id: context.project_id, transaction_id: context.transaction_id };
}

export async function getProjectSummaries(db, projectId) {
  const id = pathId(projectId);
  await requireProject(db, id);
  const totals = await db.prepare(`SELECT
    COUNT(CASE
      WHEN status IN ('confirmed', 'refunded', 'corrected')
        AND entry_type IN ('purchase', 'split_expense', 'refund', 'adjustment')
      THEN 1 END) AS transaction_count,
    COALESCE(SUM(CASE
      WHEN status IN ('confirmed', 'refunded', 'corrected')
        AND entry_type IN ('purchase', 'split_expense', 'refund', 'adjustment')
      THEN paid_amount ELSE 0 END), 0) AS confirmed_total,
    COALESCE(SUM(CASE
      WHEN status = 'provisional'
        AND entry_type IN ('purchase', 'split_expense', 'refund', 'adjustment')
      THEN paid_amount ELSE 0 END), 0) AS provisional_total,
    COALESCE(SUM(CASE WHEN status IN ('cancelled', 'refunded') THEN paid_amount ELSE 0 END), 0) AS excluded_total
    FROM transactions
    WHERE project_id = ?`).bind(id).first();
  const byCategory = await all(
    db.prepare(`SELECT COALESCE(category, '') AS category, COUNT(*) AS transaction_count, COALESCE(SUM(paid_amount), 0) AS total_amount
      FROM transactions
      WHERE project_id = ?
        AND status IN ('confirmed', 'refunded', 'corrected')
        AND entry_type IN ('purchase', 'split_expense', 'refund', 'adjustment')
      GROUP BY COALESCE(category, '')
      ORDER BY total_amount DESC, category`).bind(id),
  );
  const byMonth = await all(
    db.prepare(`SELECT substr(occurred_at, 1, 7) AS month, COUNT(*) AS transaction_count, COALESCE(SUM(paid_amount), 0) AS total_amount
      FROM transactions
      WHERE project_id = ?
        AND status IN ('confirmed', 'refunded', 'corrected')
        AND entry_type IN ('purchase', 'split_expense', 'refund', 'adjustment')
      GROUP BY substr(occurred_at, 1, 7)
      ORDER BY month DESC`).bind(id),
  );
  const byPaymentMethod = await all(
    db.prepare(`SELECT payments.payment_method, COUNT(DISTINCT transactions.id) AS transaction_count,
        COALESCE(SUM(payments.amount), 0) AS total_amount
      FROM transaction_payments payments
      JOIN transactions ON transactions.id = payments.transaction_id
      WHERE transactions.project_id = ?
        AND transactions.status IN ('confirmed', 'refunded', 'corrected')
        AND transactions.entry_type IN ('purchase', 'split_expense', 'refund', 'adjustment')
        AND payments.payment_status NOT IN ('cancelled', 'refunded')
      GROUP BY payments.payment_method
      ORDER BY total_amount DESC, payments.payment_method`).bind(id),
  );
  const memberBalances = await all(
    db.prepare(`WITH paid AS (
        SELECT payments.payer_member_id AS member_id, COALESCE(SUM(payments.amount), 0) AS amount
        FROM transaction_payments payments
        JOIN transactions ON transactions.id = payments.transaction_id
        WHERE transactions.project_id = ? AND transactions.status = 'confirmed'
          AND payments.payment_status NOT IN ('cancelled', 'refunded')
        GROUP BY payments.payer_member_id
      ), allocated AS (
        SELECT allocations.project_member_id AS member_id, COALESCE(SUM(allocations.allocated_amount), 0) AS amount
        FROM item_allocations allocations
        JOIN transaction_items items ON items.id = allocations.transaction_item_id
        JOIN transactions ON transactions.id = items.transaction_id
        WHERE transactions.project_id = ? AND transactions.status = 'confirmed'
        GROUP BY allocations.project_member_id
      )
      SELECT members.id AS project_member_id, members.display_name, members.is_active,
        COALESCE(paid.amount, 0) AS paid_amount,
        COALESCE(allocated.amount, 0) AS allocated_amount,
        COALESCE(paid.amount, 0) - COALESCE(allocated.amount, 0) AS balance
      FROM project_members members
      LEFT JOIN paid ON paid.member_id = members.id
      LEFT JOIN allocated ON allocated.member_id = members.id
      WHERE members.project_id = ?
      ORDER BY members.created_at, members.id`).bind(id, id, id),
  );
  const imports = await all(
    db.prepare(`SELECT source_status, COUNT(*) AS record_count
      FROM import_records
      WHERE project_id = ?
      GROUP BY source_status
      ORDER BY source_status`).bind(id),
  );
  return {
    project_id: id,
    summary: {
      transaction_count: Number(totals?.transaction_count || 0),
      confirmed_total: Number(totals?.confirmed_total || 0),
      provisional_total: Number(totals?.provisional_total || 0),
      excluded_total: Number(totals?.excluded_total || 0),
    },
    by_category: byCategory,
    by_month: byMonth,
    by_payment_method: byPaymentMethod,
    member_balances: memberBalances,
    import_statuses: imports,
  };
}

export async function markProjectFinalized(db, projectId, timestamp = now()) {
  const id = pathId(projectId);
  await requireProject(db, id);
  await db.prepare("UPDATE projects SET finalized_at = ?, updated_at = ? WHERE id = ?").bind(timestamp, timestamp, id).run();
  return { project: sanitizeProject(await db.prepare("SELECT * FROM projects WHERE id = ?").bind(id).first()) };
}

export async function markProjectReopened(db, projectId) {
  const id = pathId(projectId);
  await requireProject(db, id);
  const timestamp = now();
  await db.batch([
    db.prepare("UPDATE projects SET finalized_at = NULL, updated_at = ? WHERE id = ?").bind(timestamp, id),
    db.prepare(`UPDATE transactions
      SET status = 'cancelled', updated_at = ?
      WHERE origin_project_id = ? AND generated_automatically = 1 AND status <> 'cancelled'`).bind(timestamp, id),
  ]);
  return { project: sanitizeProject(await db.prepare("SELECT * FROM projects WHERE id = ?").bind(id).first()) };
}

export async function requireProject(db, projectId) {
  const id = pathId(projectId);
  const project = await db.prepare("SELECT * FROM projects WHERE id = ?").bind(id).first();
  if (!project) throw new ApiError(404, "not_found");
  return project;
}

export function makeId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function emptyGraph() {
  return Object.fromEntries(PROJECT_GRAPH_KEYS.map((key) => [key, []]));
}

function sanitizeProject(project) {
  if (!project) return project;
  const { share_token, ...safeProject } = project;
  return safeProject;
}

function sanitizeProjects(projects) {
  return projects.map((project) => sanitizeProject(project));
}

async function requireWritableProject(db, projectId) {
  const project = await requireProject(db, projectId);
  if (project.finalized_at !== null && project.finalized_at !== undefined) throw new ApiError(409, "project_finalized");
  return project;
}

async function requireMember(db, memberId, expectedProjectId = null) {
  const id = pathId(memberId);
  const member = await db.prepare("SELECT * FROM project_members WHERE id = ?").bind(id).first();
  if (!member || (expectedProjectId !== null && member.project_id !== pathId(expectedProjectId))) throw new ApiError(404, "not_found");
  return member;
}

async function requireActiveMember(db, memberId, projectId) {
  const member = await requireMember(db, memberId, projectId);
  if (Number(member.is_active) !== 1) throw new ApiError(409, "member_inactive");
  return member;
}

async function requireMutableTransaction(db, transactionId) {
  const transaction = await db.prepare("SELECT * FROM transactions WHERE id = ?").bind(transactionId).first();
  if (!transaction) throw new ApiError(404, "not_found");
  if (Number(transaction.generated_automatically) === 1) throw new ApiError(409, "generated_record_read_only");
  return transaction;
}

async function requirePayment(db, paymentId) {
  const row = await db.prepare(`SELECT payments.*, transactions.project_id, transactions.generated_automatically
    FROM transaction_payments payments
    JOIN transactions ON transactions.id = payments.transaction_id
    WHERE payments.id = ?`).bind(paymentId).first();
  if (!row) throw new ApiError(404, "not_found");
  return row;
}

async function requireItem(db, itemId) {
  const row = await db.prepare(`SELECT items.*, transactions.project_id, transactions.generated_automatically
    FROM transaction_items items
    JOIN transactions ON transactions.id = items.transaction_id
    WHERE items.id = ?`).bind(itemId).first();
  if (!row) throw new ApiError(404, "not_found");
  return row;
}

async function assertIdAvailable(db, table, id) {
  const allowedTables = new Set(["projects", "project_members", "transactions", "transaction_payments", "transaction_items", "item_allocations"]);
  if (!allowedTables.has(table)) throw new ApiError(500, "server_error");
  const row = await db.prepare(`SELECT id FROM ${table} WHERE id = ?`).bind(id).first();
  if (row) throw new ApiError(409, "id_conflict", { field: "id" });
}

async function assertExternalPaymentAvailable(db, externalPaymentId, currentId) {
  const row = await db.prepare("SELECT id FROM transaction_payments WHERE external_payment_id = ?").bind(externalPaymentId).first();
  if (row && row.id !== currentId) throw new ApiError(409, "external_payment_id_conflict", { field: "external_payment_id" });
}

async function nextItemSortOrder(db, transactionId) {
  const row = await db.prepare("SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_sort FROM transaction_items WHERE transaction_id = ?").bind(transactionId).first();
  return Number(row?.next_sort || 0);
}

async function all(statement) {
  const result = await statement.all();
  return Array.isArray(result?.results) ? result.results : [];
}

function allocationInput(input) {
  if (Array.isArray(input)) return input;
  assertObject(input);
  assertAllowed(input, ["allocations"]);
  if (!Array.isArray(input.allocations)) throw new ApiError(400, "invalid_field", { field: "allocations" });
  if (input.allocations.length > 500) throw new ApiError(400, "too_many_allocations", { field: "allocations" });
  return input.allocations;
}

function transactionFilters(searchParams) {
  const allowed = new Set([
    "page",
    "limit",
    "cursor",
    "offset",
    "status",
    "entry_type",
    "category",
    "date_from",
    "date_to",
    "from",
    "to",
    "min_amount",
    "max_amount",
    "q",
    "member_id",
  ]);
  for (const key of searchParams.keys()) {
    if (!allowed.has(key)) throw new ApiError(400, "invalid_query_parameter", { field: key });
  }
  const limit = queryInteger(searchParams.get("limit"), "limit", 1, 100, 50);
  const page = queryInteger(searchParams.get("page"), "page", 1, 1_000_000, 1);
  const explicitOffset = queryInteger(searchParams.get("offset"), "offset", 0, 100_000_000, null);
  const cursorOffset = queryInteger(searchParams.get("cursor"), "cursor", 0, 100_000_000, null);
  const offset = cursorOffset ?? explicitOffset ?? (page - 1) * limit;
  const statuses = queryEnums(searchParams.get("status"), "status", TRANSACTION_STATUSES);
  const entryTypes = queryEnums(searchParams.get("entry_type"), "entry_type", ENTRY_TYPES);
  const category = queryString(searchParams.get("category"), "category", 120);
  const dateFrom = queryDate(searchParams.get("date_from") ?? searchParams.get("from"), "date_from");
  const dateTo = queryDate(searchParams.get("date_to") ?? searchParams.get("to"), "date_to");
  const minimumAmount = querySafeInteger(searchParams.get("min_amount"), "min_amount");
  const maximumAmount = querySafeInteger(searchParams.get("max_amount"), "max_amount");
  if (minimumAmount !== null && maximumAmount !== null && minimumAmount > maximumAmount) {
    throw new ApiError(400, "invalid_amount_range");
  }
  return {
    limit,
    offset,
    statuses,
    entryTypes,
    category,
    dateFrom,
    dateTo,
    minimumAmount,
    maximumAmount,
    query: queryString(searchParams.get("q"), "q", 200),
    memberId: searchParams.get("member_id") === null ? null : boundedString(searchParams.get("member_id"), "member_id", 1, 128, true),
  };
}

function queryInteger(value, field, minimum, maximum, fallback) {
  if (value === null || value === "") return fallback;
  if (!/^\d+$/.test(value)) throw new ApiError(400, "invalid_query_parameter", { field });
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new ApiError(400, "invalid_query_parameter", { field });
  return parsed;
}

function querySafeInteger(value, field) {
  if (value === null || value === "") return null;
  if (!/^-?\d+$/.test(value)) throw new ApiError(400, "invalid_query_parameter", { field });
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new ApiError(400, "invalid_query_parameter", { field });
  return parsed;
}

function queryEnums(value, field, allowed) {
  if (value === null || value.trim() === "") return [];
  const values = [...new Set(value.split(",").map((entry) => entry.trim()).filter(Boolean))];
  if (values.length > 10 || values.some((entry) => !allowed.has(entry))) throw new ApiError(400, "invalid_query_parameter", { field });
  return values;
}

function queryString(value, field, maximum) {
  if (value === null || value === "") return null;
  return boundedString(value, field, 1, maximum, true);
}

function queryDate(value, field) {
  if (value === null || value === "") return null;
  const result = boundedString(value, field, 1, 64, true);
  if (!Number.isFinite(Date.parse(result))) throw new ApiError(400, "invalid_query_parameter", { field });
  return result;
}

function escapeLike(value) {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function makeToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function now() {
  return new Date().toISOString();
}

function addAssignment(assignments, bindings, column, value) {
  assignments.push(`${column} = ?`);
  bindings.push(value);
}

function assertObject(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ApiError(400, "invalid_json_body");
}

function assertAllowed(input, fields) {
  const allowed = new Set(fields);
  const unknown = Object.keys(input).find((field) => !allowed.has(field));
  if (unknown) throw new ApiError(400, "unknown_field", { field: unknown });
}

function assertNonEmpty(input) {
  if (Object.keys(input).length === 0) throw new ApiError(400, "empty_update");
}

function has(input, field) {
  return Object.prototype.hasOwnProperty.call(input, field);
}

function requiredString(input, field, minimum, maximum) {
  if (!has(input, field)) throw new ApiError(400, "missing_field", { field });
  return boundedString(input[field], field, minimum, maximum, true);
}

function boundedString(value, field, minimum, maximum, trim) {
  if (typeof value !== "string") throw new ApiError(400, "invalid_field", { field });
  const result = trim ? value.trim() : value;
  if (result.length < minimum || result.length > maximum) throw new ApiError(400, "invalid_field", { field });
  return result;
}

function nullableString(input, field, maximum) {
  if (input[field] === null) return null;
  return boundedString(input[field], field, 1, maximum, true);
}

function optionalNullableString(input, field, maximum, fallback) {
  return has(input, field) ? nullableString(input, field, maximum) : fallback;
}

function requiredId(input, field) {
  if (!has(input, field)) throw new ApiError(400, "missing_field", { field });
  return boundedString(input[field], field, 1, 128, true);
}

function optionalId(input, field) {
  return has(input, field) ? requiredId(input, field) : null;
}

function nullableId(input, field) {
  return input[field] === null ? null : requiredId(input, field);
}

function pathId(value) {
  return boundedString(value, "id", 1, 128, true);
}

function requiredInteger(input, field) {
  if (!has(input, field) || !Number.isSafeInteger(input[field])) throw new ApiError(400, "invalid_integer", { field });
  return input[field];
}

function requiredNonNegativeInteger(input, field) {
  const value = requiredInteger(input, field);
  if (value < 0) throw new ApiError(400, "invalid_integer", { field });
  return value;
}

function optionalNonNegativeInteger(input, field, fallback) {
  return has(input, field) ? requiredNonNegativeInteger(input, field) : fallback;
}

function requiredPositiveNumber(input, field) {
  if (!has(input, field) || typeof input[field] !== "number" || !Number.isFinite(input[field]) || input[field] <= 0 || input[field] > 1_000_000_000) {
    throw new ApiError(400, "invalid_number", { field });
  }
  return input[field];
}

function optionalPositiveNumber(input, field, fallback) {
  return has(input, field) ? requiredPositiveNumber(input, field) : fallback;
}

function requiredSortOrder(input, field) {
  const value = requiredNonNegativeInteger(input, field);
  if (value > 1_000_000) throw new ApiError(400, "invalid_integer", { field });
  return value;
}

function requiredBoolean(input, field) {
  if (!has(input, field) || typeof input[field] !== "boolean") throw new ApiError(400, "invalid_boolean", { field });
  return input[field];
}

function requiredBooleanInteger(input, field) {
  const value = input[field];
  if (value === true || value === 1) return 1;
  if (value === false || value === 0) return 0;
  throw new ApiError(400, "invalid_boolean", { field });
}

function requiredEnum(input, field, allowed) {
  if (!has(input, field) || typeof input[field] !== "string" || !allowed.has(input[field])) throw new ApiError(400, "invalid_field", { field });
  return input[field];
}

function optionalEnum(input, field, allowed, fallback) {
  return has(input, field) ? requiredEnum(input, field, allowed) : fallback;
}

function requiredCurrency(input, field) {
  const value = requiredString(input, field, 3, 3).toUpperCase();
  if (!/^[A-Z]{3}$/.test(value)) throw new ApiError(400, "invalid_field", { field });
  return value;
}

function optionalCurrency(input, field, fallback) {
  return has(input, field) ? requiredCurrency(input, field) : fallback;
}

function requiredDate(input, field) {
  if (!has(input, field)) throw new ApiError(400, "missing_field", { field });
  return dateValue(input[field], field);
}

function nullableDate(input, field) {
  return input[field] === null ? null : requiredDate(input, field);
}

function optionalNullableDate(input, field, fallback) {
  return has(input, field) ? nullableDate(input, field) : fallback;
}

function dateValue(value, field) {
  const result = boundedString(value, field, 1, 64, true);
  if (!Number.isFinite(Date.parse(result))) throw new ApiError(400, "invalid_date", { field });
  return result;
}
