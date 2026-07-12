const TERMINAL_SOURCE_STATUSES = new Set(["cancelled", "refunded"]);
const INACTIVE_PAYMENT_STATUSES = new Set(["cancelled", "refunded"]);

function rowsFrom(result) {
  if (Array.isArray(result)) return result;
  return Array.isArray(result?.results) ? result.results : [];
}

async function all(db, sql, values = []) {
  let statement = db.prepare(sql);
  if (values.length) statement = statement.bind(...values);
  return rowsFrom(await statement.all());
}

async function first(db, sql, values = []) {
  let statement = db.prepare(sql);
  if (values.length) statement = statement.bind(...values);
  return (await statement.first()) ?? null;
}

async function executeStatements(db, statements) {
  if (!statements.length) return [];
  if (typeof db.batch === "function") return db.batch(statements);
  const results = [];
  for (const statement of statements) results.push(await statement.run());
  return results;
}

function nowValue(value) {
  const candidate = typeof value === "string"
    ? value
    : typeof value?.now === "function"
      ? value.now()
      : value?.now;
  if (candidate instanceof Date) return candidate.toISOString();
  return candidate ? String(candidate) : new Date().toISOString();
}

function idPart(value) {
  return encodeURIComponent(String(value));
}

function generatedTransactionId(sourceProjectId, sourceTransactionId, sourceMemberId, householdProjectId) {
  return ["household", "transaction", sourceProjectId, sourceTransactionId, sourceMemberId, householdProjectId]
    .map(idPart)
    .join(":");
}

function generatedPaymentId(sourceProjectId, sourceTransactionId, sourceMemberId, householdProjectId) {
  return ["household", "payment", sourceProjectId, sourceTransactionId, sourceMemberId, householdProjectId]
    .map(idPart)
    .join(":");
}

function generatedItemId(sourceProjectId, sourceTransactionId, sourceMemberId, householdProjectId, sourceItemId) {
  return ["household", "item", sourceProjectId, sourceTransactionId, sourceMemberId, householdProjectId, sourceItemId]
    .map(idPart)
    .join(":");
}

function generatedAllocationId(itemId, householdMemberId) {
  return ["household", "allocation", itemId, householdMemberId].map(idPart).join(":");
}

function addIssue(issues, code, transactionId, details = {}) {
  issues.push({ code, transaction_id: transactionId, ...details });
}

function groupBy(rows, key) {
  const grouped = new Map();
  for (const row of rows) {
    const value = row[key];
    if (!grouped.has(value)) grouped.set(value, []);
    grouped.get(value).push(row);
  }
  return grouped;
}

function sum(rows, field) {
  return rows.reduce((total, row) => total + Number(row[field] || 0), 0);
}

async function loadSourceTransaction(db, transactionId) {
  return first(
    db,
    `SELECT
       transactions.*,
       projects.project_type AS source_project_type,
       projects.finalized_at AS source_project_finalized_at
     FROM transactions
     JOIN projects ON projects.id = transactions.project_id
     WHERE transactions.id = ?`,
    [transactionId],
  );
}

async function loadProject(db, projectId) {
  return first(db, "SELECT * FROM projects WHERE id = ?", [projectId]);
}

async function loadSourceMember(db, projectId, memberId) {
  return first(
    db,
    "SELECT * FROM project_members WHERE id = ? AND project_id = ?",
    [memberId, projectId],
  );
}

async function loadHouseholdMember(db, householdProjectId) {
  return first(
    db,
    `SELECT *
     FROM project_members
     WHERE project_id = ?
       AND is_active = 1
     ORDER BY CASE WHEN role = 'owner' THEN 0 ELSE 1 END, created_at, id
     LIMIT 1`,
    [householdProjectId],
  );
}

async function loadMemberAllocations(db, transactionId, memberId) {
  return all(
    db,
    `SELECT
       transaction_items.id AS source_item_id,
       transaction_items.name,
       transaction_items.quantity,
       transaction_items.item_type,
       transaction_items.category,
       transaction_items.sort_order,
       transaction_items.is_hidden,
       item_allocations.id AS source_allocation_id,
       item_allocations.allocated_amount
     FROM transaction_items
     JOIN item_allocations
       ON item_allocations.transaction_item_id = transaction_items.id
     WHERE transaction_items.transaction_id = ?
       AND item_allocations.project_member_id = ?
     ORDER BY transaction_items.sort_order, transaction_items.id`,
    [transactionId, memberId],
  );
}

