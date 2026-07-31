(function () {
function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asSafeInteger(value, label) {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${label} must be a safe integer`);
  }
  return value;
}

function splitAmount(amount, memberIds) {
  if (!Array.isArray(memberIds)) {
    throw new TypeError("memberIds must be an array");
  }
  if (memberIds.length === 0) return [];
  const total = asSafeInteger(amount, "amount");
  const base = Math.trunc(total / memberIds.length);
  const remainder = total - base * memberIds.length;
  const direction = Math.sign(remainder);
  const remainderCount = Math.abs(remainder);
  return memberIds.map((mid, index) => ({
    mid,
    amount: base + (index < remainderCount ? direction : 0),
  }));
}

function transactionId(row) {
  return row?.transaction_id ?? row?.expense_id ?? null;
}

function transactionItemId(row) {
  return row?.transaction_item_id ?? row?.item_id ?? null;
}

function projectMemberId(row) {
  return row?.payer_member_id ?? row?.project_member_id ?? row?.member_id ?? row?.mid ?? null;
}

function transactionAmount(row) {
  return row?.paid_amount ?? row?.amount ?? row?.total_amount ?? row?.gross_amount ?? null;
}

function allocationAmount(row) {
  return row?.allocated_amount ?? row?.amount ?? null;
}

function transactionType(row) {
  return String(row?.entry_type ?? row?.type ?? row?.transaction_type ?? row?.kind ?? "").toLowerCase();
}

function transactionStatus(row) {
  return String(row?.status ?? "").toLowerCase();
}

function activeTransaction(row) {
  const status = transactionStatus(row);
  if (status === "cancelled") return false;
  return status !== "refunded" || transactionType(row) === "refund";
}

function activePayment(row, transaction) {
  if (!activeTransaction(transaction)) return false;
  const status = String(row?.payment_status ?? "confirmed").toLowerCase();
  if (status === "cancelled") return false;
  return status !== "refunded" || transactionType(transaction) === "refund";
}

function resolveProjectId(state, requestedProjectId) {
  if (requestedProjectId !== undefined && requestedProjectId !== null) {
    return typeof requestedProjectId === "object" ? requestedProjectId.id : requestedProjectId;
  }
  const project = asArray(state?.projects)[0];
  if (project?.id !== undefined) return project.id;
  return asArray(state?.transactions)[0]?.project_id ?? null;
}

function rowsForProject(rows, projectId, allowedIds, idReader) {
  return asArray(rows).filter((row) => {
    if (projectId === null) return true;
    if (row?.project_id !== undefined && row.project_id !== projectId) return false;
    const relatedId = idReader ? idReader(row) : null;
    if (allowedIds && relatedId !== null && !allowedIds.has(relatedId)) return false;
    return row?.project_id === projectId || (allowedIds && relatedId !== null && allowedIds.has(relatedId));
  });
}

function calculateSettlements(balances) {
  const debtors = balances
    .filter((entry) => entry.balance < 0)
    .map((entry) => ({ member_id: entry.member_id, left: -entry.balance }));
  const creditors = balances
    .filter((entry) => entry.balance > 0)
    .map((entry) => ({ member_id: entry.member_id, left: entry.balance }));
  const settlements = [];
  let debtorIndex = 0;
  let creditorIndex = 0;
  while (debtorIndex < debtors.length && creditorIndex < creditors.length) {
    const amount = Math.min(debtors[debtorIndex].left, creditors[creditorIndex].left);
    if (amount > 0) {
      settlements.push({
        from_member_id: debtors[debtorIndex].member_id,
        to_member_id: creditors[creditorIndex].member_id,
        amount,
      });
    }
    debtors[debtorIndex].left -= amount;
    creditors[creditorIndex].left -= amount;
    if (debtors[debtorIndex].left === 0) debtorIndex += 1;
    if (creditors[creditorIndex].left === 0) creditorIndex += 1;
  }
  return settlements;
}

function calculateSplit(state, requestedProjectId) {
  const projectId = resolveProjectId(state, requestedProjectId);
  const members = asArray(state?.project_members).filter((row) => projectId === null || row.project_id === projectId);
  const transactions = asArray(state?.transactions).filter((row) => (projectId === null || row.project_id === projectId) && activeTransaction(row));
  const transactionsById = new Map(transactions.map((row) => [row.id, row]));
  const transactionIds = new Set(transactions.map((row) => row.id));
  const items = rowsForProject(state?.transaction_items, projectId, transactionIds, transactionId);
  const itemIds = new Set(items.map((row) => row.id));
  const itemTransactions = new Map(items.map((row) => [row.id, transactionId(row)]));
  const payments = rowsForProject(state?.transaction_payments, projectId, transactionIds, transactionId)
    .filter((row) => activePayment(row, transactionsById.get(transactionId(row))));
  const allocations = asArray(state?.item_allocations).filter((row) => {
    if (projectId === null) return true;
    if (row?.project_id !== undefined && row.project_id !== projectId) return false;
    const itemId = transactionItemId(row);
    const directTransactionId = transactionId(row);
    if (itemId !== null && itemIds.has(itemId)) return true;
    return directTransactionId !== null && transactionIds.has(directTransactionId);
  });
  const burdens = Object.fromEntries(members.map((member) => [member.id, 0]));
  const advances = Object.fromEntries(members.map((member) => [member.id, 0]));
  for (const payment of payments) {
    const memberId = projectMemberId(payment);
    if (Object.prototype.hasOwnProperty.call(advances, memberId)) {
      advances[memberId] += asSafeInteger(payment.amount, "payment amount");
    }
  }
  for (const allocation of allocations) {
    const itemId = transactionItemId(allocation);
    const directTransactionId = transactionId(allocation);
    const relatedTransactionId = directTransactionId ?? itemTransactions.get(itemId);
    const memberId = projectMemberId(allocation);
    if (transactionIds.has(relatedTransactionId) && Object.prototype.hasOwnProperty.call(burdens, memberId)) {
      burdens[memberId] += asSafeInteger(allocationAmount(allocation), "allocation amount");
    }
  }
  const balances = members.map((member) => {
    const burden = burdens[member.id] ?? 0;
    const advance = advances[member.id] ?? 0;
    return {
      member_id: member.id,
      project_member_id: member.id,
      member,
      m: member,
      burden,
      advance,
      balance: advance - burden,
    };
  });
  const settlements = calculateSettlements(balances);
  const membersById = new Map(members.map((member) => [member.id, member]));
  const transfers = settlements.map((settlement) => ({
    from: membersById.get(settlement.from_member_id),
    to: membersById.get(settlement.to_member_id),
    from_member_id: settlement.from_member_id,
    to_member_id: settlement.to_member_id,
    amount: settlement.amount,
  }));
  const totalBurden = balances.reduce((sum, entry) => sum + entry.burden, 0);
  const totalAdvance = balances.reduce((sum, entry) => sum + entry.advance, 0);
  return {
    project_id: projectId,
    members,
    transactions,
    payments,
    items,
    allocations,
    burdens,
    advances,
    balances,
    settlements,
    transfers,
    total_burden: totalBurden,
    total_advance: totalAdvance,
    difference: totalAdvance - totalBurden,
  };
}

function addIssue(issues, code, transactionIdValue, details = {}) {
  issues.push({ code, transaction_id: transactionIdValue, ...details });
}

function isSafeIntegerValue(value) {
  return Number.isSafeInteger(value);
}

function validateProjectTransactions(state, requestedProjectId) {
  const projectId = resolveProjectId(state, requestedProjectId);
  const members = asArray(state?.project_members).filter((row) => projectId === null || row.project_id === projectId);
  const memberIds = new Set(members.map((row) => row.id));
  const allTransactions = asArray(state?.transactions).filter((row) => projectId === null || row.project_id === projectId);
  const transactions = allTransactions.filter(activeTransaction);
  const transactionIds = new Set(allTransactions.map((row) => row.id));
  const allPayments = rowsForProject(state?.transaction_payments, projectId, transactionIds, transactionId);
  const allItems = rowsForProject(state?.transaction_items, projectId, transactionIds, transactionId);
  const allItemIds = new Set(allItems.map((row) => row.id));
  const allAllocations = asArray(state?.item_allocations).filter((row) => {
    if (projectId === null) return true;
    if (row?.project_id !== undefined && row.project_id !== projectId) return false;
    return allItemIds.has(transactionItemId(row)) || transactionIds.has(transactionId(row));
  });
  const issues = [];
  const results = [];
  const seenTransactionIds = new Set();
  for (const transaction of transactions) {
    const currentIssues = [];
    if (seenTransactionIds.has(transaction.id)) {
      addIssue(currentIssues, "duplicate_transaction", transaction.id);
    }
    seenTransactionIds.add(transaction.id);
    const amountValue = transactionAmount(transaction);
    if (!isSafeIntegerValue(amountValue)) {
      addIssue(currentIssues, "transaction_amount_not_integer", transaction.id, { value: amountValue });
    }
    const amount = isSafeIntegerValue(amountValue) ? amountValue : 0;
    const payments = allPayments.filter((row) => transactionId(row) === transaction.id);
    const countedPayments = payments.filter((row) => activePayment(row, transaction));
    const items = allItems.filter((row) => transactionId(row) === transaction.id);
    const itemIds = new Set(items.map((row) => row.id));
    const allocations = allAllocations.filter((row) => {
      const directTransactionId = transactionId(row);
      return directTransactionId === transaction.id || itemIds.has(transactionItemId(row));
    });
    for (const payment of payments) {
      if (!isSafeIntegerValue(payment.amount)) {
        addIssue(currentIssues, "payment_amount_not_integer", transaction.id, { payment_id: payment.id, value: payment.amount });
      }
      if (!memberIds.has(projectMemberId(payment))) {
        addIssue(currentIssues, "payment_member_not_found", transaction.id, { payment_id: payment.id });
      }
    }
    for (const item of items) {
      if (!isSafeIntegerValue(item.amount)) {
        addIssue(currentIssues, "item_amount_not_integer", transaction.id, { item_id: item.id, value: item.amount });
      }
      const itemAllocations = allocations.filter((row) => transactionItemId(row) === item.id);
      if (itemAllocations.length === 0) {
        addIssue(currentIssues, "item_without_allocations", transaction.id, { item_id: item.id });
      }
      for (const allocation of itemAllocations) {
        const allocatedAmount = allocationAmount(allocation);
        if (!isSafeIntegerValue(allocatedAmount)) {
          addIssue(currentIssues, "allocation_amount_not_integer", transaction.id, { allocation_id: allocation.id, value: allocatedAmount });
        }
        if (!memberIds.has(projectMemberId(allocation))) {
          addIssue(currentIssues, "allocation_member_not_found", transaction.id, { allocation_id: allocation.id });
        }
      }
      const itemAmount = isSafeIntegerValue(item.amount) ? item.amount : 0;
      const itemAllocationTotal = itemAllocations.reduce(
        (sum, row) => {
          const allocatedAmount = allocationAmount(row);
          return sum + (isSafeIntegerValue(allocatedAmount) ? allocatedAmount : 0);
        },
        0,
      );
      if (itemAllocationTotal !== itemAmount) {
        addIssue(currentIssues, "item_allocation_total_mismatch", transaction.id, {
          item_id: item.id,
          expected: itemAmount,
          actual: itemAllocationTotal,
        });
      }
    }
    if (items.length === 0) {
      addIssue(currentIssues, "transaction_without_items", transaction.id);
    }
    const paymentTotal = countedPayments.reduce(
      (sum, row) => sum + (isSafeIntegerValue(row.amount) ? row.amount : 0),
      0,
    );
    const itemTotal = items.reduce(
      (sum, row) => sum + (isSafeIntegerValue(row.amount) ? row.amount : 0),
      0,
    );
    const allocationTotal = allocations.reduce(
      (sum, row) => {
        const allocatedAmount = allocationAmount(row);
        return sum + (isSafeIntegerValue(allocatedAmount) ? allocatedAmount : 0);
      },
      0,
    );
    if (paymentTotal !== amount) {
      addIssue(currentIssues, "payment_total_mismatch", transaction.id, { expected: amount, actual: paymentTotal });
    }
    if (itemTotal !== amount) {
      addIssue(currentIssues, "item_total_mismatch", transaction.id, { expected: amount, actual: itemTotal });
    }
    if (allocationTotal !== amount) {
      addIssue(currentIssues, "allocation_total_mismatch", transaction.id, { expected: amount, actual: allocationTotal });
    }
    issues.push(...currentIssues);
    results.push({
      transaction_id: transaction.id,
      valid: currentIssues.length === 0,
      amount,
      payment_total: paymentTotal,
      item_total: itemTotal,
      allocation_total: allocationTotal,
      issues: currentIssues,
    });
  }
  for (const payment of allPayments) {
    const relatedId = transactionId(payment);
    if (relatedId !== null && !transactionIds.has(relatedId)) {
      addIssue(issues, "payment_transaction_not_found", relatedId, { payment_id: payment.id });
    }
  }
  for (const item of allItems) {
    const relatedId = transactionId(item);
    if (relatedId !== null && !transactionIds.has(relatedId)) {
      addIssue(issues, "item_transaction_not_found", relatedId, { item_id: item.id });
    }
  }
  return {
    valid: issues.length === 0,
    project_id: projectId,
    transactions: results,
    issues,
    errors: issues.map((issue) => issue.code),
  };
}

function aggregateHousehold(state, requestedProjectId) {
  const projectId = resolveProjectId(state, requestedProjectId);
  const included = [];
  const seenIds = new Set();
  for (const transaction of asArray(state?.transactions)) {
    if (projectId !== null && transaction.project_id !== projectId) continue;
    const status = transactionStatus(transaction);
    const type = transactionType(transaction);
    const includedStatus = status === "confirmed" || status === "corrected" || status === "refunded" && type === "refund";
    if (!includedStatus) continue;
    if (!["purchase", "split_expense", "refund", "adjustment"].includes(type)) continue;
    const identity = transaction.id ?? transaction;
    if (seenIds.has(identity)) continue;
    seenIds.add(identity);
    included.push(transaction);
  }
  const byType = {
    purchase: { count: 0, amount: 0 },
    split_expense: { count: 0, amount: 0 },
  };
  let total = 0;
  for (const transaction of included) {
    const amount = asSafeInteger(transactionAmount(transaction), "transaction amount");
    const type = transactionType(transaction);
    total += amount;
    byType[type].count += 1;
    byType[type].amount += amount;
  }
  return {
    project_id: projectId,
    transactions: included,
    count: included.length,
    transaction_count: included.length,
    total,
    total_amount: total,
    by_type: byType,
  };
}

const api = {
  splitAmount,
  calculateSplit,
  validateProjectTransactions,
  aggregateHousehold,
};

if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof globalThis !== "undefined") globalThis.WariSplit = api;
})();
