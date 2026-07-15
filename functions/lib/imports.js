import {
  normalizeAmount,
  normalizeDate,
  normalizeMerchantName,
  normalizePaymentMethod,
  sanitizeImportPayload,
} from "./normalization.js";
import {
  classifyMatchCandidates,
  getCandidateWindowMs,
  resolveTransactionFields,
  scoreMatch,
} from "./matching.js";
import { makeSourceRecordId, mapCsvRows, parseCsv } from "./csv.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_CANDIDATES = 50;
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 100;
const DEFAULT_CSV_ROW_LIMIT = 1000;
const MAX_CSV_ROW_LIMIT = 5000;
const CONFIRMED_TRANSACTION_STATUSES = new Set(["confirmed", "corrected", "refunded", "cancelled"]);
const TRANSACTION_STATUSES = new Set(["provisional", "confirmed", "cancelled", "refunded", "corrected"]);
const PAYMENT_STATUSES = new Set(["provisional", "confirmed", "cancelled", "refunded"]);
const RECONCILE_ACTIONS = new Set(["link", "create", "reject", "unlink"]);
const CONFIRMED_IMPORT_SOURCES = new Set(["card_csv", "paypay_csv", "bank_csv", "manual"]);
const PAYMENT_SOURCE_PRIORITY = Object.freeze({
  manual: 100,
  card_csv: 80,
  paypay_csv: 80,
  bank_csv: 80,
  receipt: 60,
  gmail_notification: 40,
});

export async function listImports(db, projectId, options = {}) {
  requireDb(db);
  const resolvedProjectId = requiredString(projectId?.project_id ?? projectId, "projectId");
  const resolvedOptions = projectId && typeof projectId === "object" ? projectId : options;
  const conditions = ["project_id = ?"];
  const values = [resolvedProjectId];
  const statuses = arrayValue(resolvedOptions.status ?? resolvedOptions.source_status).filter((status) => status);
  if (statuses.length) {
    conditions.push(`source_status IN (${statuses.map(() => "?").join(", ")})`);
    values.push(...statuses);
  }
  const sourceTypes = arrayValue(resolvedOptions.source_type).filter((sourceType) => sourceType);
  if (sourceTypes.length) {
    conditions.push(`source_type IN (${sourceTypes.map(() => "?").join(", ")})`);
    values.push(...sourceTypes);
  }
  const transactionId = optionalString(resolvedOptions.transaction_id ?? resolvedOptions.transactionId);
  if (transactionId) {
    conditions.push("transaction_id = ?");
    values.push(transactionId);
  }
  const before = normalizeDate(resolvedOptions.before);
  if (before) {
    conditions.push("created_at < ?");
    values.push(before);
  }
  const limit = boundedInteger(resolvedOptions.limit, DEFAULT_LIST_LIMIT, 1, MAX_LIST_LIMIT);
  values.push(limit);
  return allRows(
    db,
    `SELECT *
     FROM import_records
     WHERE ${conditions.join(" AND ")}
     ORDER BY created_at DESC, id DESC
     LIMIT ?`,
    values,
  );
}

export async function createReceiptImport(db, projectIdOrInput, inputOrOptions = {}, maybeOptions = {}) {
  const { projectId, input, options } = sourceArguments(projectIdOrInput, inputOrOptions, maybeOptions, "receipt");
  const record = await normalizeImportRecord("receipt", projectId, input, options);
  return persistAndClassify(db, record, options);
}

export async function createNotificationImport(db, projectIdOrInput, inputOrOptions = {}, maybeOptions = {}) {
  const { projectId, input, options } = sourceArguments(projectIdOrInput, inputOrOptions, maybeOptions, "notification");
  const record = await normalizeImportRecord("gmail_notification", projectId, input, options);
  return persistAndClassify(db, record, options);
}

export async function createCsvImports(db, projectIdOrInput, csvOrOptions = "", profileOrOptions = "generic", maybeOptions = {}) {
  requireDb(db);
  const parsedArguments = csvArguments(projectIdOrInput, csvOrOptions, profileOrOptions, maybeOptions);
  const parsed = parseCsv(parsedArguments.csvText, parsedArguments.options);
  const configuredLimit = boundedInteger(
    parsedArguments.options.maxRows ?? parsedArguments.options.max_rows,
    DEFAULT_CSV_ROW_LIMIT,
    1,
    MAX_CSV_ROW_LIMIT,
  );
  const totalRows = parsed.rows.length;
  const selected = { ...parsed, rows: parsed.rows.slice(0, configuredLimit) };
  const mappedRows = mapCsvRows(selected, parsedArguments.profile, parsedArguments.options);
  const results = [];
  let inserted = 0;
  let duplicates = 0;
  let invalid = 0;
  for (const row of mappedRows) {
    const record = await normalizeImportRecord(row.source_type, parsedArguments.projectId, row, {
      ...parsedArguments.options,
      provider: parsedArguments.options.provider ?? parsedArguments.profile,
    });
    const result = await persistAndClassify(db, record, parsedArguments.options);
    results.push(result);
    if (result.duplicate) duplicates += 1;
    else inserted += 1;
    if (record.source_status === "error") invalid += 1;
  }
  return {
    imports: results.map((result) => result.import),
    results,
    total_rows: totalRows,
    processed: mappedRows.length,
    inserted,
    duplicates,
    invalid,
    truncated: Math.max(0, totalRows - mappedRows.length),
  };
}