async function findGeneratedRows(db, sourceProjectId, sourceTransactionId) {
  return all(
    db,
    `SELECT *
     FROM transactions
     WHERE generated_automatically = 1
       AND entry_type = 'split_expense'
       AND origin_project_id = ?
       AND origin_transaction_id = ?
     ORDER BY project_id, origin_member_id, id`,
    [sourceProjectId, sourceTransactionId],
  );
}

async function findGeneratedForMember(db, sourceProjectId, sourceTransactionId, sourceMemberId) {
  return all(
    db,
    `SELECT *
     FROM transactions
     WHERE generated_automatically = 1
       AND entry_type = 'split_expense'
       AND origin_project_id = ?
       AND origin_transaction_id = ?
       AND origin_member_id = ?`,
    [sourceProjectId, sourceTransactionId, sourceMemberId],
  );
}

export async function calculateMemberBurden(db, transactionId, memberId) {
  const burdens = await all(
    db,
    `SELECT
       project_members.id AS member_id,
       COALESCE((
         SELECT SUM(item_allocations.allocated_amount)
         FROM item_allocations
         JOIN transaction_items
           ON transaction_items.id = item_allocations.transaction_item_id
         WHERE transaction_items.transaction_id = transactions.id
           AND item_allocations.project_member_id = project_members.id
       ), 0) AS burden
     FROM transactions
     JOIN project_members
       ON project_members.project_id = transactions.project_id
     WHERE transactions.id = ?
     ORDER BY project_members.created_at, project_members.id`,
    [transactionId],
  );
  const result = Object.fromEntries(burdens.map((row) => [row.member_id, Number(row.burden || 0)]));
  return memberId === undefined || memberId === null ? result : result[memberId] ?? 0;
}

export async function validateSplitProject(db, projectId) {
  const project = await loadProject(db, projectId);
  if (!project) {
    const issues = [{ code: "project_not_found", transaction_id: null }];
    return { valid: false, project_id: projectId, transactions: [], issues, errors: ["project_not_found"] };
  }

  const [transactions, payments, items, allocations] = await Promise.all([
    all(db, "SELECT * FROM transactions WHERE project_id = ? ORDER BY created_at, id", [projectId]),
    all(
      db,
      `SELECT transaction_payments.*
       FROM transaction_payments
       JOIN transactions ON transactions.id = transaction_payments.transaction_id
       WHERE transactions.project_id = ?`,
      [projectId],
    ),
    all(
      db,
      `SELECT transaction_items.*
       FROM transaction_items
       JOIN transactions ON transactions.id = transaction_items.transaction_id
       WHERE transactions.project_id = ?
       ORDER BY transaction_items.sort_order, transaction_items.id`,
      [projectId],
    ),
    all(
      db,
      `SELECT item_allocations.*, transaction_items.transaction_id
       FROM item_allocations
       JOIN transaction_items ON transaction_items.id = item_allocations.transaction_item_id
       JOIN transactions ON transactions.id = transaction_items.transaction_id
       WHERE transactions.project_id = ?`,
      [projectId],
    ),
  ]);

  const paymentsByTransaction = groupBy(payments, "transaction_id");
  const itemsByTransaction = groupBy(items, "transaction_id");
  const allocationsByTransaction = groupBy(allocations, "transaction_id");
  const allocationsByItem = groupBy(allocations, "transaction_item_id");
  const issues = [];
  const transactionResults = [];

  for (const transaction of transactions) {
    const transactionIssues = [];
    const transactionPayments = paymentsByTransaction.get(transaction.id) || [];
    const activePayments = transactionPayments.filter((payment) => !INACTIVE_PAYMENT_STATUSES.has(payment.payment_status));
    const transactionItems = itemsByTransaction.get(transaction.id) || [];
    const transactionAllocations = allocationsByTransaction.get(transaction.id) || [];
    const expected = Number(transaction.paid_amount || 0);
    const paymentTotal = sum(activePayments, "amount");
    const itemTotal = sum(transactionItems, "amount");
    const allocationTotal = sum(transactionAllocations, "allocated_amount");

    if (!transactionItems.length) addIssue(transactionIssues, "transaction_without_items", transaction.id);
    for (const item of transactionItems) {
      const itemAllocations = allocationsByItem.get(item.id) || [];
      const itemAllocationTotal = sum(itemAllocations, "allocated_amount");
      if (!itemAllocations.length) {
        addIssue(transactionIssues, "item_without_allocations", transaction.id, { item_id: item.id });
      }
      if (itemAllocationTotal !== Number(item.amount || 0)) {
        addIssue(transactionIssues, "item_allocation_total_mismatch", transaction.id, {
          item_id: item.id,
          expected: Number(item.amount || 0),
          actual: itemAllocationTotal,
        });
      }
    }
    if (paymentTotal !== expected) {
      addIssue(transactionIssues, "payment_total_mismatch", transaction.id, { expected, actual: paymentTotal });
    }
    if (itemTotal !== expected) {
      addIssue(transactionIssues, "item_total_mismatch", transaction.id, { expected, actual: itemTotal });
    }
    if (allocationTotal !== expected) {
      addIssue(transactionIssues, "allocation_total_mismatch", transaction.id, { expected, actual: allocationTotal });
    }

    issues.push(...transactionIssues);
    transactionResults.push({
      transaction_id: transaction.id,
      valid: transactionIssues.length === 0,
      amount: expected,
      payment_total: paymentTotal,
      item_total: itemTotal,
      allocation_total: allocationTotal,
      issues: transactionIssues,
    });
  }

  return {
    valid: issues.length === 0,
    project_id: projectId,
    transactions: transactionResults,
    issues,
    errors: issues.map((issue) => issue.code),
  };
}

