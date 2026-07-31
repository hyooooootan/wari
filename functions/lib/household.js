const TERMINAL_SOURCE_STATUSES = new Set(["cancelled", "refunded"]);
const INACTIVE_PAYMENT_STATUSES = new Set(["cancelled", "refunded"]);

function terminalSourceTransaction(transaction) {
  const status = String(transaction?.status || "").toLowerCase();
  return TERMINAL_SOURCE_STATUSES.has(status) && !(status === "refunded" && transaction?.entry_type === "refund");
}

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

async function executeStatements(db, statements, options = {}) {
  if (!statements.length) return [];
  const targetProjectIds = [...(options.targetProjectIds || [])].sort();
  const guardedStatements = options.user && targetProjectIds.length
    ? [
      ...targetProjectIds.map((projectId) => db.prepare(
        "INSERT INTO household_sync_guards (project_id, user_id, checked_at) VALUES (?, ?, ?)",
      ).bind(projectId, options.user.id, nowValue(options))),
      ...statements,
      ...targetProjectIds.map((projectId) => db.prepare(
        "DELETE FROM household_sync_guards WHERE project_id = ? AND user_id = ?",
      ).bind(projectId, options.user.id)),
    ]
    : statements;
  if (typeof db.batch === "function") return db.batch(guardedStatements);
  const results = [];
  for (const statement of guardedStatements) results.push(await statement.run());
  return results;
}