export async function findCandidates(db, projectIdOrIncoming, incomingOrOptions = {}, maybeOptions = {}) {
  requireDb(db);
  const incomingProvidedSeparately = typeof projectIdOrIncoming === "string";
  const incoming = incomingProvidedSeparately ? incomingOrOptions : projectIdOrIncoming;
  const options = incomingProvidedSeparately ? maybeOptions : incomingOrOptions;
  const projectId = requiredString(incomingProvidedSeparately ? projectIdOrIncoming : incoming?.project_id, "projectId");
  const preparedIncoming = resolutionSource(incoming || {});
  const amount = integerAmount(preparedIncoming.paid_amount_raw ?? preparedIncoming.paid_amount);
  const occurredAt = normalizeDate(preparedIncoming.occurred_at_raw ?? preparedIncoming.occurred_at);
  if (amount === null || !occurredAt) return classifyMatchCandidates([]);
  const anchor = timestamp(occurredAt);
  if (anchor === null) return classifyMatchCandidates([]);
  const refunded = amount < 0 || ["cancelled", "refunded"].includes(String(preparedIncoming.status || "").toLowerCase());
  const statuses = refunded ? ["cancelled", "refunded"] : ["provisional", "confirmed", "corrected"];
  const limit = boundedInteger(options.limit, MAX_CANDIDATES, 1, MAX_CANDIDATES);
  const tolerance = boundedInteger(options.amount_tolerance, Math.max(100, Math.round(Math.abs(amount) * 0.05)), 0, 100_000);
  const start = new Date(anchor - 7 * DAY_MS).toISOString();
  const end = new Date(anchor + 7 * DAY_MS).toISOString();
  let candidates = await allRows(
    db,
    `SELECT
       t.*,
       COALESCE(
         (SELECT ir.source_type
          FROM import_records ir
          WHERE ir.transaction_id = t.id
            AND ir.source_status = 'linked'
          ORDER BY
            CASE ir.source_type
              WHEN 'manual' THEN 6
              WHEN 'card_csv' THEN 5
              WHEN 'paypay_csv' THEN 5
              WHEN 'bank_csv' THEN 5
              WHEN 'receipt' THEN 4
              WHEN 'gmail_notification' THEN 3
              ELSE 0
            END DESC,
            ir.created_at DESC,
            ir.id DESC
          LIMIT 1),
         'manual'
       ) AS source_type,
       p.payment_method,
       p.account_label,
       p.external_payment_id AS external_transaction_id
     FROM transactions t
     LEFT JOIN transaction_payments p
       ON p.id = (
         SELECT candidate_payment.id
         FROM transaction_payments candidate_payment
         WHERE candidate_payment.transaction_id = t.id
         ORDER BY
           CASE candidate_payment.payment_status WHEN 'confirmed' THEN 2 ELSE 1 END DESC,
           candidate_payment.created_at,
           candidate_payment.id
         LIMIT 1
       )
     WHERE t.project_id = ?
       AND t.paid_amount BETWEEN ? AND ?
       AND t.occurred_at >= ?
       AND t.occurred_at <= ?
       AND t.status IN (${statuses.map(() => "?").join(", ")})
     ORDER BY t.occurred_at DESC, t.id
     LIMIT ?`,
    [projectId, amount - tolerance, amount + tolerance, start, end, ...statuses, limit],
  );
  const incomingExternalId = optionalString(
    preparedIncoming.external_transaction_id ?? preparedIncoming.external_payment_id,
  );
  if (incomingExternalId) {
    const externalCandidate = await firstRow(
      db,
      `SELECT
         t.*,
         COALESCE(
           (SELECT ir.source_type
            FROM import_records ir
            WHERE ir.transaction_id = t.id
              AND ir.source_status = 'linked'
            ORDER BY ir.created_at DESC, ir.id DESC
            LIMIT 1),
           'manual'
         ) AS source_type,
         p.payment_method,
         p.account_label,
         p.external_payment_id AS external_transaction_id
       FROM transaction_payments p
       JOIN transactions t ON t.id = p.transaction_id
       WHERE p.external_payment_id = ?
         AND t.project_id = ?
       LIMIT 1`,
      [incomingExternalId, projectId],
    );
    if (externalCandidate && !candidates.some((candidate) => candidate.id === externalCandidate.id)) {
      candidates = [externalCandidate, ...candidates].slice(0, limit);
    }
  }
  const windowed = candidates.filter((candidate) => {
    if (sameExternalTransaction(preparedIncoming, candidate)) return true;
    const candidateTime = timestamp(candidate.occurred_at);
    if (candidateTime === null) return false;
    const window = getCandidateWindowMs(preparedIncoming.source_type, candidate.source_type, options);
    return Math.abs(anchor - candidateTime) <= window;
  });
  const confirmedSameAmountCount = windowed.filter((candidate) => candidate.status === "confirmed").length;
  const scored = windowed.map((candidate) => ({
    candidate,
    ...scoreMatch(preparedIncoming, candidate, { confirmed_same_amount_count: confirmedSameAmountCount }),
  }));
  return classifyMatchCandidates(scored);
}

export async function reconcileImport(db, first, second, third = {}, fourth = {}) {
  requireDb(db);
  const parsed = reconciliationArguments(first, second, third, fourth);
  const importRecord = await firstRow(db, "SELECT * FROM import_records WHERE id = ?", [parsed.importId]);
  if (!importRecord) throw new Error("Import record not found");
  if (parsed.projectId && importRecord.project_id !== parsed.projectId) throw new Error("Import record does not belong to the project");
  if (parsed.action === "link") return linkImport(db, importRecord, parsed.details);
  if (parsed.action === "create") return createTransactionForImport(db, importRecord, parsed.details);
  if (parsed.action === "reject") return detachImport(db, importRecord, "rejected", parsed.details);
  return detachImport(db, importRecord, "parsed", parsed.details);
}