async function cancelForMember(db, sourceProjectId, sourceTransactionId, sourceMemberId, options) {
  const generatedRows = await findGeneratedForMember(db, sourceProjectId, sourceTransactionId, sourceMemberId);
  const cancelled = [];
  for (const row of generatedRows) {
    const result = await cancelGeneratedHouseholdTransaction(db, row, options);
    if (result.status === "cancelled") cancelled.push(row.id);
  }
  return cancelled;
}

async function resolveUpsertContext(db, input, sourceMemberInput, optionsInput) {
  if (input?.sourceTransaction || input?.source_transaction) {
    const sourceTransaction = input.sourceTransaction || input.source_transaction;
    const sourceProject = input.sourceProject || input.source_project || await loadProject(db, sourceTransaction.project_id);
    const sourceMember = input.sourceMember || input.source_member;
    const householdProject = input.householdProject || input.household_project;
    const householdMember = input.householdMember || input.household_member;
    const allocations = input.allocations || input.items || [];
    return {
      sourceTransaction,
      sourceProject,
      sourceMember,
      householdProject,
      householdMember,
      allocations,
      now: input.now,
    };
  }

  const options = optionsInput || {};
  const sourceTransaction = typeof input === "object" && input?.id
    ? input
    : await loadSourceTransaction(db, input);
  if (!sourceTransaction) return null;
  const sourceProject = options.sourceProject || options.source_project || await loadProject(db, sourceTransaction.project_id);
  const memberId = typeof sourceMemberInput === "object" ? sourceMemberInput.id : sourceMemberInput;
  const sourceMember = typeof sourceMemberInput === "object"
    ? sourceMemberInput
    : await loadSourceMember(db, sourceTransaction.project_id, memberId);
  if (!sourceMember) return { sourceTransaction, sourceProject, sourceMember: null, now: options.now };
  const householdProject = options.householdProject
    || options.household_project
    || await loadProject(db, sourceMember.linked_household_project_id);
  const householdMember = options.householdMember
    || options.household_member
    || (householdProject ? await loadHouseholdMember(db, householdProject.id) : null);
  const allocations = options.allocations
    || options.items
    || await loadMemberAllocations(db, sourceTransaction.id, sourceMember.id);
  return {
    sourceTransaction,
    sourceProject,
    sourceMember,
    householdProject,
    householdMember,
    allocations,
    now: options.now,
  };
}