async function queueOrExecute(db, statements, options = {}) {
  if (options.statementCollector) {
    options.statementCollector.push(...statements);
    return false;
  }
  await executeStatements(db, statements, options);
  return true;
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

async function canWriteHousehold(db, user, projectId) {
  if (!user) return true;
  const row = await first(
    db,
    `SELECT 1 AS allowed
     FROM projects
     JOIN users ON users.id = projects.owner_user_id
     WHERE projects.id = ?
       AND projects.project_type = 'household'
       AND projects.owner_user_id = ?
       AND users.deleted_at IS NULL
       AND users.deletion_started_at IS NULL
     LIMIT 1`,
    [projectId, user.id],
  );
  return Boolean(row);
}

async function canWriteProject(db, user, projectId) {
  if (!user) return true;
  const row = await first(
    db,
    `SELECT 1 AS allowed
     FROM projects
     JOIN users ON users.id = ?
     LEFT JOIN project_user_roles roles
       ON roles.project_id = projects.id
      AND roles.user_id = users.id
      AND roles.revoked_at IS NULL
     WHERE projects.id = ?
       AND users.deleted_at IS NULL
       AND users.deletion_started_at IS NULL
       AND (
         (projects.project_type = 'household' AND projects.owner_user_id = users.id)
         OR (projects.project_type = 'split' AND roles.role IN ('owner', 'editor'))
       )
     LIMIT 1`,
    [user.id, projectId],
  );
  return Boolean(row);
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

async function loadSourcePaymentMethod(db, transaction) {
  const payment = await first(
    db,
    `SELECT payment_method
     FROM transaction_payments
     WHERE transaction_id = ?
       AND payment_status <> 'cancelled'
       AND (payment_status <> 'refunded' OR ? = 'refund')
     ORDER BY created_at, id
     LIMIT 1`,
    [transaction.id, transaction.entry_type],
  );
  return payment?.payment_method || "other";
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
    if (terminalSourceTransaction(transaction)) {
      transactionResults.push({
        transaction_id: transaction.id,
        valid: true,
        excluded: true,
        amount: Number(transaction.paid_amount || 0),
        payment_total: 0,
        item_total: 0,
        allocation_total: 0,
        issues: [],
      });
      continue;
    }
    const transactionIssues = [];
    const transactionPayments = paymentsByTransaction.get(transaction.id) || [];
    const activePayments = transactionPayments.filter((payment) => {
      if (!INACTIVE_PAYMENT_STATUSES.has(payment.payment_status)) return true;
      return payment.payment_status === "refunded" && transaction.entry_type === "refund";
    });
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
      sourcePaymentMethod: input.sourcePaymentMethod || input.source_payment_method || await loadSourcePaymentMethod(db, sourceTransaction),
      now: input.now,
      user: optionsInput?.user,
      statementCollector: optionsInput?.statementCollector,
      targetProjectIds: optionsInput?.targetProjectIds || new Set(),
      strictTargetAccess: optionsInput?.strictTargetAccess === true,
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
    sourcePaymentMethod: options.sourcePaymentMethod || options.source_payment_method || await loadSourcePaymentMethod(db, sourceTransaction),
    now: options.now,
    user: options.user,
    statementCollector: options.statementCollector,
    targetProjectIds: options.targetProjectIds || new Set(),
    strictTargetAccess: options.strictTargetAccess === true,
  };
}

export async function upsertGeneratedHouseholdTransaction(db, input, sourceMemberInput, optionsInput = {}) {
  const context = await resolveUpsertContext(db, input, sourceMemberInput, optionsInput);
  if (!context?.sourceTransaction) return { status: "not_found", transaction_id: null };

  const { sourceTransaction, sourceProject, sourceMember, householdProject, householdMember, sourcePaymentMethod } = context;
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
  if (!await canWriteHousehold(db, optionsInput.user, householdProject.id)) {
    if (optionsInput.strictTargetAccess) throw householdAccessError(householdProject.id);
    return { status: "skipped", reason: "household_access_lost", transaction_id: sourceTransaction.id };
  }
  if (!householdMember || Number(householdMember.is_active) !== 1 || householdMember.project_id !== householdProject.id) {
    const cancelled = await cancelForMember(db, sourceTransaction.project_id, sourceTransaction.id, sourceMember.id, context);
    return { status: "skipped", reason: "household_member_not_found", transaction_id: sourceTransaction.id, cancelled };
  }

  const allocations = context.allocations
    .map((allocation) => ({ ...allocation, allocated_amount: Number(allocation.allocated_amount || 0) }))
    .filter((allocation) => allocation.allocated_amount !== 0);
  const burden = sum(allocations, "allocated_amount");
  if (burden === 0 || terminalSourceTransaction(sourceTransaction)) {
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
  if (context.targetProjectIds) context.targetProjectIds.add(householdProject.id);
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
       ) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         transaction_id = excluded.transaction_id,
         payer_member_id = excluded.payer_member_id,
         amount = excluded.amount,
         payment_method = excluded.payment_method,
         provider = NULL,
         account_label = NULL,
         external_payment_id = NULL,
         payment_status = excluded.payment_status,
         occurred_at = excluded.occurred_at,
         updated_at = excluded.updated_at`,
    ).bind(paymentId, transactionId, householdMember.id, burden, sourcePaymentMethod || "other", status, sourceTransaction.occurred_at || now, now, now),
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

  const executed = await queueOrExecute(db, statements, context);
  const transaction = executed
    ? await first(db, "SELECT * FROM transactions WHERE id = ?", [transactionId])
    : existing || { id: transactionId, project_id: householdProject.id };
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
  if (!await canWriteHousehold(db, options.user, generatedTransaction.project_id)) {
    if (options.strictTargetAccess) throw householdAccessError(generatedTransaction.project_id);
    return { status: "skipped", reason: "household_access_lost", transaction_id: generatedTransaction.id };
  }

  const targetProjectIds = options.targetProjectIds || new Set();
  const operationOptions = { ...options, targetProjectIds };
  const now = nowValue(options);
  targetProjectIds.add(generatedTransaction.project_id);
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
  await queueOrExecute(db, statements, operationOptions);
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
  const statementCollector = options.statementCollector || [];
  const targetProjectIds = options.targetProjectIds || new Set();
  const operationOptions = { ...options, statementCollector, targetProjectIds };
  const transactionIds = [];
  for (const generatedRow of generatedRows) {
    if (!await canWriteHousehold(db, options.user, generatedRow.project_id)) {
      if (options.strictTargetAccess) throw householdAccessError(generatedRow.project_id);
      continue;
    }
    const result = await cancelGeneratedHouseholdTransaction(db, generatedRow, operationOptions);
    if (result.status === "cancelled") transactionIds.push(generatedRow.id);
  }
  if (!options.statementCollector) await executeStatements(db, statementCollector, operationOptions);
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

function householdAccessError(projectId) {
  const error = new Error("household_sync_access_denied");
  error.code = "household_sync_access_denied";
  error.project_id = projectId;
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
  const statementCollector = options.statementCollector || [];
  const targetProjectIds = options.targetProjectIds || new Set();
  const operationOptions = { ...options, statementCollector, targetProjectIds };
  if (terminalSourceTransaction(sourceTransaction)) {
    const cancelled = [];
    for (const row of existingRows) {
      if (!await canWriteHousehold(db, options.user, row.project_id)) {
        if (options.strictTargetAccess) throw householdAccessError(row.project_id);
        continue;
      }
      const result = await cancelGeneratedHouseholdTransaction(db, row, operationOptions);
      if (result.status === "cancelled") cancelled.push(row.id);
    }
    if (!options.statementCollector) await executeStatements(db, statementCollector, operationOptions);
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
    if (!await canWriteHousehold(db, options.user, householdProject.id)) {
      if (options.strictTargetAccess) throw householdAccessError(householdProject.id);
      continue;
    }
    const householdMember = await loadHouseholdMember(db, householdProject.id);
    if (!householdMember) continue;
    const allocations = await loadMemberAllocations(db, sourceTransaction.id, sourceMember.id);
    contexts.push({ sourceTransaction, sourceProject, sourceMember, householdProject, householdMember, allocations, now: options.now });
  }

  const desired = new Set(contexts.map((context) => desiredKey(context.householdProject.id, context.sourceMember.id)));
  const cancelled = [];
  for (const existingRow of existingRows) {
    if (desired.has(desiredKey(existingRow.project_id, existingRow.origin_member_id))) continue;
    if (!await canWriteHousehold(db, options.user, existingRow.project_id)) {
      if (options.strictTargetAccess) throw householdAccessError(existingRow.project_id);
      continue;
    }
    const result = await cancelGeneratedHouseholdTransaction(db, existingRow, operationOptions);
    if (result.status === "cancelled") cancelled.push(existingRow.id);
  }

  const upserted = [];
  for (const context of contexts) {
    const result = await upsertGeneratedHouseholdTransaction(db, context, undefined, operationOptions);
    if (result.status === "upserted") upserted.push(result);
  }
  if (!options.statementCollector) await executeStatements(db, statementCollector, operationOptions);
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
  const statementCollector = options.statementCollector || [];
  const targetProjectIds = options.targetProjectIds || new Set();
  const operationOptions = { ...options, statementCollector, targetProjectIds };
  const cancelled = [];
  for (const generatedRow of generatedRows) {
    if (generatedRow.origin_transaction_id && generatedRow.origin_member_id && sourceTransactionIds.has(generatedRow.origin_transaction_id)) continue;
    if (!await canWriteHousehold(db, options.user, generatedRow.project_id)) {
      if (options.strictTargetAccess) throw householdAccessError(generatedRow.project_id);
      continue;
    }
    const result = await cancelGeneratedHouseholdTransaction(db, generatedRow, operationOptions);
    if (result.status === "cancelled") cancelled.push(generatedRow.id);
  }

  if (options.validate !== false) {
    const validation = await validateSplitProject(db, project.id);
    if (!validation.valid) throw invalidTransactionError(validation, project.id);
  }

  const transactionResults = [];
  for (const sourceTransaction of sourceTransactions) {
    transactionResults.push(await syncSplitTransactionToHouseholds(db, sourceTransaction, { ...operationOptions, validate: false }));
  }
  if (!options.statementCollector) await executeStatements(db, statementCollector, operationOptions);
  return {
    status: "synced",
    project_id: project.id,
    transactions: transactionResults,
    cancelled,
  };
}

function syncJobTransactionId(value) {
  return value === undefined || value === null ? "" : String(value);
}

function syncJobId(sourceProjectId, sourceTransactionId, syncScope) {
  return ["household", "sync", syncScope, sourceProjectId, syncJobTransactionId(sourceTransactionId)]
    .map(idPart)
    .join(":");
}

async function loadSyncJob(db, jobId) {
  return first(db, "SELECT * FROM household_sync_jobs WHERE id = ?", [jobId]);
}

async function completeSyncJob(db, input, now) {
  await db.prepare(
    `UPDATE household_sync_jobs
     SET status = 'completed',
         last_error_code = NULL,
         updated_at = ?,
         last_attempted_at = ?,
         completed_at = ?
     WHERE source_project_id = ?
       AND source_transaction_id = ?
       AND sync_scope = ?
       AND status <> 'completed'`,
  ).bind(
    now,
    now,
    now,
    input.sourceProjectId,
    syncJobTransactionId(input.sourceTransactionId),
    input.syncScope,
  ).run();
}

async function recordSyncFailure(db, input, error, now) {
  const transactionId = syncJobTransactionId(input.sourceTransactionId);
  const id = syncJobId(input.sourceProjectId, transactionId, input.syncScope);
  const errorCode = error?.code === "household_sync_access_denied"
    ? "household_sync_access_denied"
    : "household_sync_failed";
  await db.prepare(
    `INSERT INTO household_sync_jobs (
       id, source_project_id, source_transaction_id, requested_by_user_id,
       sync_scope, reason, attempt_count, status, last_error_code,
       created_at, updated_at, last_attempted_at, completed_at
     ) VALUES (?, ?, ?, ?, ?, ?, 1, 'pending', ?, ?, ?, ?, NULL)
     ON CONFLICT(source_project_id, source_transaction_id, sync_scope) DO UPDATE SET
       requested_by_user_id = excluded.requested_by_user_id,
       reason = excluded.reason,
       attempt_count = household_sync_jobs.attempt_count + 1,
       status = 'pending',
       last_error_code = excluded.last_error_code,
       updated_at = excluded.updated_at,
       last_attempted_at = excluded.last_attempted_at,
       completed_at = NULL`,
  ).bind(
    id,
    input.sourceProjectId,
    transactionId,
    input.user.id,
    input.syncScope,
    input.reason,
    errorCode,
    now,
    now,
    now,
  ).run();
  return loadSyncJob(db, id);
}

async function performJobSynchronization(db, input, options = {}) {
  const syncOptions = {
    validate: false,
    user: input.user,
    strictTargetAccess: options.strictTargetAccess === true,
    targetProjectIds: options.guardSourceAccess ? new Set([input.sourceProjectId]) : undefined,
  };
  if (input.syncScope === "transaction") {
    return syncSplitTransactionToHouseholds(db, input.sourceTransactionId, {
      ...syncOptions,
      sourceProjectId: input.sourceProjectId,
    });
  }
  if (input.syncScope === "cancel_project") {
    return cancelGeneratedForSource(db, input.sourceProjectId, undefined, syncOptions);
  }
  return syncSplitProjectToHouseholds(db, input.sourceProjectId, syncOptions);
}

export async function synchronizeHouseholdMutation(db, input) {
  const now = nowValue(input);
  try {
    const result = await performJobSynchronization(db, input, { strictTargetAccess: true, guardSourceAccess: true });
    await completeSyncJob(db, input, now);
    return result;
  } catch (error) {
    const job = await recordSyncFailure(db, input, error, now);
    return {
      status: "pending",
      sync_pending: true,
      job_id: job.id,
      attempt_count: job.attempt_count,
      reason: job.reason,
    };
  }
}

async function updateRetryFailure(db, job, status, errorCode, now) {
  await db.prepare(
    `UPDATE household_sync_jobs
     SET attempt_count = attempt_count + 1,
         status = ?,
         last_error_code = ?,
         updated_at = ?,
         last_attempted_at = ?,
         completed_at = NULL
     WHERE id = ?`,
  ).bind(status, errorCode, now, now, job.id).run();
  return loadSyncJob(db, job.id);
}

export async function retryHouseholdSyncJob(db, jobId, user, options = {}) {
  const job = await loadSyncJob(db, jobId);
  if (!job) return { status: "not_found", job_id: jobId };
  if (user.id !== job.requested_by_user_id) return { status: "not_found", job_id: jobId };
  const now = nowValue(options);
  const sourceProject = await loadProject(db, job.source_project_id);
  if (!sourceProject) {
    const rejected = await updateRetryFailure(db, job, "rejected", "source_project_not_found", now);
    return { status: "rejected", sync_pending: false, job_id: rejected.id };
  }
  if (!await canWriteProject(db, user, job.source_project_id)) {
    const blocked = await updateRetryFailure(db, job, "blocked", "source_access_lost", now);
    return { status: "blocked", sync_pending: false, job_id: blocked.id };
  }
  try {
    const synchronization = await performJobSynchronization(db, {
      sourceProjectId: job.source_project_id,
      sourceTransactionId: job.source_transaction_id || undefined,
      syncScope: job.sync_scope,
      user,
    }, { strictTargetAccess: true, guardSourceAccess: true });
    await db.prepare(
      `UPDATE household_sync_jobs
       SET attempt_count = attempt_count + 1,
           status = 'completed',
           last_error_code = NULL,
           updated_at = ?,
           last_attempted_at = ?,
           completed_at = ?
       WHERE id = ?`,
    ).bind(now, now, now, job.id).run();
    return { status: "completed", sync_pending: false, job: await loadSyncJob(db, job.id), synchronization };
  } catch (error) {
    const accessLost = error?.code === "household_sync_access_denied"
      || String(error?.message || "").includes("household_sync_access_denied");
    const failed = await updateRetryFailure(
      db,
      job,
      accessLost ? "blocked" : "pending",
      accessLost ? "target_access_lost" : "household_sync_failed",
      now,
    );
    return { status: failed.status, sync_pending: failed.status === "pending", job: failed };
  }
}