export async function applyResolvedTransactionFields(db, transactionId, options = {}) {
  requireDb(db);
  const resolvedTransactionId = requiredString(transactionId?.transaction_id ?? transactionId, "transactionId");
  const resolvedOptions = transactionId && typeof transactionId === "object" ? transactionId : options;
  const transaction = await firstRow(db, "SELECT * FROM transactions WHERE id = ?", [resolvedTransactionId]);
  if (!transaction) throw new Error("Transaction not found");
  if (resolvedOptions.project_id && transaction.project_id !== resolvedOptions.project_id) {
    throw new Error("Transaction does not belong to the project");
  }
  const importRows = await allRows(
    db,
    `SELECT *
     FROM import_records
     WHERE transaction_id = ?
       AND source_status = 'linked'
     ORDER BY created_at, id`,
    [resolvedTransactionId],
  );
  if (!importRows.length) return transaction;
  const sources = importRows.map(resolutionSource);
  const resolution = resolveTransactionFields(transaction, sources);
  const fields = transactionFields(transaction, resolution.fields);
  protectConfirmedValues(transaction, fields, resolution.field_sources);
  const now = currentTime(resolvedOptions);
  const statements = [
    boundStatement(
      db,
      `UPDATE transactions
       SET merchant_name = ?,
           merchant_normalized = ?,
           gross_amount = ?,
           paid_amount = ?,
           category = ?,
           status = ?,
           occurred_at = ?,
           settled_at = ?,
           updated_at = ?
       WHERE id = ?`,
      [
        fields.merchant_name,
        fields.merchant_normalized,
        fields.gross_amount,
        fields.paid_amount,
        fields.category,
        fields.status,
        fields.occurred_at,
        fields.settled_at,
        now,
        resolvedTransactionId,
      ],
    ),
  ];
  const summaryItem = await firstRow(
    db,
    `SELECT *
     FROM transaction_items
     WHERE transaction_id = ?
       AND item_type = 'summary'
       AND id LIKE 'import-summary:%'
     ORDER BY created_at, id
     LIMIT 1`,
    [resolvedTransactionId],
  );
  if (summaryItem && (summaryItem.amount !== fields.paid_amount || summaryItem.category !== fields.category)) {
    statements.push(
      boundStatement(
        db,
        "UPDATE transaction_items SET amount = ?, category = ?, updated_at = ? WHERE id = ?",
        [fields.paid_amount, fields.category, now, summaryItem.id],
      ),
    );
    if (summaryItem.amount !== fields.paid_amount) {
      statements.push(boundStatement(db, "DELETE FROM item_allocations WHERE transaction_item_id = ?", [summaryItem.id]));
      const members = await activeMembers(db, transaction.project_id);
      for (const allocation of allocateAmount(fields.paid_amount, members)) {
        statements.push(
          boundStatement(
            db,
            `INSERT INTO item_allocations (
               id, transaction_item_id, project_member_id, allocated_amount, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?)`,
            [newId("import-allocation", resolvedOptions), summaryItem.id, allocation.member.id, allocation.amount, now, now],
          ),
        );
      }
    }
  }
  const paymentPlan = await resolvedPaymentPlan(db, transaction, fields, sources, resolution.field_sources, resolvedOptions, now);
  statements.push(...paymentPlan);
  await runBatch(db, statements);
  return firstRow(db, "SELECT * FROM transactions WHERE id = ?", [resolvedTransactionId]);
}

async function persistAndClassify(db, record, options) {
  requireDb(db);
  const persisted = await insertImport(db, record);
  if (persisted.duplicate) {
    return importResult(persisted.row, {
      duplicate: true,
      action: "duplicate",
      candidates: [],
      transaction: persisted.row.transaction_id
        ? await firstRow(db, "SELECT * FROM transactions WHERE id = ?", [persisted.row.transaction_id])
        : null,
    });
  }
  if (record.source_status === "error" || options.reconcile === false) {
    return importResult(persisted.row, {
      duplicate: false,
      action: record.source_status === "error" ? "error" : "parsed",
      candidates: [],
      transaction: null,
    });
  }
  const classification = await findCandidates(db, record.project_id, record, options);
  const matchDetails = decisionDetails(classification);
  if (classification.action === "link") {
    return linkImport(db, persisted.row, {
      ...options,
      transaction_id: classification.top.candidate.id,
      match_score: classification.top.score,
      match_reason_json: matchDetails,
      automatic: true,
      candidates: classification.candidates,
    });
  }
  if (classification.action === "review") {
    await runStatement(
      db,
      `UPDATE import_records
       SET source_status = 'review', match_score = ?, match_reason_json = ?, updated_at = ?
       WHERE id = ?`,
      [classification.top?.score ?? null, JSON.stringify(matchDetails), currentTime(options), persisted.row.id],
    );
    const updated = await firstRow(db, "SELECT * FROM import_records WHERE id = ?", [persisted.row.id]);
    return importResult(updated, {
      duplicate: false,
      action: "review",
      candidates: classification.candidates,
      transaction: null,
    });
  }
  return createTransactionForImport(db, persisted.row, {
    ...options,
    match_score: classification.top?.score ?? null,
    match_reason_json: matchDetails,
    automatic: true,
    candidates: classification.candidates,
  });
}