export async function upsertGeneratedHouseholdTransaction(db, input, sourceMemberInput, optionsInput = {}) {
  const context = await resolveUpsertContext(db, input, sourceMemberInput, optionsInput);
  if (!context?.sourceTransaction) return { status: "not_found", transaction_id: null };

  const { sourceTransaction, sourceProject, sourceMember, householdProject, householdMember } = context;
  if (Number(sourceTransaction.generated_automatically) === 1) {
    return { status: "skipped", reason: "generated_source", transaction_id: sourceTransaction.id };
  }
  if (sourceProject?.project_type !== "split") {
    return { status: "skipped", reason: "source_project_not_split", transaction_id: sourceTransaction.id };
  }
  if (!sourceMember || Number(sourceMember.is_active) !== 1 || !sourceMember.linked_household_project_id) {
    const cancelled = sourceMember
      ? await cancelForMember(db, sourceTransaction.project_id, sourceTransaction.id, sourceMember.id, context)
      : [];
    return { status: "skipped", reason: "source_member_not_linked", transaction_id: sourceTransaction.id, cancelled };
  }
  if (householdProject?.project_type !== "household" || householdProject.id !== sourceMember.linked_household_project_id) {
    const cancelled = await cancelForMember(db, sourceTransaction.project_id, sourceTransaction.id, sourceMember.id, context);
    return { status: "skipped", reason: "household_not_found", transaction_id: sourceTransaction.id, cancelled };
  }
  if (!householdMember || Number(householdMember.is_active) !== 1 || householdMember.project_id !== householdProject.id) {
    const cancelled = await cancelForMember(db, sourceTransaction.project_id, sourceTransaction.id, sourceMember.id, context);
    return { status: "skipped", reason: "household_member_not_found", transaction_id: sourceTransaction.id, cancelled };
  }

  const allocations = context.allocations
    .map((allocation) => ({ ...allocation, allocated_amount: Number(allocation.allocated_amount || 0) }))
    .filter((allocation) => allocation.allocated_amount !== 0);
  const burden = sum(allocations, "allocated_amount");
  if (burden === 0 || TERMINAL_SOURCE_STATUSES.has(sourceTransaction.status)) {
    const cancelled = await cancelForMember(db, sourceTransaction.project_id, sourceTransaction.id, sourceMember.id, context);
    return {
      status: "cancelled",
      reason: burden === 0 ? "zero_burden" : "source_cancelled",
      transaction_id: sourceTransaction.id,
      cancelled,
    };
  }

  const existing = await first(
    db,
    `SELECT *
     FROM transactions
     WHERE generated_automatically = 1
       AND entry_type = 'split_expense'
       AND project_id = ?
       AND origin_project_id = ?
       AND origin_transaction_id = ?
       AND origin_member_id = ?
     LIMIT 1`,
    [householdProject.id, sourceTransaction.project_id, sourceTransaction.id, sourceMember.id],
  );
  const transactionId = existing?.id || generatedTransactionId(
    sourceTransaction.project_id,
    sourceTransaction.id,
    sourceMember.id,
    householdProject.id,
  );
  const paymentId = generatedPaymentId(
    sourceTransaction.project_id,
    sourceTransaction.id,
    sourceMember.id,
    householdProject.id,
  );
  const now = nowValue(context);
  const status = sourceProject.finalized_at ? "confirmed" : "provisional";
  const itemRows = allocations.map((allocation) => ({
    ...allocation,
    id: generatedItemId(
      sourceTransaction.project_id,
      sourceTransaction.id,
      sourceMember.id,
      householdProject.id,
      allocation.source_item_id,
    ),
  }));
  const statements = [
    db.prepare(
      `INSERT INTO transactions (
         id, project_id, merchant_name, merchant_normalized, gross_amount, paid_amount,
         discount_amount, point_amount, category, status, occurred_at, settled_at, note,
         entry_type, origin_project_id, origin_transaction_id, origin_member_id,
         generated_automatically, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, 'split_expense', ?, ?, ?, 1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         project_id = excluded.project_id,
         merchant_name = excluded.merchant_name,
         merchant_normalized = excluded.merchant_normalized,
         gross_amount = excluded.gross_amount,
         paid_amount = excluded.paid_amount,
         discount_amount = 0,
         point_amount = 0,
         category = excluded.category,
         status = excluded.status,
         occurred_at = excluded.occurred_at,
         settled_at = excluded.settled_at,
         note = excluded.note,
         entry_type = 'split_expense',
         origin_project_id = excluded.origin_project_id,
         origin_transaction_id = excluded.origin_transaction_id,
         origin_member_id = excluded.origin_member_id,
         generated_automatically = 1,
         updated_at = excluded.updated_at`,
    ).bind(
      transactionId,
      householdProject.id,
      sourceTransaction.merchant_name || sourceMember.display_name,
      sourceTransaction.merchant_normalized || "",
      burden,
      burden,
      sourceTransaction.category ?? null,
      status,
      sourceTransaction.occurred_at || now,
      sourceTransaction.settled_at ?? null,
      sourceTransaction.note ?? null,
      sourceTransaction.project_id,
      sourceTransaction.id,
      sourceMember.id,
      now,
      now,
    ),
    db.prepare("DELETE FROM transaction_payments WHERE transaction_id = ? AND id <> ?").bind(transactionId, paymentId),
    db.prepare(
      `INSERT INTO transaction_payments (
         id, transaction_id, payer_member_id, amount, payment_method, provider, account_label,
         external_payment_id, payment_status, occurred_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'other', NULL, NULL, NULL, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         transaction_id = excluded.transaction_id,
         payer_member_id = excluded.payer_member_id,
         amount = excluded.amount,
         payment_method = 'other',
         provider = NULL,
         account_label = NULL,
         external_payment_id = NULL,
         payment_status = excluded.payment_status,
         occurred_at = excluded.occurred_at,
         updated_at = excluded.updated_at`,
    ).bind(paymentId, transactionId, householdMember.id, burden, status, sourceTransaction.occurred_at || now, now, now),
  ];

  const placeholders = itemRows.map(() => "?").join(", ");
  statements.push(
    db.prepare(`DELETE FROM transaction_items WHERE transaction_id = ? AND id NOT IN (${placeholders})`)
      .bind(transactionId, ...itemRows.map((item) => item.id)),
  );

  for (const item of itemRows) {
    const allocationId = generatedAllocationId(item.id, householdMember.id);
    statements.push(
      db.prepare(
        `INSERT INTO transaction_items (
           id, transaction_id, name, amount, quantity, item_type, category, sort_order,
           is_hidden, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           transaction_id = excluded.transaction_id,
           name = excluded.name,
           amount = excluded.amount,
           quantity = excluded.quantity,
           item_type = excluded.item_type,
           category = excluded.category,
           sort_order = excluded.sort_order,
           is_hidden = excluded.is_hidden,
           updated_at = excluded.updated_at`,
      ).bind(
        item.id,
        transactionId,
        item.name || sourceTransaction.merchant_name || "Split expense",
        item.allocated_amount,
        Number(item.quantity) > 0 ? Number(item.quantity) : 1,
        item.item_type || "product",
        item.category ?? sourceTransaction.category ?? null,
        Number.isInteger(Number(item.sort_order)) && Number(item.sort_order) >= 0 ? Number(item.sort_order) : 0,
        Number(item.is_hidden) === 1 ? 1 : 0,
        now,
        now,
      ),
      db.prepare("DELETE FROM item_allocations WHERE transaction_item_id = ? AND project_member_id <> ?")
        .bind(item.id, householdMember.id),
      db.prepare(
        `INSERT INTO item_allocations (
           id, transaction_item_id, project_member_id, allocated_amount, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(transaction_item_id, project_member_id) DO UPDATE SET
           allocated_amount = excluded.allocated_amount,
           updated_at = excluded.updated_at`,
      ).bind(allocationId, item.id, householdMember.id, item.allocated_amount, now, now),
    );
  }

  await executeStatements(db, statements);
  const transaction = await first(db, "SELECT * FROM transactions WHERE id = ?", [transactionId]);
  return {
    status: "upserted",
    action: existing ? "updated" : "created",
    transaction_id: transactionId,
    transaction,
    burden,
    item_ids: itemRows.map((item) => item.id),
  };
}