async function insertImport(db, record) {
  const result = await runStatement(
    db,
    `INSERT OR IGNORE INTO import_records (
       id, project_id, transaction_id, source_type, source_record_id, source_status,
       merchant_raw, merchant_normalized, gross_amount_raw, paid_amount_raw,
       occurred_at_raw, settled_at_raw, payment_method_raw, external_transaction_id,
       image_url, raw_text, raw_payload, parse_confidence, parser_version,
       match_score, match_reason_json, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      record.id,
      record.project_id,
      null,
      record.source_type,
      record.source_record_id,
      record.source_status,
      record.merchant_raw,
      record.merchant_normalized,
      record.gross_amount_raw,
      record.paid_amount_raw,
      record.occurred_at_raw,
      record.settled_at_raw,
      record.payment_method_raw,
      record.external_transaction_id,
      record.image_url,
      record.raw_text,
      record.raw_payload,
      record.parse_confidence,
      record.parser_version,
      null,
      null,
      record.created_at,
      record.updated_at,
    ],
  );
  if (changedRows(result) > 0) {
    return { row: await firstRow(db, "SELECT * FROM import_records WHERE id = ?", [record.id]), duplicate: false };
  }
  const existing = await firstRow(
    db,
    `SELECT *
     FROM import_records
     WHERE project_id = ?
       AND source_type = ?
       AND source_record_id = ?`,
    [record.project_id, record.source_type, record.source_record_id],
  );
  if (!existing) throw new Error("Import record could not be inserted");
  return { row: existing, duplicate: true };
}

async function linkImport(db, importRecord, details) {
  importRecord = confirmedOcrImportRecord(importRecord, details);
  const transactionId = requiredString(details.transaction_id ?? details.transactionId, "transactionId");
  const transaction = await firstRow(db, "SELECT * FROM transactions WHERE id = ?", [transactionId]);
  if (!transaction) throw new Error("Transaction not found");
  if (transaction.project_id !== importRecord.project_id) throw new Error("Transaction does not belong to the import project");
  const oldTransactionId = importRecord.transaction_id;
  const reason = jsonValue(details.match_reason_json ?? details.matchReason, importRecord.match_reason_json);
  const now = currentTime(details);
  const statements = [boundStatement(
    db,
    `UPDATE import_records
     SET transaction_id = ?, source_status = 'linked', merchant_raw = ?, merchant_normalized = ?,
         gross_amount_raw = ?, paid_amount_raw = ?, occurred_at_raw = ?, raw_payload = ?,
         match_score = ?, match_reason_json = ?, updated_at = ?
     WHERE id = ?`,
    [
      transactionId,
      importRecord.merchant_raw,
      importRecord.merchant_normalized,
      importRecord.gross_amount_raw,
      importRecord.paid_amount_raw,
      importRecord.occurred_at_raw,
      importRecord.raw_payload,
      integerValue(details.match_score ?? details.matchScore, importRecord.match_score),
      reason,
      now,
      importRecord.id,
    ],
  )];
  const pendingStatement = pendingOcrFeedbackStatement(db, importRecord, transactionId, details, now);
  if (pendingStatement) statements.push(pendingStatement);
  await runBatch(db, statements);
  if (oldTransactionId && oldTransactionId !== transactionId) {
    await applyResolvedTransactionFields(db, oldTransactionId, details);
  }
  const resolvedTransaction = await applyResolvedTransactionFields(db, transactionId, details);
  const updatedImport = await firstRow(db, "SELECT * FROM import_records WHERE id = ?", [importRecord.id]);
  return importResult(updatedImport, {
    duplicate: false,
    action: "link",
    automatic: Boolean(details.automatic),
    candidates: details.candidates || [],
    transaction: resolvedTransaction,
  });
}

async function createTransactionForImport(db, importRecord, details) {
  importRecord = confirmedOcrImportRecord(importRecord, details);
  if (importRecord.transaction_id) {
    const transaction = await firstRow(db, "SELECT * FROM transactions WHERE id = ?", [importRecord.transaction_id]);
    return importResult(importRecord, {
      duplicate: false,
      action: "create",
      automatic: Boolean(details.automatic),
      candidates: details.candidates || [],
      transaction,
    });
  }
  const source = resolutionSource(importRecord);
  const resolution = resolveTransactionFields([source]);
  const fields = transactionFields({}, resolution.fields);
  if (fields.paid_amount === null || !fields.occurred_at) throw new Error("Import record does not contain a valid amount and date");
  const now = currentTime(details);
  const transactionId = optionalString(details.new_transaction_id ?? details.newTransactionId) || newId("import-transaction", details);
  const summaryItemId = newId("import-summary", details);
  const members = await activeMembers(db, importRecord.project_id);
  const payload = payloadObject(importRecord.raw_payload);
  const transactionStatus = importTransactionStatus(importRecord, payload);
  fields.status = transactionStatus;
  const entryType = transactionStatus === "refunded" || fields.paid_amount < 0 ? "refund" : "purchase";
  const statements = [
    boundStatement(
      db,
      `INSERT INTO transactions (
         id, project_id, merchant_name, merchant_normalized, gross_amount, paid_amount,
         discount_amount, point_amount, category, status, occurred_at, settled_at, note,
         entry_type, origin_project_id, origin_transaction_id, origin_member_id,
         generated_automatically, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        transactionId,
        importRecord.project_id,
        fields.merchant_name,
        fields.merchant_normalized,
        fields.gross_amount,
        fields.paid_amount,
        integerAmount(payload.discount_amount) ?? 0,
        integerAmount(payload.point_amount) ?? 0,
        fields.category,
        fields.status,
        fields.occurred_at,
        fields.settled_at,
        optionalString(payload.note),
        entryType,
        null,
        null,
        null,
        1,
        now,
        now,
      ],
    ),
    boundStatement(
      db,
      `INSERT INTO transaction_items (
         id, transaction_id, name, amount, quantity, item_type, category,
         sort_order, is_hidden, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 1, 'summary', ?, 0, 0, ?, ?)`,
      [summaryItemId, transactionId, "Total", fields.paid_amount, fields.category, now, now],
    ),
  ];
  for (const allocation of allocateAmount(fields.paid_amount, members)) {
    statements.push(
      boundStatement(
        db,
        `INSERT INTO item_allocations (
           id, transaction_item_id, project_member_id, allocated_amount, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
        [newId("import-allocation", details), summaryItemId, allocation.member.id, allocation.amount, now, now],
      ),
    );
  }
  const payment = paymentDetails([source], fields, details);
  if (payment.available) {
    payment.external_payment_id = await availableExternalPaymentId(db, transactionId, payment.external_payment_id);
    statements.push(
      boundStatement(
        db,
        `INSERT INTO transaction_payments (
           id, transaction_id, payer_member_id, amount, payment_method, provider,
           account_label, external_payment_id, payment_status, occurred_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          newId("import-payment", details),
          transactionId,
          validPayerMemberId(payment.payer_member_id, members),
          fields.paid_amount,
          payment.payment_method,
          payment.provider,
          payment.account_label,
          payment.external_payment_id,
          transactionPaymentStatus(fields.status),
          fields.occurred_at,
          now,
          now,
        ],
      ),
    );
  }
  statements.push(
    boundStatement(
      db,
      `UPDATE import_records
       SET transaction_id = ?, source_status = 'linked', merchant_raw = ?, merchant_normalized = ?,
           gross_amount_raw = ?, paid_amount_raw = ?, occurred_at_raw = ?, raw_payload = ?,
           match_score = ?, match_reason_json = ?, updated_at = ?
       WHERE id = ?`,
      [
        transactionId,
        importRecord.merchant_raw,
        importRecord.merchant_normalized,
        importRecord.gross_amount_raw,
        importRecord.paid_amount_raw,
        importRecord.occurred_at_raw,
        importRecord.raw_payload,
        integerValue(details.match_score, null),
        jsonValue(details.match_reason_json, null),
        now,
        importRecord.id,
      ],
    ),
  );
  const pendingStatement = pendingOcrFeedbackStatement(db, importRecord, transactionId, details, now);
  if (pendingStatement) statements.push(pendingStatement);
  await runBatch(db, statements);
  const createdTransaction = await firstRow(db, "SELECT * FROM transactions WHERE id = ?", [transactionId]);
  const updatedImport = await firstRow(db, "SELECT * FROM import_records WHERE id = ?", [importRecord.id]);
  return importResult(updatedImport, {
    duplicate: false,
    action: "create",
    automatic: Boolean(details.automatic),
    candidates: details.candidates || [],
    transaction: createdTransaction,
  });
}

function pendingOcrFeedbackStatement(db, importRecord, transactionId, details, timestampValue) {
  const pending = details?.pending_ocr_feedback;
  if (!pending || importRecord.source_type !== "receipt") return null;
  return boundStatement(
    db,
    `INSERT INTO receipt_ocr_feedback_pending (
       import_id, user_id, project_id, transaction_id, ocr_result_id,
       claims_json, confirmed_json, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(import_id) DO UPDATE SET
       user_id = excluded.user_id,
       project_id = excluded.project_id,
       transaction_id = excluded.transaction_id,
       ocr_result_id = excluded.ocr_result_id,
       claims_json = excluded.claims_json,
       confirmed_json = excluded.confirmed_json,
       updated_at = excluded.updated_at`,
    [
      importRecord.id,
      requiredString(pending.user_id, "pendingOcrUserId"),
      importRecord.project_id,
      transactionId,
      requiredString(pending.ocr_result_id, "pendingOcrResultId"),
      JSON.stringify(pending.claims),
      JSON.stringify(pending.confirmed),
      timestampValue,
      timestampValue,
    ],
  );
}

function confirmedOcrImportRecord(importRecord, details) {
  const confirmed = details?.confirmed_ocr;
  if (!confirmed || importRecord.source_type !== "receipt") return importRecord;
  const merchantRaw = optionalString(confirmed.store_name) || importRecord.merchant_raw;
  const paidAmount = integerAmount(confirmed.total_amount) ?? importRecord.paid_amount_raw;
  const occurredAt = normalizeDate(confirmed.paid_at) || importRecord.occurred_at_raw;
  const payload = payloadObject(importRecord.raw_payload);
  const ocr = payload.ocr && typeof payload.ocr === "object" && !Array.isArray(payload.ocr) ? { ...payload.ocr } : {};
  if (confirmed.paid_time) ocr.confirmed_paid_time = confirmed.paid_time;
  if (Array.isArray(confirmed.items)) ocr.confirmed_items = confirmed.items;
  return {
    ...importRecord,
    merchant_raw: merchantRaw,
    merchant_normalized: normalizeMerchantName(merchantRaw),
    gross_amount_raw: paidAmount,
    paid_amount_raw: paidAmount,
    occurred_at_raw: occurredAt,
    raw_payload: JSON.stringify({ ...payload, ocr }),
  };
}

async function detachImport(db, importRecord, sourceStatus, details) {
  const oldTransactionId = importRecord.transaction_id;
  const clearMatch = sourceStatus === "parsed";
  await runStatement(
    db,
    `UPDATE import_records
     SET transaction_id = NULL,
         source_status = ?,
         match_score = ?,
         match_reason_json = ?,
         updated_at = ?
     WHERE id = ?`,
    [
      sourceStatus,
      clearMatch ? null : importRecord.match_score,
      clearMatch ? null : importRecord.match_reason_json,
      currentTime(details),
      importRecord.id,
    ],
  );
  if (oldTransactionId) await applyResolvedTransactionFields(db, oldTransactionId, details);
  const updatedImport = await firstRow(db, "SELECT * FROM import_records WHERE id = ?", [importRecord.id]);
  return importResult(updatedImport, {
    duplicate: false,
    action: sourceStatus === "rejected" ? "reject" : "unlink",
    candidates: [],
    transaction: null,
  });
}