export async function cancelGeneratedHouseholdTransaction(db, generatedTransactionInput, options = {}) {
  const generatedTransaction = typeof generatedTransactionInput === "object"
    ? generatedTransactionInput
    : await first(db, "SELECT * FROM transactions WHERE id = ?", [generatedTransactionInput]);
  if (!generatedTransaction) return { status: "not_found", transaction_id: null };
  if (Number(generatedTransaction.generated_automatically) !== 1) {
    return { status: "skipped", reason: "not_generated", transaction_id: generatedTransaction.id };
  }

  const now = nowValue(options);
  const statements = [
    db.prepare(
      `UPDATE transactions
       SET gross_amount = 0,
           paid_amount = 0,
           discount_amount = 0,
           point_amount = 0,
           status = 'cancelled',
           updated_at = ?
       WHERE id = ?`,
    ).bind(now, generatedTransaction.id),
    db.prepare(
      `UPDATE transaction_payments
       SET amount = 0,
           payment_status = 'cancelled',
           updated_at = ?
       WHERE transaction_id = ?`,
    ).bind(now, generatedTransaction.id),
    db.prepare(
      `UPDATE transaction_items
       SET amount = 0,
           updated_at = ?
       WHERE transaction_id = ?`,
    ).bind(now, generatedTransaction.id),
    db.prepare(
      `UPDATE item_allocations
       SET allocated_amount = 0,
           updated_at = ?
       WHERE transaction_item_id IN (
         SELECT id FROM transaction_items WHERE transaction_id = ?
       )`,
    ).bind(now, generatedTransaction.id),
  ];
  await executeStatements(db, statements);
  return { status: "cancelled", transaction_id: generatedTransaction.id };
}