async function resolvedPaymentPlan(db, transaction, fields, sources, fieldSources, options, now) {
  const details = paymentDetails(sources, fields, options);
  if (!details.available) return [];
  const members = await activeMembers(db, transaction.project_id);
  const payerMemberId = validPayerMemberId(details.payer_member_id, members);
  const existing = await firstRow(
    db,
    `SELECT *
     FROM transaction_payments
     WHERE transaction_id = ?
     ORDER BY
       CASE WHEN id LIKE 'import-payment:%' THEN 0 ELSE 1 END DESC,
       CASE payment_status WHEN 'confirmed' THEN 2 ELSE 1 END DESC,
       created_at,
       id
     LIMIT 1`,
    [transaction.id],
  );
  const notificationWon = details.source_type === "gmail_notification" || fieldSources.payment_method === "gmail_notification";
  if (existing) {
    if (existing.payment_status === "confirmed" && notificationWon) return [];
    if (!existing.id.startsWith("import-payment:") && !sameExternalPayment(existing, details)) return [];
    const externalPaymentId = await availableExternalPaymentId(db, transaction.id, details.external_payment_id);
    return [
      boundStatement(
        db,
        `UPDATE transaction_payments
         SET payer_member_id = COALESCE(?, payer_member_id),
             amount = ?,
             payment_method = ?,
             provider = COALESCE(?, provider),
             account_label = COALESCE(?, account_label),
             external_payment_id = COALESCE(?, external_payment_id),
             payment_status = ?,
             occurred_at = ?,
             updated_at = ?
         WHERE id = ?`,
        [
          payerMemberId,
          fields.paid_amount,
          details.payment_method,
          details.provider,
          details.account_label,
          externalPaymentId,
          transactionPaymentStatus(fields.status),
          fields.occurred_at,
          now,
          existing.id,
        ],
      ),
    ];
  }
  const externalPaymentId = await availableExternalPaymentId(db, transaction.id, details.external_payment_id);
  return [
    boundStatement(
      db,
      `INSERT INTO transaction_payments (
         id, transaction_id, payer_member_id, amount, payment_method, provider,
         account_label, external_payment_id, payment_status, occurred_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newId("import-payment", options),
        transaction.id,
        payerMemberId,
        fields.paid_amount,
        details.payment_method,
        details.provider,
        details.account_label,
        externalPaymentId,
        transactionPaymentStatus(fields.status),
        fields.occurred_at,
        now,
        now,
      ],
    ),
  ];
}

async function availableExternalPaymentId(db, transactionId, externalPaymentId) {
  if (!externalPaymentId) return null;
  const existing = await firstRow(
    db,
    "SELECT transaction_id FROM transaction_payments WHERE external_payment_id = ? LIMIT 1",
    [externalPaymentId],
  );
  return !existing || existing.transaction_id === transactionId ? externalPaymentId : null;
}

function paymentDetails(sources, fields, options) {
  const ranked = sources
    .map((source, index) => ({ source, payload: payloadObject(source.raw_payload), index }))
    .sort((left, right) => (
      (PAYMENT_SOURCE_PRIORITY[right.source.source_type] ?? 0) - (PAYMENT_SOURCE_PRIORITY[left.source.source_type] ?? 0)
      || right.index - left.index
    ));
  const withPayment = ranked.find(({ source, payload }) => (
    source.payment_method_raw
    || source.external_transaction_id
    || payload.payment_method
    || payload.external_transaction_id
    || payload.external_payment_id
    || payload.account_label
    || payload.provider
    || payload.payer_member_id
  ));
  const optionPaymentAvailable = Boolean(
    options.payer_member_id
    ?? options.payerMemberId
    ?? options.payment_method
    ?? options.paymentMethod
    ?? options.external_payment_id
    ?? options.account_label
    ?? options.provider
  );
  if (!withPayment && !optionPaymentAvailable) {
    return {
      available: false,
      source_type: null,
      payment_method: "other",
      provider: null,
      account_label: null,
      external_payment_id: null,
      payer_member_id: optionalString(options.payer_member_id ?? options.payerMemberId),
    };
  }
  const selected = withPayment || { source: {}, payload: {} };
  const rawMethod = options.payment_method
    ?? options.paymentMethod
    ?? fields.payment_method
    ?? selected.source.payment_method_raw
    ?? selected.payload.payment_method;
  return {
    available: true,
    source_type: selected.source.source_type ?? "manual",
    payment_method: schemaPaymentMethod(rawMethod),
    provider: optionalString(options.provider ?? selected.payload.provider),
    account_label: optionalString(options.account_label ?? selected.payload.account_label),
    external_payment_id: optionalString(
      options.external_payment_id
      ?? selected.source.external_transaction_id
      ?? selected.payload.external_transaction_id
      ?? selected.payload.external_payment_id,
    ),
    payer_member_id: optionalString(options.payer_member_id ?? options.payerMemberId ?? selected.payload.payer_member_id),
  };
}

function transactionFields(existing, resolved) {
  const paidAmount = integerAmount(resolved.paid_amount ?? existing.paid_amount);
  const grossAmount = integerAmount(resolved.gross_amount ?? existing.gross_amount) ?? paidAmount;
  const merchantName = optionalString(resolved.merchant_name ?? existing.merchant_name) || "Unknown merchant";
  const occurredAt = normalizeDate(resolved.occurred_at ?? existing.occurred_at);
  const status = normalizedTransactionStatus(resolved.status ?? existing.status, paidAmount);
  return {
    merchant_name: merchantName,
    merchant_normalized: normalizeMerchantName(merchantName),
    gross_amount: grossAmount,
    paid_amount: paidAmount,
    category: optionalString(resolved.category ?? existing.category),
    status,
    occurred_at: occurredAt,
    settled_at: normalizeDate(resolved.settled_at ?? existing.settled_at),
    payment_method: normalizePaymentMethod(resolved.payment_method),
  };
}

function protectConfirmedValues(existing, fields, fieldSources) {
  if (!CONFIRMED_TRANSACTION_STATUSES.has(existing.status)) return;
  const mapping = {
    merchant_name: "merchant_name",
    gross_amount: "gross_amount",
    paid_amount: "paid_amount",
    category: "category",
    status: "status",
    occurred_at: "occurred_at",
    settled_at: "settled_at",
  };
  for (const [resolvedField, existingField] of Object.entries(mapping)) {
    if (fieldSources[resolvedField] !== "gmail_notification") continue;
    if (existing[existingField] === null || existing[existingField] === undefined || existing[existingField] === "") continue;
    fields[existingField] = existing[existingField];
  }
  fields.merchant_normalized = normalizeMerchantName(fields.merchant_name);
}

function resolutionSource(row) {
  const payload = payloadObject(row.raw_payload);
  return {
    ...row,
    raw_payload: payload,
    status: importTransactionStatus(row, payload),
    category: row.category ?? payload.category ?? null,
    account_label: row.account_label ?? payload.account_label ?? null,
    provider: row.provider ?? payload.provider ?? null,
    payer_member_id: row.payer_member_id ?? payload.payer_member_id ?? null,
  };
}

function importTransactionStatus(row, payload = payloadObject(row.raw_payload)) {
  const sourceType = row.source_type || "manual";
  const amount = integerAmount(row.paid_amount_raw ?? row.paid_amount);
  if (sourceType === "gmail_notification") return "provisional";
  const rawStatus = String(row.status ?? payload.status ?? "").toLowerCase();
  if (rawStatus.includes("cancel")) return "cancelled";
  if (rawStatus.includes("refund") || rawStatus.includes("取消") || (amount !== null && amount < 0)) return "refunded";
  if (CONFIRMED_IMPORT_SOURCES.has(sourceType)) return "confirmed";
  return rawStatus === "confirmed" ? "confirmed" : "provisional";
}

async function normalizeImportRecord(sourceType, projectId, input, options) {
  const data = input && typeof input === "object" ? input : {};
  const rawAudit = auditPayload(data);
  const merchantRaw = firstValue(data.merchant_raw, data.merchant_name, data.store_name, data.merchant, rawAudit.merchant_name, rawAudit.store_name);
  const paidAmount = integerAmount(firstValue(
    data.paid_amount_raw,
    data.paid_amount,
    data.total_amount,
    data.amount,
    rawAudit.paid_amount,
    rawAudit.total_amount,
    rawAudit.amount,
  ));
  const grossAmount = integerAmount(firstValue(
    data.gross_amount_raw,
    data.gross_amount,
    rawAudit.gross_amount,
    rawAudit.total_amount,
  )) ?? paidAmount;
  const occurredAt = normalizeDate(firstValue(
    data.occurred_at_raw,
    data.occurred_at,
    data.paid_at,
    data.date,
    data.received_at,
    rawAudit.occurred_at,
    rawAudit.paid_at,
    rawAudit.date,
    rawAudit.received_at,
  ));
  const settledAt = normalizeDate(firstValue(data.settled_at_raw, data.settled_at, rawAudit.settled_at));
  const paymentMethod = normalizePaymentMethod(firstValue(
    data.payment_method_raw,
    data.payment_method,
    rawAudit.payment_method,
  ));
  const externalTransactionId = optionalString(firstValue(
    data.external_transaction_id,
    data.external_payment_id,
    data.transaction_id,
    rawAudit.external_transaction_id,
    rawAudit.external_payment_id,
  ));
  const normalizedAudit = sanitizeImportPayload({
    ...rawAudit,
    ...(data.account_label !== undefined ? { account_label: data.account_label } : {}),
    ...(data.provider !== undefined || options.provider !== undefined ? { provider: data.provider ?? options.provider } : {}),
    ...(data.payer_member_id !== undefined ? { payer_member_id: data.payer_member_id } : {}),
    ...(data.category !== undefined ? { category: data.category } : {}),
    ...(data.discount_amount !== undefined ? { discount_amount: data.discount_amount } : {}),
    ...(data.point_amount !== undefined ? { point_amount: data.point_amount } : {}),
    ...(data.status !== undefined ? { status: data.status } : {}),
  });
  const sourceRecordId = await sourceIdentifier(sourceType, data, {
    merchant_raw: merchantRaw,
    paid_amount_raw: paidAmount,
    occurred_at_raw: occurredAt,
    external_transaction_id: externalTransactionId,
    account_label: data.account_label ?? normalizedAudit.account_label,
  }, options);
  const valid = data.valid !== false && paidAmount !== null && Boolean(occurredAt);
  const now = currentTime(options);
  return {
    id: optionalString(options.import_id ?? options.importId) || newId("import", options),
    project_id: requiredString(projectId, "projectId"),
    source_type: sourceType,
    source_record_id: sourceRecordId,
    source_status: valid ? "parsed" : "error",
    merchant_raw: optionalString(merchantRaw),
    merchant_normalized: normalizeMerchantName(merchantRaw),
    gross_amount_raw: grossAmount,
    paid_amount_raw: paidAmount,
    occurred_at_raw: occurredAt,
    settled_at_raw: settledAt,
    payment_method_raw: paymentMethod,
    external_transaction_id: externalTransactionId,
    image_url: optionalString(data.image_url ?? data.receipt_image_url),
    raw_text: sanitizedText(data.raw_text ?? data.text),
    raw_payload: JSON.stringify(normalizedAudit),
    parse_confidence: confidenceValue(data.parse_confidence ?? data.confidence),
    parser_version: optionalString(data.parser_version ?? options.parser_version),
    created_at: now,
    updated_at: now,
  };
}

async function sourceIdentifier(sourceType, data, normalized, options) {
  const explicit = optionalString(data.source_record_id);
  if (explicit) return explicit;
  if (sourceType === "gmail_notification") {
    const messageId = optionalString(data.message_id ?? data.notification_id ?? data.id);
    if (messageId) return `${optionalString(data.provider ?? options.provider) || "gmail"}:${messageId}`;
  }
  if (sourceType === "receipt") {
    const receiptId = optionalString(data.receipt_id ?? data.document_id);
    if (receiptId) return receiptId;
  }
  return makeSourceRecordId(sourceType, normalized, { provider: options.provider ?? data.provider });
}

function sourceArguments(projectIdOrInput, inputOrOptions, maybeOptions, kind) {
  if (typeof projectIdOrInput === "string") {
    return {
      projectId: projectIdOrInput,
      input: inputOrOptions && typeof inputOrOptions === "object" ? inputOrOptions : {},
      options: maybeOptions && typeof maybeOptions === "object" ? maybeOptions : {},
    };
  }
  const envelope = projectIdOrInput && typeof projectIdOrInput === "object" ? projectIdOrInput : {};
  const nested = envelope[kind] ?? envelope.data ?? envelope.payload;
  return {
    projectId: requiredString(envelope.project_id ?? envelope.projectId, "projectId"),
    input: nested && typeof nested === "object" ? nested : envelope,
    options: inputOrOptions && typeof inputOrOptions === "object" ? inputOrOptions : {},
  };
}

function csvArguments(projectIdOrInput, csvOrOptions, profileOrOptions, maybeOptions) {
  if (typeof projectIdOrInput === "object" && projectIdOrInput !== null) {
    const envelope = projectIdOrInput;
    return {
      projectId: requiredString(envelope.project_id ?? envelope.projectId, "projectId"),
      csvText: String(envelope.csv ?? envelope.csv_text ?? envelope.text ?? ""),
      profile: envelope.profile ?? envelope.profile_name ?? "generic",
      options: csvOrOptions && typeof csvOrOptions === "object"
        ? { ...envelope, ...envelope.options, ...csvOrOptions }
        : { ...envelope, ...envelope.options },
    };
  }
  if (csvOrOptions && typeof csvOrOptions === "object") {
    const envelope = csvOrOptions;
    const trailingOptions = profileOrOptions && typeof profileOrOptions === "object" ? profileOrOptions : maybeOptions;
    return {
      projectId: requiredString(projectIdOrInput, "projectId"),
      csvText: String(envelope.csv ?? envelope.csv_text ?? envelope.text ?? ""),
      profile: typeof profileOrOptions === "string"
        ? profileOrOptions
        : envelope.profile ?? envelope.profile_name ?? "generic",
      options: { ...envelope, ...envelope.options, ...(trailingOptions || {}) },
    };
  }
  const profileIsOptions = profileOrOptions && typeof profileOrOptions === "object";
  return {
    projectId: requiredString(projectIdOrInput, "projectId"),
    csvText: String(csvOrOptions ?? ""),
    profile: profileIsOptions ? profileOrOptions.profile ?? "generic" : profileOrOptions || "generic",
    options: profileIsOptions ? profileOrOptions : maybeOptions && typeof maybeOptions === "object" ? maybeOptions : {},
  };
}

function reconciliationArguments(first, second, third, fourth) {
  if (RECONCILE_ACTIONS.has(String(second)) || (second && typeof second === "object" && second.action)) {
    const actionObject = second && typeof second === "object" ? second : null;
    const action = String(actionObject?.action ?? second);
    if (!RECONCILE_ACTIONS.has(action)) throw new TypeError("Unknown reconciliation action");
    return {
      projectId: null,
      importId: requiredString(first, "importId"),
      action,
      details: actionObject ? { ...third, ...actionObject } : third && typeof third === "object" ? third : {},
    };
  }
  const actionObject = third && typeof third === "object" ? third : null;
  const action = String(actionObject?.action ?? third);
  if (!RECONCILE_ACTIONS.has(action)) throw new TypeError("Unknown reconciliation action");
  return {
    projectId: requiredString(first, "projectId"),
    importId: requiredString(second, "importId"),
    action,
    details: actionObject ? { ...fourth, ...actionObject } : fourth && typeof fourth === "object" ? fourth : {},
  };
}

function decisionDetails(classification) {
  return {
    action: classification.action,
    candidates: classification.candidates.map((entry) => ({
      transaction_id: entry.candidate?.id ?? entry.id ?? null,
      score: entry.score,
      strong: Boolean(entry.strong),
      reasons: entry.reasons || [],
    })),
  };
}

function importResult(importRecord, details) {
  return {
    ...importRecord,
    import: importRecord,
    duplicate: Boolean(details.duplicate),
    action: details.action,
    automatic: Boolean(details.automatic),
    candidates: details.candidates || [],
    transaction: details.transaction || null,
  };
}

function auditPayload(data) {
  const raw = data.raw_payload ?? data.payload ?? data;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return { ...raw };
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      return { raw };
    }
    return { raw };
  }
  return { value: raw ?? null };
}

function payloadObject(value) {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function allocateAmount(amount, members) {
  if (!members.length) return [];
  const base = Math.trunc(amount / members.length);
  const remainder = amount - base * members.length;
  return members.map((member, index) => ({
    member,
    amount: base + (index < Math.abs(remainder) ? Math.sign(remainder) : 0),
  }));
}

async function activeMembers(db, projectId) {
  return allRows(
    db,
    `SELECT *
     FROM project_members
     WHERE project_id = ?
       AND is_active = 1
     ORDER BY created_at, id`,
    [projectId],
  );
}

function validPayerMemberId(payerMemberId, members) {
  if (!payerMemberId) return null;
  return members.some((member) => member.id === payerMemberId) ? payerMemberId : null;
}

function normalizedTransactionStatus(value, amount) {
  const status = String(value || "").toLowerCase();
  if (TRANSACTION_STATUSES.has(status)) return status;
  return amount !== null && amount < 0 ? "refunded" : "provisional";
}

function transactionPaymentStatus(status) {
  if (status === "corrected") return "confirmed";
  return PAYMENT_STATUSES.has(status) ? status : "provisional";
}

function schemaPaymentMethod(value) {
  const raw = String(value || "").normalize("NFKC").toLowerCase();
  if (raw.includes("suica")) return "suica";
  if (raw.includes("pasmo")) return "pasmo";
  const normalized = normalizePaymentMethod(value);
  if (["cash", "credit_card", "paypay", "suica", "pasmo", "bank", "point", "other"].includes(normalized)) return normalized;
  if (["bank_transfer", "direct_debit"].includes(normalized)) return "bank";
  if (normalized === "points") return "point";
  return "other";
}

function sameExternalPayment(existing, details) {
  return Boolean(existing.external_payment_id && details.external_payment_id && existing.external_payment_id === details.external_payment_id);
}

function sameExternalTransaction(left, right) {
  const leftId = optionalString(left.external_transaction_id ?? left.external_payment_id);
  const rightId = optionalString(right.external_transaction_id ?? right.external_payment_id);
  return Boolean(leftId && rightId && leftId.toLowerCase() === rightId.toLowerCase());
}

function timestamp(value) {
  const normalized = normalizeDate(value);
  if (!normalized) return null;
  const parsed = Date.parse(normalized.length === 10 ? `${normalized}T00:00:00+09:00` : normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function currentTime(options = {}) {
  const supplied = typeof options.now === "function" ? options.now() : options.now;
  if (!supplied) return new Date().toISOString();
  if (supplied instanceof Date) return supplied.toISOString();
  const parsed = Date.parse(String(supplied));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : String(supplied);
}

function newId(kind, options = {}) {
  if (typeof options.idFactory === "function") return requiredString(options.idFactory(kind), `${kind} id`);
  if (globalThis.crypto?.randomUUID) return `${kind}:${globalThis.crypto.randomUUID()}`;
  throw new Error("crypto.randomUUID is not available");
}

function sanitizedText(value) {
  if (value === null || value === undefined) return null;
  return String(sanitizeImportPayload(String(value)));
}

function confidenceValue(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 1 ? number : null;
}

function integerAmount(value) {
  const normalized = normalizeAmount(value);
  return normalized !== null && Number.isSafeInteger(normalized) ? normalized : null;
}

function integerValue(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : fallback;
}

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, number));
}

function requiredString(value, name) {
  const text = optionalString(value);
  if (!text) throw new TypeError(`${name} is required`);
  return text;
}

function optionalString(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

function firstValue(...values) {
  return values.find((value) => value !== null && value !== undefined && value !== "");
}

function arrayValue(value) {
  if (value === null || value === undefined || value === "") return [];
  return Array.isArray(value) ? value.map(String) : [String(value)];
}

function jsonValue(value, fallback) {
  if (value === null || value === undefined) return fallback;
  return typeof value === "string" ? value : JSON.stringify(value);
}

function requireDb(db) {
  if (!db || typeof db.prepare !== "function") throw new TypeError("A D1-style database is required");
}

function boundStatement(db, sql, values = []) {
  const statement = db.prepare(sql);
  return values.length ? statement.bind(...values) : statement;
}

async function allRows(db, sql, values = []) {
  const result = await boundStatement(db, sql, values).all();
  if (Array.isArray(result)) return result;
  return result?.results || [];
}

async function firstRow(db, sql, values = []) {
  const statement = boundStatement(db, sql, values);
  if (typeof statement.first === "function") return (await statement.first()) || null;
  const result = await statement.all();
  const rows = Array.isArray(result) ? result : result?.results || [];
  return rows[0] || null;
}

async function runStatement(db, sql, values = []) {
  return boundStatement(db, sql, values).run();
}

async function runBatch(db, statements) {
  if (!statements.length) return [];
  if (typeof db.batch === "function") return db.batch(statements);
  const results = [];
  for (const statement of statements) results.push(await statement.run());
  return results;
}

function changedRows(result) {
  const value = result?.meta?.changes ?? result?.changes ?? result?.meta?.rows_written;
  return Number.isFinite(Number(value)) ? Number(value) : 1;
}