export async function cancelGeneratedForSource(db, sourceProjectId, sourceTransactionId, options = {}) {
  const values = [typeof sourceProjectId === "object" ? sourceProjectId.id : sourceProjectId];
  let sql = `SELECT *
             FROM transactions
             WHERE generated_automatically = 1
               AND entry_type = 'split_expense'
               AND origin_project_id = ?`;
  if (sourceTransactionId !== undefined && sourceTransactionId !== null) {
    sql += " AND origin_transaction_id = ?";
    values.push(typeof sourceTransactionId === "object" ? sourceTransactionId.id : sourceTransactionId);
  }
  const generatedRows = await all(db, sql, values);
  const transactionIds = [];
  for (const generatedRow of generatedRows) {
    const result = await cancelGeneratedHouseholdTransaction(db, generatedRow, options);
    if (result.status === "cancelled") transactionIds.push(generatedRow.id);
  }
  return { status: "cancelled", count: transactionIds.length, transaction_ids: transactionIds };
}

function desiredKey(householdProjectId, sourceMemberId) {
  return `${idPart(householdProjectId)}:${idPart(sourceMemberId)}`;
}

function invalidTransactionError(validation, transactionId) {
  const error = new Error(`invalid_split_transaction:${transactionId}`);
  error.code = "invalid_split_project";
  error.validation = validation;
  return error;
}

export async function syncSplitTransactionToHouseholds(db, transactionInput, options = {}) {
  const sourceTransaction = typeof transactionInput === "object"
    ? transactionInput
    : await loadSourceTransaction(db, transactionInput);
  if (!sourceTransaction) {
    if (options.sourceProjectId) {
      const cancellation = await cancelGeneratedForSource(db, options.sourceProjectId, transactionInput, options);
      return { status: "not_found", source_transaction_id: transactionInput, cancelled: cancellation.transaction_ids };
    }
    return { status: "not_found", source_transaction_id: transactionInput, cancelled: [] };
  }
  if (Number(sourceTransaction.generated_automatically) === 1) {
    return { status: "skipped", reason: "generated_source", source_transaction_id: sourceTransaction.id, upserted: [], cancelled: [] };
  }

  const sourceProject = sourceTransaction.source_project_type
    ? {
      id: sourceTransaction.project_id,
      project_type: sourceTransaction.source_project_type,
      finalized_at: sourceTransaction.source_project_finalized_at,
    }
    : await loadProject(db, sourceTransaction.project_id);
  if (sourceProject?.project_type !== "split") {
    return { status: "skipped", reason: "source_project_not_split", source_transaction_id: sourceTransaction.id, upserted: [], cancelled: [] };
  }

  const existingRows = await findGeneratedRows(db, sourceTransaction.project_id, sourceTransaction.id);
  if (TERMINAL_SOURCE_STATUSES.has(sourceTransaction.status)) {
    const cancelled = [];
    for (const row of existingRows) {
      const result = await cancelGeneratedHouseholdTransaction(db, row, options);
      if (result.status === "cancelled") cancelled.push(row.id);
    }
    return { status: "cancelled", reason: "source_cancelled", source_transaction_id: sourceTransaction.id, upserted: [], cancelled };
  }

  if (options.validate !== false) {
    const validation = await validateSplitProject(db, sourceTransaction.project_id);
    const transactionValidation = validation.transactions.find((entry) => entry.transaction_id === sourceTransaction.id);
    if (!validation.valid && transactionValidation && !transactionValidation.valid) {
      throw invalidTransactionError(validation, sourceTransaction.id);
    }
  }

  const burdens = await calculateMemberBurden(db, sourceTransaction.id);
  const sourceMembers = await all(
    db,
    "SELECT * FROM project_members WHERE project_id = ? ORDER BY created_at, id",
    [sourceTransaction.project_id],
  );
  const contexts = [];
  for (const sourceMember of sourceMembers) {
    if (Number(sourceMember.is_active) !== 1 || !sourceMember.linked_household_project_id) continue;
    if (Number(burdens[sourceMember.id] || 0) === 0) continue;
    const householdProject = await loadProject(db, sourceMember.linked_household_project_id);
    if (householdProject?.project_type !== "household") continue;
    const householdMember = await loadHouseholdMember(db, householdProject.id);
    if (!householdMember) continue;
    const allocations = await loadMemberAllocations(db, sourceTransaction.id, sourceMember.id);
    contexts.push({ sourceTransaction, sourceProject, sourceMember, householdProject, householdMember, allocations, now: options.now });
  }

  const desired = new Set(contexts.map((context) => desiredKey(context.householdProject.id, context.sourceMember.id)));
  const cancelled = [];
  for (const existingRow of existingRows) {
    if (desired.has(desiredKey(existingRow.project_id, existingRow.origin_member_id))) continue;
    const result = await cancelGeneratedHouseholdTransaction(db, existingRow, options);
    if (result.status === "cancelled") cancelled.push(existingRow.id);
  }

  const upserted = [];
  for (const context of contexts) {
    const result = await upsertGeneratedHouseholdTransaction(db, context);
    if (result.status === "upserted") upserted.push(result);
  }
  return {
    status: "synced",
    source_transaction_id: sourceTransaction.id,
    upserted,
    cancelled,
  };
}

export async function syncSplitProjectToHouseholds(db, projectInput, options = {}) {
  const project = typeof projectInput === "object" ? projectInput : await loadProject(db, projectInput);
  const projectId = typeof projectInput === "object" ? projectInput.id : projectInput;
  if (!project) return { status: "not_found", project_id: projectId, transactions: [], cancelled: [] };
  if (project.project_type !== "split") {
    return { status: "skipped", reason: "source_project_not_split", project_id: project.id, transactions: [], cancelled: [] };
  }

  const sourceTransactions = await all(
    db,
    `SELECT *
     FROM transactions
     WHERE project_id = ?
       AND generated_automatically = 0
     ORDER BY occurred_at, created_at, id`,
    [project.id],
  );
  const sourceTransactionIds = new Set(sourceTransactions.map((transaction) => transaction.id));
  const generatedRows = await all(
    db,
    `SELECT *
     FROM transactions
     WHERE generated_automatically = 1
       AND entry_type = 'split_expense'
       AND origin_project_id = ?`,
    [project.id],
  );
  const cancelled = [];
  for (const generatedRow of generatedRows) {
    if (generatedRow.origin_transaction_id && generatedRow.origin_member_id && sourceTransactionIds.has(generatedRow.origin_transaction_id)) continue;
    const result = await cancelGeneratedHouseholdTransaction(db, generatedRow, options);
    if (result.status === "cancelled") cancelled.push(generatedRow.id);
  }

  if (options.validate !== false) {
    const validation = await validateSplitProject(db, project.id);
    if (!validation.valid) throw invalidTransactionError(validation, project.id);
  }

  const transactionResults = [];
  for (const sourceTransaction of sourceTransactions) {
    transactionResults.push(await syncSplitTransactionToHouseholds(db, sourceTransaction, { ...options, validate: false }));
  }
  return {
    status: "synced",
    project_id: project.id,
    transactions: transactionResults,
    cancelled,
  };
}
