import * as ApiModule from "./modules/api.js?v=20260713-personal-household";
import * as ImportsModule from "./modules/imports.js?v=20260712-ledger6";
import * as HouseholdModule from "./modules/household.js?v=20260713-personal-household";

const Storage = globalThis.WariStorage;
const Split = globalThis.WariSplit;

function moduleApi(moduleValue, globalName) {
  const named = Object.fromEntries(Object.entries(moduleValue).filter(([key]) => key !== "default"));
  return { ...(globalThis[globalName] || {}), ...(moduleValue.default || {}), ...named };
}

const Api = moduleApi(ApiModule, "WariApi");
const Imports = moduleApi(ImportsModule, "WariImports");
const Household = moduleApi(HouseholdModule, "WariHousehold");
const STATE_KEYS = [
  "projects",
  "project_members",
  "transactions",
  "transaction_payments",
  "transaction_items",
  "item_allocations",
  "import_records",
];
const TABLE_ORDER = {
  projects: 0,
  project_members: 1,
  transactions: 2,
  transaction_payments: 3,
  transaction_items: 4,
  item_allocations: 5,
  import_records: 6,
};
const PAYMENT_METHODS = {
  cash: "現金",
  credit_card: "クレジットカード",
  paypay: "PayPay",
  suica: "Suica",
  pasmo: "PASMO",
  bank: "銀行",
  point: "ポイント",
  other: "その他",
};
const SOURCE_TYPES = {
  receipt: "レシート",
  gmail_notification: "通知",
  card_csv: "カードCSV",
  paypay_csv: "PayPay CSV",
  bank_csv: "銀行CSV",
  manual: "CSV",
};
const STATUS_LABELS = {
  provisional: "仮",
  confirmed: "確定",
  cancelled: "取消",
  refunded: "返金",
  corrected: "訂正",
};
const PROJECT_TYPES = {
  split: "割り勘",
  household: "家計簿",
};

if (!Storage || !Split) throw new Error("WariStorage and WariSplit are required");

let state = Storage.loadState();
let isCloud = false;
let cloudSession = { status: "checking", user: null };
let savingCount = 0;
let activeProjectId = null;
let lastToastTimer = 0;
let remoteSyncQueue = Promise.resolve();
const gmailUi = { connections: [], candidates: [], total_count: 0, has_more: false, from_date: gmailDefaultFromDate(), to_date: gmailDefaultToDate() };
const gmailSyncing = new Set();
const gmailSyncProgress = new Map();
const gmailSelected = new Set();
const shareTokensByProject = new Map();
const ui = {
  createMode: null,
  draftNames: [],
  splitTab: "transactions",
  householdTab: "transactions",
  selectedTransactionId: null,
  showSplitForm: false,
  showHouseholdForm: false,
  householdMonth: "",
  calendarMonth: today().slice(0, 7),
  calendarDay: today(),
  calendarView: "calendar",
  calendarEntryOpen: false,
  calendarTransactionId: null,
  householdSummaries: {},
  csvPreview: null,
  csvSourceType: "",
  drafts: {
    createSplit: { name: "", participant: "", store: "", amount: "", payer: "", occurred_at: today() },
    createHousehold: { name: "", owner_name: "自分" },
    split: { store: "", amount: "", payer: "", occurred_at: today(), status: "confirmed" },
  },
  ocr: {
    createSplit: { status: "", type: "", items: [] },
    split: { status: "", type: "", items: [] },
  },
};

function now() {
  return new Date().toISOString();
}

function today() {
  const date = new Date();
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

function makeId(prefix) {
  if (globalThis.crypto?.randomUUID) return `${prefix}_${globalThis.crypto.randomUUID()}`;
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function esc(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  }[character]));
}

function integer(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? Math.round(number) : 0;
}

function entryTypeForAmount(amount, currentType = "purchase") {
  if (!["purchase", "refund"].includes(currentType)) return currentType;
  return integer(amount) < 0 ? "refund" : "purchase";
}

function includedLedgerTransaction(transaction) {
  const status = String(transaction?.status || "").toLowerCase();
  if (status === "cancelled") return false;
  return status !== "refunded" || transaction?.entry_type === "refund";
}

function confirmedLedgerTransaction(transaction) {
  const status = String(transaction?.status || "").toLowerCase();
  const type = String(transaction?.entry_type || "").toLowerCase();
  const includedStatus = status === "confirmed" || status === "corrected" || status === "refunded" && type === "refund";
  return includedStatus && ["purchase", "split_expense", "refund", "adjustment"].includes(type);
}

function yen(value) {
  return `${integer(value).toLocaleString("ja-JP")}円`;
}

function formatDate(value, withTime = false) {
  if (!value) return "未設定";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 10);
  return new Intl.DateTimeFormat("ja-JP", withTime
    ? { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }
    : { year: "numeric", month: "numeric", day: "numeric" }).format(date);
}

function dateValue(value) {
  return String(value || today()).slice(0, 10);
}

function normalizeMerchant(value) {
  return String(value || "").trim().toLowerCase();
}

function cloneState(source = state) {
  const next = Storage.createEmptyState();
  for (const key of STATE_KEYS) next[key] = (source[key] || []).map((row) => ({ ...row }));
  return next;
}

function saveLocal() {
  state = Storage.saveState(state);
}

function toast(message) {
  const element = document.querySelector("#toast");
  if (!element) return;
  element.textContent = message;
  element.classList.add("show");
  clearTimeout(lastToastTimer);
  lastToastTimer = setTimeout(() => element.classList.remove("show"), 2200);
}

function gmailSyncMessage(run, totals = null) {
  const status = run?.status;
  const summary = totals || run || {};
  const candidates = Number(summary.candidate_count || 0);
  const processed = Number(summary.processed_count || 0);
  const duplicates = Number(summary.duplicate_count || 0);
  if (status === "completed") {
    if (totals) return candidates > 0
      ? `同期完了: 検索${Number(summary.listed_count || 0)}件、新規候補${candidates}件、処理${processed}件、重複${duplicates}件`
      : `同期完了: 検索${Number(summary.listed_count || 0)}件、新しい候補はありません`;
    return candidates > 0
      ? `同期完了: 新規候補${candidates}件、処理${processed}件、重複${duplicates}件`
      : "同期完了: 新しい候補はありません";
  }
  const messages = {
    partial: "Gmail同期が一部完了しました。取得できないメールがあります",
    failed: "Gmail同期に失敗しました",
    rate_limited: "Gmailの利用制限に達しました。時間をおいて再試行してください",
    reauthorization_required: "Gmailの再認証が必要です。接続を確認してください",
  };
  const codes = {
    gmail_api_error: "Gmail APIとの通信に失敗しました",
    gmail_rate_limited: "Gmailの利用制限に達しました",
    gmail_reauthorization_required: "Gmailの再認証が必要です",
    gmail_personal_household_lost: "本人の家計簿を確認できません",
  };
  return codes[run?.error_code] || messages[status] || "Gmail同期を完了できませんでした";
}

function gmailSyncTotalsMessage(totals) {
  return `同期完了: 検索${totals.listed_count}件、新規候補${totals.candidate_count}件、重複${totals.duplicate_count}件、除外${totals.ignored_count}件`;
}

function renderGmailProgress() {
  const section = [...document.querySelectorAll(".import-section")].find((row) => row.querySelector("[data-gmail-sync],[data-gmail-candidate-form],[data-gmail-connect]"));
  if (!section) return;
  let element = section.querySelector("[data-gmail-progress]");
  if (!element) {
    element = document.createElement("div");
    element.dataset.gmailProgress = "true";
    element.className = "review-row-value";
    element.style.whiteSpace = "pre-line";
    section.prepend(element);
  }
  const progress = [...gmailSyncProgress.values()][0];
  element.textContent = progress
    ? `Gmail同期中\n確認済み: ${progress.listed_count} / 1000件\n新規候補: ${progress.candidate_count}件\n重複: ${progress.duplicate_count}件\n除外: ${progress.ignored_count}件\n取込対象: 三井住友カード`
    : "Gmail取込対象: 三井住友カード";
}

function renderGmailCandidateControls() {
  const section = [...document.querySelectorAll(".import-section")].find((row) => row.querySelector("[data-gmail-sync],[data-gmail-candidate-form],[data-gmail-connect]"));
  if (!section) return;
  let controls = section.querySelector("[data-gmail-period-controls]");
  if (!controls) {
    controls = document.createElement("div");
    controls.dataset.gmailPeriodControls = "true";
    controls.className = "form-panel form-stack";
    controls.innerHTML = '<div class="field-grid"><label class="field">開始日<input class="input" type="date" data-gmail-from-date></label><label class="field">終了日<input class="input" type="date" data-gmail-to-date></label></div><p>取引日時はメール受信時刻を使用します</p><p>検索対象: 三井住友カード</p>';
    section.prepend(controls);
  }
  controls.querySelector("[data-gmail-from-date]").value = gmailUi.from_date;
  controls.querySelector("[data-gmail-to-date]").value = gmailUi.to_date;
  let toolbar = section.querySelector("[data-gmail-candidate-toolbar]");
  if (!toolbar) {
    toolbar = document.createElement("div");
    toolbar.dataset.gmailCandidateToolbar = "true";
    toolbar.className = "review-actions";
    section.insertBefore(toolbar, section.querySelector("[data-gmail-period-controls]").nextSibling);
  }
  const selected = gmailUi.candidates.filter((row) => gmailSelected.has(row.id));
  const applicable = selected.filter((row) => row.status === "ready" && String(row.merchant_name || "").trim() && Number.isSafeInteger(row.amount) && row.amount !== 0 && row.occurred_at);
  const needsReview = selected.length - applicable.length;
  const amount = applicable.reduce((sum, row) => sum + Number(row.amount), 0);
  toolbar.innerHTML = `<span>選択: ${selected.length}件 / ${yen(amount)}、適用可能: ${applicable.length}件、確認が必要: ${needsReview}件</span><button class="small-button" type="button" data-gmail-select-all>表示中をすべて選択</button><button class="small-button" type="button" data-gmail-clear-selection>選択解除</button><button class="small-button household-small" type="button" data-gmail-bulk-import ${applicable.length ? "" : "disabled"}>一括適用</button><button class="small-button" type="button" data-gmail-bulk-ignore ${selected.length ? "" : "disabled"}>一括破棄</button><span>表示: ${gmailUi.candidates.length} / ${gmailUi.total_count}${gmailUi.has_more ? "（続きあり）" : ""}</span>`;
  for (const form of section.querySelectorAll("[data-gmail-candidate-form]")) {
    const id = form.dataset.gmailCandidateForm;
    let checkbox = form.querySelector("[data-gmail-select]");
    if (!checkbox) {
      checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.dataset.gmailSelect = id;
      checkbox.setAttribute("aria-label", "候補を選択");
      form.prepend(checkbox);
    }
    checkbox.checked = gmailSelected.has(id);
  }
}

function gmailDefaultToDate() {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
}

function gmailDefaultFromDate() {
  return `${gmailDefaultToDate().slice(0, 8)}01`;
}

function validGmailDateRange(fromDate, toDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(fromDate) || !/^\d{4}-\d{2}-\d{2}$/u.test(toDate)) return false;
  const start = Date.parse(`${fromDate}T00:00:00+09:00`);
  const end = Date.parse(`${toDate}T00:00:00+09:00`);
  return Number.isFinite(start) && Number.isFinite(end) && end >= start && end - start <= 89 * 86400000;
}

async function syncGmailImport(connectionId, days) {
  if (gmailSyncing.has(connectionId)) return;
  if (!validGmailDateRange(gmailUi.from_date, gmailUi.to_date)) { toast("Gmail同期期間は90日以内で、開始日を終了日以前にしてください"); return; }
  gmailSyncing.add(connectionId);
  render();
  const syncButton = document.querySelector(`[data-gmail-sync="${CSS.escape(connectionId)}"]`);
  if (syncButton) syncButton.disabled = true;
  const totals = { listed_count: 0, processed_count: 0, candidate_count: 0, duplicate_count: 0, ignored_count: 0, error_count: 0 };
  gmailSyncProgress.set(connectionId, totals);
  renderGmailProgress();
  let pageToken = null;
  let queryAfter = null;
  let queryBefore = null;
  let lastRun = { status: "completed" };
  try {
    for (let page = 0; page < 25 && totals.listed_count < 1000; page += 1) {
      const options = { batch_size: 40, from_date: gmailUi.from_date, to_date: gmailUi.to_date };
      if (pageToken) options.page_token = pageToken;
      if (queryAfter !== null) options.query_after = queryAfter;
      if (queryBefore !== null) options.query_before = queryBefore;
      const result = await Api.syncGmail(connectionId, days, options);
      lastRun = result?.run || { status: "failed", error_code: "gmail_sync_error" };
      totals.listed_count += Number(result?.listed_count ?? lastRun.listed_count ?? 0);
      totals.processed_count += Number(result?.processed_count ?? lastRun.processed_count ?? 0);
      totals.candidate_count += Number(result?.candidate_count ?? lastRun.candidate_count ?? 0);
      totals.duplicate_count += Number(result?.duplicate_count ?? lastRun.duplicate_count ?? 0);
      totals.ignored_count += Number(result?.ignored_count ?? lastRun.ignored_count ?? 0);
      totals.error_count += Number(result?.error_count ?? lastRun.error_count ?? 0);
      gmailSyncProgress.set(connectionId, { ...totals });
      if (queryAfter === null && result?.query_after !== undefined) queryAfter = result.query_after;
      if (queryBefore === null && result?.query_before !== undefined) queryBefore = result.query_before;
      if (lastRun.status !== "completed") {
        toast(gmailSyncMessage(lastRun, totals));
        return;
      }
      await refreshGmailImport(false);
      render();
      renderGmailProgress();
      pageToken = result?.next_page_token || null;
      if (totals.listed_count < 1000 && result?.has_more && pageToken) toast(`Gmail同期中: ${Math.min(totals.listed_count, 1000)} / 1000件`);
      if (!result?.has_more || !pageToken) break;
    }
    if (totals.listed_count >= 1000 && pageToken) toast("同期完了: 上限1000件まで確認しました");
    else if (pageToken && totals.listed_count < 1000) toast("同期完了: 25ページを確認しました。続きがあります");
    else toast(gmailSyncTotalsMessage(totals));
  } catch (error) {
    toast(error.message || "Gmail同期を実行できませんでした");
  } finally {
    gmailSyncing.delete(connectionId);
    gmailSyncProgress.delete(connectionId);
    gmailSelected.clear();
    await refreshGmailImport();
    render();
    const refreshedButton = document.querySelector(`[data-gmail-sync="${CSS.escape(connectionId)}"]`);
    if (refreshedButton) refreshedButton.disabled = false;
  }
}

function statusText() {
  if (savingCount > 0) return "保存中";
  return isCloud ? "クラウド" : "この端末";
}

function renderStatus() {
  const element = document.querySelector("#save-status");
  if (element) element.textContent = statusText();
}

function rowChanged(left, right) {
  return JSON.stringify(left) !== JSON.stringify(right);
}

function diffStates(before, after) {
  const creates = [];
  const updates = [];
  const deletes = [];
  const generatedTransactionIds = new Set([
    ...before.transactions.filter((row) => row.generated_automatically === 1).map((row) => row.id),
    ...after.transactions.filter((row) => row.generated_automatically === 1).map((row) => row.id),
  ]);
  const generatedItemIds = new Set([
    ...before.transaction_items.filter((row) => generatedTransactionIds.has(transactionId(row))).map((row) => row.id),
    ...after.transaction_items.filter((row) => generatedTransactionIds.has(transactionId(row))).map((row) => row.id),
  ]);
  const generatedOperation = (table, row) => {
    if (table === "transactions") return generatedTransactionIds.has(row.id);
    if (table === "transaction_payments" || table === "transaction_items") return generatedTransactionIds.has(transactionId(row));
    if (table === "item_allocations") return generatedItemIds.has(itemId(row));
    return false;
  };
  for (const table of STATE_KEYS) {
    const oldRows = new Map((before[table] || []).map((row) => [row.id, row]));
    const newRows = new Map((after[table] || []).map((row) => [row.id, row]));
    for (const [id, row] of oldRows) {
      if (!newRows.has(id)) deletes.push({ action: "delete", table, id, row, previous: row, generated: generatedOperation(table, row) });
    }
    for (const [id, row] of newRows) {
      if (!oldRows.has(id)) creates.push({ action: "create", table, id, row, previous: null, generated: generatedOperation(table, row) });
      else if (rowChanged(oldRows.get(id), row)) updates.push({ action: "update", table, id, row, previous: oldRows.get(id), generated: generatedOperation(table, row) });
    }
  }
  creates.sort((left, right) => TABLE_ORDER[left.table] - TABLE_ORDER[right.table]);
  updates.sort((left, right) => TABLE_ORDER[left.table] - TABLE_ORDER[right.table]);
  deletes.sort((left, right) => TABLE_ORDER[right.table] - TABLE_ORDER[left.table]);
  return [...creates, ...updates, ...deletes];
}

function transactionId(row) {
  return row?.transaction_id ?? row?.expense_id ?? null;
}

function itemId(row) {
  return row?.transaction_item_id ?? row?.item_id ?? null;
}

function projectIdForOperation(operation) {
  const row = operation.row || {};
  if (operation.table === "projects") return row.id;
  if (operation.table === "project_members" || operation.table === "transactions" || operation.table === "import_records") return row.project_id;
  if (operation.table === "transaction_payments") return state.transactions.find((value) => value.id === transactionId(row))?.project_id;
  if (operation.table === "transaction_items") return state.transactions.find((value) => value.id === transactionId(row))?.project_id;
  if (operation.table === "item_allocations") {
    const item = state.transaction_items.find((value) => value.id === itemId(row));
    return state.transactions.find((value) => value.id === transactionId(item))?.project_id;
  }
  return null;
}

async function requestApi(path, options = {}) {
  const requester = Api.request || Api.apiRequest || Api.fetchJson;
  if (typeof requester === "function") return requester(path, options);
  const { json, ...requestOptions } = options;
  const response = await fetch(path, {
    ...requestOptions,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    body: json === undefined ? options.body : JSON.stringify(json),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || data.error || `HTTP ${response.status}`);
  return data;
}

function remoteMethodNames(operation) {
  const singular = {
    projects: "Project",
    project_members: "ProjectMember",
    transactions: "Transaction",
    transaction_payments: "TransactionPayment",
    transaction_items: "TransactionItem",
    item_allocations: "ItemAllocation",
    import_records: "ImportRecord",
  }[operation.table];
  const verb = operation.action === "create" ? "create" : operation.action === "update" ? "update" : "delete";
  return [`${verb}${singular}`, `${verb}Row`];
}

function remotePath(operation) {
  const row = operation.row || {};
  const encodedId = encodeURIComponent(operation.id);
  if (operation.table === "projects") return operation.action === "create" ? "/api/projects" : `/api/projects/${encodedId}`;
  if (operation.table === "project_members") return operation.action === "create"
    ? `/api/projects/${encodeURIComponent(row.project_id)}/members`
    : `/api/project-members/${encodedId}`;
  if (operation.table === "transactions") return operation.action === "create"
    ? `/api/projects/${encodeURIComponent(row.project_id)}/transactions`
    : `/api/transactions/${encodedId}`;
  if (operation.table === "transaction_payments") return operation.action === "create"
    ? `/api/transactions/${encodeURIComponent(transactionId(row))}/payments`
    : `/api/transaction-payments/${encodedId}`;
  if (operation.table === "transaction_items") return operation.action === "create"
    ? `/api/transactions/${encodeURIComponent(transactionId(row))}/items`
    : `/api/transaction-items/${encodedId}`;
  if (operation.table === "item_allocations") return operation.action === "create"
    ? `/api/transaction-items/${encodeURIComponent(itemId(row))}/allocations`
    : `/api/item-allocations/${encodedId}`;
  if (operation.table === "import_records") return operation.action === "create"
    ? `/api/projects/${encodeURIComponent(row.project_id)}/imports`
    : `/api/import-records/${encodedId}`;
  throw new Error(`Unknown table: ${operation.table}`);
}

async function syncOperation(operation) {
  if (operation.generated) return null;
  if (operation.table === "projects" && operation.action === "update") {
    const fields = ["name", "project_type", "currency"];
    if (!fields.some((field) => operation.previous?.[field] !== operation.row[field])) return null;
  }
  if (operation.table === "project_members" && operation.action === "update" && typeof Api.updateProjectMember === "function") {
    const result = await Api.updateProjectMember(operation.id, operation.row);
    if (operation.previous?.linked_household_project_id !== operation.row.linked_household_project_id) {
      const householdProjectId = operation.row.linked_household_project_id;
      await requestApi(`/api/project-members/${encodeURIComponent(operation.id)}/household-link`, {
        method: "PATCH",
        json: householdProjectId ? { action: "link", household_project_id: householdProjectId } : { action: "unlink" },
      });
    }
    return result;
  }
  if (typeof Api.mutateRow === "function") return Api.mutateRow(operation);
  if (typeof Api.applyRowMutation === "function") return Api.applyRowMutation(operation);
  const [specific, generic] = remoteMethodNames(operation);
  if (typeof Api[specific] === "function") {
    if (operation.action === "create") return Api[specific](operation.row);
    if (operation.action === "update") return Api[specific](operation.id, operation.row);
    return Api[specific](operation.id, { projectId: projectIdForOperation(operation), row: operation.row });
  }
  if (typeof Api[generic] === "function") return Api[generic](operation.table, operation.id, operation.row);
  const method = operation.action === "create" ? "POST" : operation.action === "update" ? "PATCH" : "DELETE";
  return requestApi(remotePath(operation), {
    method,
    body: method === "DELETE" ? undefined : JSON.stringify(operation.row),
  });
}

async function syncOperations(operations, remoteAction = null) {
  if (!isCloud || operations.length === 0 && typeof remoteAction !== "function") return;
  savingCount += 1;
  renderStatus();
  try {
    const allocationItemIds = new Set();
    const atomicHouseholdMembers = new Set();
    const householdMemberByProject = new Map(operations
      .filter((operation) => operation.action === "create" && operation.table === "project_members" && operation.row.role === "owner")
      .map((operation) => [operation.row.project_id, operation]));
    for (const operation of operations) {
      if (operation.generated) continue;
      if (operation.action === "create" && operation.table === "project_members" && atomicHouseholdMembers.has(operation.id)) continue;
      if (operation.action === "create" && operation.table === "projects" && operation.row.project_type === "household") {
        const memberOperation = householdMemberByProject.get(operation.id);
        if (memberOperation) {
          atomicHouseholdMembers.add(memberOperation.id);
          await syncOperation({ ...operation, initialMember: memberOperation.row });
          continue;
        }
      }
      if (operation.table === "item_allocations") {
        allocationItemIds.add(itemId(operation.row));
        continue;
      }
      await syncOperation(operation);
    }
    for (const transactionItemId of allocationItemIds) {
      const item = state.transaction_items.find((row) => row.id === transactionItemId);
      if (!item || generatedTransactionForItem(item)) continue;
      await Api.replaceItemAllocations(transactionItemId, allocationsFor(transactionItemId));
    }
    if (typeof remoteAction === "function") await remoteAction();
  } catch (error) {
    toast(`端末へ保存しました。クラウド保存に失敗しました: ${error.message}`);
  } finally {
    savingCount -= 1;
    renderStatus();
  }
}

function commitState(next, message, options = {}) {
  const before = cloneState(state);
  state = cloneState(next);
  ui.householdSummaries = {};
  const operations = diffStates(before, state);
  saveLocal();
  if (options.render !== false) render();
  if (message) toast(message);
  const remoteOperations = typeof options.remoteFilter === "function" ? operations.filter(options.remoteFilter) : operations;
  const queuedSync = remoteSyncQueue.then(() => syncOperations(remoteOperations, options.remoteAction || null));
  remoteSyncQueue = queuedSync.catch(() => {});
  return queuedSync;
}

function generatedTransactionForItem(item) {
  return state.transactions.find((row) => row.id === transactionId(item))?.generated_automatically === 1;
}

function projectById(projectId) {
  return state.projects.find((row) => row.id === projectId) || null;
}

function currentProject() {
  const match = location.hash.match(/^#\/p\/([^/?]+)/);
  return match ? projectById(decodeURIComponent(match[1])) : null;
}

function membersFor(projectId, activeOnly = false) {
  return state.project_members.filter((row) => row.project_id === projectId && (!activeOnly || row.is_active !== 0));
}

function transactionsFor(projectId) {
  return state.transactions.filter((row) => row.project_id === projectId);
}

function paymentsFor(transactionIdValue) {
  return state.transaction_payments.filter((row) => transactionId(row) === transactionIdValue);
}

function itemsFor(transactionIdValue, includeHidden = true) {
  return state.transaction_items
    .filter((row) => transactionId(row) === transactionIdValue && (includeHidden || row.is_hidden !== 1))
    .sort((left, right) => Number(left.sort_order || 0) - Number(right.sort_order || 0));
}

function allocationsFor(transactionItemId) {
  return state.item_allocations.filter((row) => itemId(row) === transactionItemId);
}

function memberName(memberIdValue) {
  return state.project_members.find((row) => row.id === memberIdValue)?.display_name || "未設定";
}

function projectName(projectId) {
  return projectById(projectId)?.name || "削除済み";
}

function latestProjectUpdate(project) {
  const timestamps = [project.updated_at, project.created_at];
  const transactionIds = new Set(transactionsFor(project.id).map((row) => row.id));
  timestamps.push(...membersFor(project.id).flatMap((row) => [row.updated_at, row.created_at]));
  timestamps.push(...state.transactions.filter((row) => row.project_id === project.id).flatMap((row) => [row.updated_at, row.created_at]));
  timestamps.push(...state.import_records.filter((row) => row.project_id === project.id).flatMap((row) => [row.updated_at, row.created_at]));
  timestamps.push(...state.transaction_payments.filter((row) => transactionIds.has(transactionId(row))).flatMap((row) => [row.updated_at, row.created_at]));
  return timestamps.filter(Boolean).sort().at(-1) || "";
}

function projectSummary(project) {
  const transactions = transactionsFor(project.id).filter(includedLedgerTransaction);
  if (project.project_type === "split") {
    return {
      count: project.transaction_count ?? project.expense_count ?? transactions.length,
      total: project.total_amount ?? transactions.reduce((sum, row) => sum + integer(row.paid_amount), 0),
    };
  }
  const aggregate = Split.aggregateHousehold(state, project.id);
  return {
    count: project.transaction_count ?? aggregate.transaction_count,
    total: project.total_amount ?? aggregate.total_amount,
  };
}

function typeLabel(project) {
  return PROJECT_TYPES[project.project_type] || "家計簿";
}

function shell(content) {
  const account = cloudSession.status === "authenticated"
    ? `<span class="save-status">${esc(cloudSession.user?.name || cloudSession.user?.email || "ログイン中")}</span><button class="text-button" type="button" data-google-logout>ログアウト</button>`
    : cloudSession.status === "unauthenticated"
      ? `<button class="small-button" type="button" data-google-login>Googleでログイン</button>`
      : cloudSession.status === "error"
        ? `<span class="save-status">クラウド接続を確認できません</span>`
        : `<span class="save-status">認証を確認中</span>`;
  return `<div class="app-shell"><header class="topbar"><button class="brand" type="button" data-home aria-label="ホームへ"><span class="logo" aria-hidden="true">W</span><span>Wari</span></button><span><span id="save-status" class="save-status">${esc(statusText())}</span> ${account}</span></header>${content}</div>`;
}

function statusTag(status) {
  const normalized = STATUS_LABELS[status] ? status : "confirmed";
  return `<span class="status-tag status-${esc(normalized)}">${esc(STATUS_LABELS[normalized])}</span>`;
}

function transactionStatusTags(transaction) {
  const refund = transaction?.entry_type === "refund" && transaction?.status !== "refunded" ? statusTag("refunded") : "";
  return `${refund}${statusTag(transaction?.status)}`;
}

function projectRow(project) {
  const summary = projectSummary(project);
  const updated = latestProjectUpdate(project);
  const finalized = project.finalized_at ? `<span class="status-tag status-confirmed">確定済み</span>` : "";
  return `<button class="project-row" type="button" data-open-project="${esc(project.id)}"><span class="project-mark project-mark-${project.project_type === "split" ? "split" : "household"}" aria-hidden="true">${project.project_type === "split" ? "割" : "家"}</span><span class="project-row-main"><span class="project-row-top"><strong>${esc(project.name)}</strong><span class="project-type">${esc(typeLabel(project))}</span>${finalized}</span><span class="row-meta">${summary.count}件 ・ 更新 ${esc(formatDate(updated))}</span></span><span class="project-row-value"><strong>${esc(yen(summary.total))}</strong><span aria-hidden="true">›</span></span></button>`;
}

function householdProjects() {
  return state.projects
    .filter((project) => project.project_type === "household")
    .sort((left, right) => String(left.created_at || "").localeCompare(String(right.created_at || "")) || left.id.localeCompare(right.id));
}

function primaryHouseholdProject() {
  return householdProjects()[0] || null;
}

function calendarTransactions() {
  const project = primaryHouseholdProject();
  const projectIds = new Set(project ? [project.id] : []);
  return state.transactions
    .filter((transaction) => projectIds.has(transaction.project_id)
      && includedLedgerTransaction(transaction)
      && ["purchase", "split_expense", "refund", "adjustment"].includes(transaction.entry_type))
    .sort((left, right) => String(right.occurred_at).localeCompare(String(left.occurred_at)) || String(right.created_at).localeCompare(String(left.created_at)));
}

function shiftCalendarMonth(offset) {
  const [year, month] = ui.calendarMonth.split("-").map(Number);
  const shifted = new Date(year, month - 1 + offset, 1);
  ui.calendarMonth = `${shifted.getFullYear()}-${String(shifted.getMonth() + 1).padStart(2, "0")}`;
  ui.calendarDay = `${ui.calendarMonth}-01`;
}

function calendarMonthLabel() {
  const [year, month] = ui.calendarMonth.split("-").map(Number);
  return new Intl.DateTimeFormat("ja-JP", { year: "numeric", month: "long" }).format(new Date(year, month - 1, 1));
}

function renderCalendarTransactionRow(transaction) {
  const generated = transaction.generated_automatically === 1;
  const origin = generated ? `<span class="origin-label">割り勘から</span>` : "";
  return `<button class="transaction-row" type="button" data-open-calendar-transaction="${esc(transaction.id)}"><span class="transaction-date">${esc(dateValue(transaction.occurred_at).slice(5).replace("-", "/"))}</span><span class="transaction-main"><span><strong>${esc(transaction.merchant_name)}</strong>${origin}${transactionStatusTags(transaction)}</span><small>${esc(transaction.category || "未分類")}</small></span><strong class="transaction-amount">${esc(yen(transaction.paid_amount))}</strong><span class="row-chevron" aria-hidden="true">›</span></button>`;
}

function renderCalendarTabs() {
  return `<nav class="tab-bar calendar-tab-bar" aria-label="家計簿"><button class="tab-button ${ui.calendarView === "calendar" ? "active" : ""}" type="button" data-calendar-view="calendar" aria-current="${ui.calendarView === "calendar" ? "page" : "false"}">カレンダー</button><button class="tab-button ${ui.calendarView === "imports" ? "active" : ""}" type="button" data-calendar-view="imports" aria-current="${ui.calendarView === "imports" ? "page" : "false"}">取込</button><button class="tab-button ${ui.calendarView === "summary" ? "active" : ""}" type="button" data-calendar-view="summary" aria-current="${ui.calendarView === "summary" ? "page" : "false"}">集計</button></nav>`;
}

function renderCalendarEntryForm(project) {
  if (!ui.calendarEntryOpen || !project) return "";
  const owner = membersFor(project.id, true)[0];
  return `<form id="calendar-entry-form" class="form-panel form-stack calendar-entry-form"><div class="form-panel-head"><h3>支出を追加</h3><button class="icon-button" type="button" data-close-calendar-entry aria-label="閉じる">×</button></div><div class="field"><label for="calendar-merchant">店名</label><input id="calendar-merchant" class="input" name="merchant_name" placeholder="店名" required></div><div class="field-grid"><div class="field"><label for="calendar-amount">金額</label><input id="calendar-amount" class="input" name="paid_amount" type="number" inputmode="numeric" step="1" required><small>返金はマイナスで入力</small></div><div class="field"><label for="calendar-date">日付</label><input id="calendar-date" class="input" name="occurred_at" type="date" value="${esc(ui.calendarDay)}" required></div></div><div class="field-grid"><div class="field"><label for="calendar-category">分類</label><input id="calendar-category" class="input" name="category" placeholder="食費"></div><div class="field"><label for="calendar-method">支払方法</label><select id="calendar-method" name="payment_method">${paymentMethodOptions()}</select></div></div><input type="hidden" name="payer_member_id" value="${esc(owner?.id || "")}"><div class="field-grid"><div class="field"><label for="calendar-status">状態</label><select id="calendar-status" name="status"><option value="confirmed">確定</option><option value="provisional">仮</option></select></div><div class="field"><label for="calendar-note">メモ</label><input id="calendar-note" class="input" name="note"></div></div><button class="button household-button" type="submit" ${owner ? "" : "disabled"}>追加</button></form>`;
}

function renderHouseholdCalendar() {
  const transactions = calendarTransactions();
  const monthTransactions = transactions.filter((transaction) => String(transaction.occurred_at).slice(0, 7) === ui.calendarMonth);
  const byDay = new Map();
  for (const transaction of monthTransactions) {
    const day = dateValue(transaction.occurred_at);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(transaction);
  }
  const [year, month] = ui.calendarMonth.split("-").map(Number);
  const leading = new Date(year, month - 1, 1).getDay();
  const days = new Date(year, month, 0).getDate();
  const cells = [];
  for (let index = 0; index < leading; index += 1) cells.push(`<span class="calendar-blank" aria-hidden="true"></span>`);
  for (let day = 1; day <= days; day += 1) {
    const value = `${ui.calendarMonth}-${String(day).padStart(2, "0")}`;
    const rows = byDay.get(value) || [];
    const total = rows.reduce((sum, transaction) => sum + integer(transaction.paid_amount), 0);
    const selected = value === ui.calendarDay;
    cells.push(`<button class="calendar-day${selected ? " selected" : ""}${rows.length ? " has-entry" : ""}" type="button" data-calendar-day="${value}" aria-pressed="${selected}"><span>${day}</span>${rows.length ? `<strong>${esc(yen(total))}</strong><small>${rows.length}件</small>` : ""}</button>`);
  }
  while (cells.length < 42) cells.push(`<span class="calendar-blank" aria-hidden="true"></span>`);
  const selectedRows = byDay.get(ui.calendarDay) || [];
  const monthTotal = monthTransactions.reduce((sum, transaction) => sum + integer(transaction.paid_amount), 0);
  const selectedLabel = formatDate(ui.calendarDay);
  return `<section class="calendar-section" aria-labelledby="home-heading"><div class="page-heading calendar-heading"><div><h1 id="home-heading">家計簿</h1><span>${esc(yen(monthTotal))}</span></div><button class="button household-button calendar-add" type="button" data-add-calendar-entry>支出を追加</button></div>${renderCalendarTabs()}${renderCalendarEntryForm(primaryHouseholdProject())}<div class="calendar-toolbar"><button class="icon-button" type="button" data-calendar-previous aria-label="前の月">‹</button><strong>${esc(calendarMonthLabel())}</strong><button class="icon-button" type="button" data-calendar-next aria-label="次の月">›</button></div><div class="calendar-weekdays" aria-hidden="true">${["日", "月", "火", "水", "木", "金", "土"].map((label) => `<span>${label}</span>`).join("")}</div><div class="calendar-grid">${cells.join("")}</div><div class="calendar-day-summary"><div class="section-heading"><div><h2>${esc(selectedLabel)}</h2><span>${selectedRows.length}件</span></div></div><div class="transaction-list">${selectedRows.length ? selectedRows.map(renderCalendarTransactionRow).join("") : `<div class="empty-state compact-empty">記録はありません</div>`}</div></div></section>`;
}

function renderHome() {
  if (ui.calendarTransactionId) {
    const transaction = state.transactions.find((row) => row.id === ui.calendarTransactionId);
    const project = transaction ? projectById(transaction.project_id) : null;
    if (transaction && project) return shell(`<main class="page detail-page calendar-transaction-page">${renderTransactionDetail(project, transaction, false)}</main>`);
    ui.calendarTransactionId = null;
  }
  const projects = state.projects
    .filter((project) => project.project_type === "split")
    .sort((left, right) => latestProjectUpdate(right).localeCompare(latestProjectUpdate(left)));
  const list = projects.length ? projects.map(projectRow).join("") : `<div class="empty-state">記録はありません</div>`;
  const householdContent = ui.calendarView === "imports" ? renderCalendarImports() : ui.calendarView === "summary" ? renderCalendarSummary() : renderHouseholdCalendar();
  return shell(`<main class="page home-page">${householdContent}<section class="project-section" aria-labelledby="project-list-heading"><div class="section-heading"><div><h2 id="project-list-heading">割り勘</h2><span>${projects.length}件</span></div><button class="button primary-button split-create-button" type="button" data-create-mode="split">＋ 新規</button></div><div class="project-list">${list}</div></section></main>${renderCreateDialog()}`);
}

function draftValue(scope, field) {
  return esc(ui.drafts[scope]?.[field] ?? "");
}

function renderDraftNames() {
  if (!ui.draftNames.length) return `<span class="field-note">2人以上</span>`;
  return ui.draftNames.map((name, index) => `<span class="name-chip">${esc(name)}<button type="button" data-remove-draft-name="${index}" aria-label="${esc(name)}を外す">×</button></span>`).join("");
}

function renderOcrBox(target) {
  const receipt = ui.ocr[target];
  if (!receipt) return "";
  const items = receipt.items.length ? `<div class="ocr-preview"><div class="inline-heading"><strong>品目</strong><span>${receipt.items.length}件</span></div>${receipt.items.map((item, index) => `<div class="ocr-item"><input class="input" data-ocr-name="${target}:${index}" value="${esc(item.name)}" aria-label="品目名"><input class="input amount-input" type="number" inputmode="numeric" min="0" data-ocr-amount="${target}:${index}" value="${integer(item.amount)}" aria-label="品目金額"><button class="icon-button quiet" type="button" data-remove-ocr="${target}:${index}" aria-label="品目を削除">×</button></div>`).join("")}</div>` : "";
  return `<div class="receipt-control"><div class="file-actions"><label class="file-button"><input type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" data-receipt-target="${target}"><span>画像を選ぶ</span></label><label class="file-button secondary-button"><input type="file" accept="image/*" capture="environment" data-receipt-target="${target}"><span>撮影する</span></label></div><div class="field-message ${esc(receipt.type)}" aria-live="polite">${esc(receipt.status)}</div>${items}</div>`;
}

function renderCreateDialog() {
  if (!ui.createMode) return "";
  const title = "割り勘を作る";
  const body = renderCreateSplitForm();
  return `<dialog class="modal" open aria-modal="true" aria-labelledby="create-dialog-title"><div class="modal-head"><h2 id="create-dialog-title">${title}</h2><button class="icon-button" type="button" data-close-modal aria-label="閉じる">×</button></div>${body}</dialog><button class="modal-backdrop" type="button" data-close-modal aria-label="閉じる"></button>`;
}

function renderCreateSplitForm() {
  const payerOptions = ui.draftNames.map((name, index) => `<option value="${index}" ${String(index) === String(ui.drafts.createSplit.payer) ? "selected" : ""}>${esc(name)}</option>`).join("");
  return `<form id="create-split-form" class="form-stack"><div class="field"><label for="new-split-name">名前</label><input id="new-split-name" class="input" name="name" data-draft-scope="createSplit" data-draft-field="name" value="${draftValue("createSplit", "name")}" placeholder="7月の旅行"></div><div class="field"><label for="draft-participant">参加者</label><div class="input-action"><input id="draft-participant" class="input" data-draft-scope="createSplit" data-draft-field="participant" value="${draftValue("createSplit", "participant")}" placeholder="名前" autocomplete="off"><button class="icon-button add-button" type="button" data-add-draft-name aria-label="参加者を追加">＋</button></div><div class="name-chips">${renderDraftNames()}</div></div><fieldset class="form-group"><legend>最初のお店</legend><div class="field-grid"><div class="field"><label for="new-split-store">店名</label><input id="new-split-store" class="input" name="store" data-draft-scope="createSplit" data-draft-field="store" value="${draftValue("createSplit", "store")}" placeholder="店名"></div><div class="field"><label for="new-split-amount">金額</label><input id="new-split-amount" class="input" name="amount" type="number" inputmode="numeric" step="1" data-draft-scope="createSplit" data-draft-field="amount" value="${draftValue("createSplit", "amount")}" placeholder="0"><small>返金はマイナスで入力</small></div></div><div class="field-grid"><div class="field"><label for="new-split-date">日付</label><input id="new-split-date" class="input" name="occurred_at" type="date" data-draft-scope="createSplit" data-draft-field="occurred_at" value="${draftValue("createSplit", "occurred_at")}"></div><div class="field"><label for="new-split-payer">支払者</label><select id="new-split-payer" name="payer" data-draft-scope="createSplit" data-draft-field="payer" ${ui.draftNames.length ? "" : "disabled"}><option value="">選択</option>${payerOptions}</select></div></div>${renderOcrBox("createSplit")}</fieldset><button class="button primary-button" type="submit">作成</button></form>`;
}

function renderCreateHouseholdForm() {
  return `<form id="create-household-form" class="form-stack"><div class="field"><label for="new-household-name">名前</label><input id="new-household-name" class="input" name="name" data-draft-scope="createHousehold" data-draft-field="name" value="${draftValue("createHousehold", "name")}" placeholder="わが家の家計簿" required></div><div class="field"><label for="new-household-owner">記録者</label><input id="new-household-owner" class="input" name="owner_name" data-draft-scope="createHousehold" data-draft-field="owner_name" value="${draftValue("createHousehold", "owner_name")}" placeholder="自分" required></div><button class="button household-button" type="submit">作成</button></form>`;
}

function renderProjectHeader(project, tabs, activeTab) {
  return `<div class="project-header"><div class="project-title-row"><button class="icon-button back-button" type="button" data-home aria-label="一覧へ">←</button><div class="project-title"><div><span class="project-type">${esc(typeLabel(project))}</span>${project.finalized_at ? `<span class="status-tag status-confirmed">確定済み</span>` : ""}</div><h1>${esc(project.name)}</h1></div></div><nav class="tab-bar" aria-label="${esc(project.name)}">${tabs.map(([value, label]) => `<button class="tab-button ${activeTab === value ? "active" : ""}" type="button" data-project-tab="${value}" aria-current="${activeTab === value ? "page" : "false"}">${label}</button>`).join("")}</nav></div>`;
}

function renderProject() {
  const project = currentProject();
  if (!project) return renderHome();
  return project.project_type === "split" ? renderSplitProject(project) : renderHouseholdProject(project);
}

function renderSplitProject(project) {
  const transaction = ui.selectedTransactionId
    ? state.transactions.find((row) => row.id === ui.selectedTransactionId && row.project_id === project.id)
    : null;
  let content;
  if (transaction) content = renderTransactionDetail(project, transaction, true);
  else if (ui.splitTab === "members") content = renderSplitMembers(project);
  else if (ui.splitTab === "settlement") content = renderSplitSettlement(project);
  else content = renderSplitTransactions(project);
  return shell(`<main class="page detail-page">${renderProjectHeader(project, [["members", "参加者"], ["transactions", "お店"], ["settlement", "精算"]], ui.splitTab)}<div class="tab-content">${content}</div></main>`);
}

function householdOptions(selectedId = "") {
  const projects = state.projects.filter((row) => row.project_type === "household");
  return `<option value="">未連携</option>${projects.map((project) => `<option value="${esc(project.id)}" ${project.id === selectedId ? "selected" : ""}>${esc(project.name)}</option>`).join("")}`;
}

function renderSplitMembers(project) {
  const members = membersFor(project.id);
  const locked = Boolean(project.finalized_at);
  const rows = members.length ? members.map((member, index) => {
    const household = projectById(member.linked_household_project_id);
    return `<form class="member-row" data-member-edit="${esc(member.id)}"><span class="member-index" aria-hidden="true">${index + 1}</span><div class="member-fields"><div class="member-name-line"><input class="plain-input" name="display_name" value="${esc(member.display_name)}" aria-label="参加者名" required ${locked ? "disabled" : ""}><label class="switch"><input type="checkbox" name="is_active" ${member.is_active !== 0 ? "checked" : ""} ${locked ? "disabled" : ""}><span aria-hidden="true"></span><b>${member.is_active !== 0 ? "有効" : "休止"}</b></label></div><div class="member-link-line"><select name="linked_household_project_id" aria-label="連携する家計簿" ${locked ? "disabled" : ""}>${householdOptions(member.linked_household_project_id || "")}</select><span class="link-status ${household ? "linked" : ""}">${household ? "連携済み" : "未連携"}</span></div></div><button class="small-button" type="submit" ${locked ? "disabled" : ""}>保存</button></form>`;
  }).join("") : `<div class="empty-state">参加者はいません</div>`;
  return `<section aria-labelledby="members-title"><div class="section-heading"><div><h2 id="members-title">参加者</h2><span>${members.filter((row) => row.is_active !== 0).length}人が有効</span></div></div>${locked ? `<div class="notice">再開すると参加者を変更できます</div>` : `<form id="add-member-form" class="inline-form"><input class="input" name="display_name" placeholder="名前" required><button class="button primary-button" type="submit">追加</button></form>`}<div class="member-list">${rows}</div></section>`;
}

function memberOptions(projectId, selectedId = "", activeOnly = false) {
  return membersFor(projectId, activeOnly).map((member) => `<option value="${esc(member.id)}" ${member.id === selectedId ? "selected" : ""}>${esc(member.display_name)}${member.is_active === 0 ? "（休止）" : ""}</option>`).join("");
}

function paymentMethodOptions(selected = "other") {
  return Object.entries(PAYMENT_METHODS).map(([value, label]) => `<option value="${value}" ${value === selected ? "selected" : ""}>${label}</option>`).join("");
}

function renderTransactionRow(transaction) {
  const generated = transaction.generated_automatically === 1;
  const origin = generated ? `<span class="origin-label">割り勘から</span>` : "";
  return `<button class="transaction-row" type="button" data-open-transaction="${esc(transaction.id)}"><span class="transaction-date">${esc(dateValue(transaction.occurred_at).slice(5).replace("-", "/"))}</span><span class="transaction-main"><span><strong>${esc(transaction.merchant_name)}</strong>${origin}${transactionStatusTags(transaction)}</span><small>${esc(transaction.category || "未分類")}${generated ? ` ・ ${esc(projectName(transaction.origin_project_id))}` : ""}</small></span><strong class="transaction-amount">${esc(yen(transaction.paid_amount))}</strong><span class="row-chevron" aria-hidden="true">›</span></button>`;
}

function renderSplitTransactions(project) {
  const transactions = transactionsFor(project.id).sort((left, right) => String(right.occurred_at).localeCompare(String(left.occurred_at)));
  const activeMembers = membersFor(project.id, true);
  const form = project.finalized_at ? `<div class="notice">再開するとお店を変更できます</div>` : ui.showSplitForm
    ? `<form id="add-split-transaction-form" class="form-panel form-stack"><div class="form-panel-head"><h3>お店を追加</h3><button class="icon-button" type="button" data-close-split-form aria-label="閉じる">×</button></div><div class="field"><label for="split-store">店名</label><input id="split-store" class="input" name="store" data-draft-scope="split" data-draft-field="store" value="${draftValue("split", "store")}" placeholder="店名" required></div><div class="field-grid"><div class="field"><label for="split-amount">金額</label><input id="split-amount" class="input" name="amount" type="number" inputmode="numeric" step="1" data-draft-scope="split" data-draft-field="amount" value="${draftValue("split", "amount")}" required><small>返金はマイナスで入力</small></div><div class="field"><label for="split-date">日付</label><input id="split-date" class="input" name="occurred_at" type="date" data-draft-scope="split" data-draft-field="occurred_at" value="${draftValue("split", "occurred_at")}" required></div></div><div class="field-grid"><div class="field"><label for="split-payer">最初の支払者</label><select id="split-payer" name="payer" data-draft-scope="split" data-draft-field="payer" required><option value="">選択</option>${memberOptions(project.id, ui.drafts.split.payer, true)}</select></div><div class="field"><label for="split-status">状態</label><select id="split-status" name="status" data-draft-scope="split" data-draft-field="status"><option value="confirmed" ${ui.drafts.split.status === "confirmed" ? "selected" : ""}>確定</option><option value="provisional" ${ui.drafts.split.status === "provisional" ? "selected" : ""}>仮</option></select></div></div>${renderOcrBox("split")}<button class="button primary-button" type="submit" ${activeMembers.length ? "" : "disabled"}>追加</button></form>`
    : `<button class="button primary-button section-action" type="button" data-show-split-form ${activeMembers.length ? "" : "disabled"}>お店を追加</button>`;
  return `<section aria-labelledby="transactions-title"><div class="section-heading"><div><h2 id="transactions-title">お店</h2><span>${transactions.length}件</span></div></div>${form}<div class="transaction-list">${transactions.length ? transactions.map(renderTransactionRow).join("") : `<div class="empty-state">お店はありません</div>`}</div></section>`;
}

function renderPaymentRows(project, transaction, locked) {
  const payments = paymentsFor(transaction.id);
  const rows = payments.length ? payments.map((payment) => `<form class="payment-edit-row" data-payment-edit="${esc(payment.id)}"><select name="payer_member_id" aria-label="支払者" ${locked ? "disabled" : ""}>${memberOptions(project.id, payment.payer_member_id)}</select><input class="input amount-input" type="number" name="amount" inputmode="numeric" step="1" value="${integer(payment.amount)}" aria-label="支払額" required ${locked ? "disabled" : ""}><select name="payment_method" aria-label="支払方法" ${locked ? "disabled" : ""}>${paymentMethodOptions(payment.payment_method)}</select><button class="icon-button save-button" type="submit" aria-label="支払いを保存" ${locked ? "disabled" : ""}>✓</button><button class="icon-button quiet" type="button" data-delete-payment="${esc(payment.id)}" aria-label="支払いを削除" ${locked ? "disabled" : ""}>×</button></form>`).join("") : `<div class="empty-state compact-empty">支払いはありません</div>`;
  const add = locked ? "" : `<form id="add-payment-form" class="payment-add-form"><select name="payer_member_id" aria-label="支払者" required><option value="">支払者</option>${memberOptions(project.id, "", true)}</select><input class="input amount-input" type="number" name="amount" inputmode="numeric" step="1" placeholder="金額" aria-label="支払額" required><select name="payment_method" aria-label="支払方法">${paymentMethodOptions()}</select><button class="icon-button add-button" type="submit" aria-label="支払いを追加">＋</button></form>`;
  return `<section class="detail-section" aria-labelledby="payments-heading"><div class="inline-heading"><h3 id="payments-heading">支払い</h3><span>${esc(yen(payments.reduce((sum, row) => sum + integer(row.amount), 0)))}</span></div>${add}<div class="payment-list">${rows}</div></section>`;
}

function allocationChecks(project, item, locked) {
  const allocatedIds = new Set(allocationsFor(item.id).map((row) => row.project_member_id));
  return membersFor(project.id).map((member) => `<label class="check-control"><input type="checkbox" name="allocation_members" value="${esc(member.id)}" ${allocatedIds.has(member.id) ? "checked" : ""} ${locked || member.is_active === 0 && !allocatedIds.has(member.id) ? "disabled" : ""}><span>${esc(member.display_name)}</span></label>`).join("");
}

function renderItemRows(project, transaction, locked) {
  const visible = itemsFor(transaction.id, false);
  const adjustments = itemsFor(transaction.id).filter((row) => row.is_hidden === 1 || row.item_type === "adjustment");
  const rows = visible.length ? visible.map((item) => `<form class="item-edit-row" data-item-edit="${esc(item.id)}"><div class="item-fields"><input class="plain-input" name="name" value="${esc(item.name)}" aria-label="品目名" required ${locked ? "disabled" : ""}><input class="input amount-input" type="number" name="amount" inputmode="numeric" step="1" value="${integer(item.amount)}" aria-label="品目金額" required ${locked ? "disabled" : ""}></div><div class="allocation-checks">${allocationChecks(project, item, locked)}</div><div class="row-actions"><span>${allocationsFor(item.id).length}人へ配分</span><button class="small-button" type="submit" ${locked ? "disabled" : ""}>保存</button>${item.item_type === "product" ? `<button class="small-button danger-button" type="button" data-delete-item="${esc(item.id)}" ${locked ? "disabled" : ""}>削除</button>` : ""}</div></form>`).join("") : `<div class="empty-state compact-empty">品目はありません</div>`;
  const adjustment = adjustments.reduce((sum, row) => sum + integer(row.amount), 0);
  const adjustmentRow = adjustments.length ? `<div class="adjustment-row"><span>差額調整</span><strong>${esc(yen(adjustment))}</strong></div>` : "";
  const add = locked ? "" : `<form id="add-item-form" class="item-add-form"><div class="field-grid"><input class="input" name="name" placeholder="品目名" aria-label="品目名" required><input class="input amount-input" name="amount" type="number" inputmode="numeric" step="1" placeholder="金額" aria-label="品目金額" required></div><fieldset><legend>配分</legend><div class="allocation-checks">${membersFor(project.id, true).map((member) => `<label class="check-control"><input type="checkbox" name="allocation_members" value="${esc(member.id)}" checked><span>${esc(member.display_name)}</span></label>`).join("")}</div></fieldset><button class="button secondary-button" type="submit">品目を追加</button></form>`;
  return `<section class="detail-section" aria-labelledby="items-heading"><div class="inline-heading"><h3 id="items-heading">品目と配分</h3><span>${visible.length}件</span></div><div class="item-list">${rows}${adjustmentRow}</div>${add}</section>`;
}

function transactionIssueText(code) {
  const labels = {
    payment_total_mismatch: "支払い合計が取引金額と一致していません",
    item_total_mismatch: "品目合計が取引金額と一致していません",
    allocation_total_mismatch: "配分合計が取引金額と一致していません",
    item_allocation_total_mismatch: "品目の配分額が一致していません",
    transaction_without_items: "品目がありません",
    item_without_allocations: "配分されていない品目があります",
  };
  return labels[code] || "取引内容を確認してください";
}

function renderTransactionDetail(project, transaction, isSplit) {
  const generated = transaction.generated_automatically === 1;
  const locked = Boolean(project.finalized_at) || generated;
  const validation = isSplit ? Split.validateProjectTransactions(state, project.id) : null;
  const result = validation?.transactions.find((row) => row.transaction_id === transaction.id);
  const issues = result?.issues || [];
  const origin = generated ? `<button class="origin-strip" type="button" data-open-origin-project="${esc(transaction.origin_project_id)}"><span>割り勘から生成</span><strong>${esc(projectName(transaction.origin_project_id))}</strong><span aria-hidden="true">›</span></button>` : "";
  const importSources = state.import_records.filter((row) => transactionId(row) === transaction.id);
  const sourceRows = !isSplit && importSources.length ? `<section class="detail-section"><div class="inline-heading"><h3>取込元</h3><span>${importSources.length}件</span></div><div class="source-list">${importSources.map((row) => `<div class="source-row"><span>${esc(SOURCE_TYPES[row.source_type] || row.source_type)}</span><span>${esc(formatDate(row.created_at))}</span></div>`).join("")}</div></section>` : "";
  const editForm = `<form id="edit-transaction-form" class="form-panel form-stack"><div class="field"><label for="edit-merchant">店名</label><input id="edit-merchant" class="input" name="merchant_name" value="${esc(transaction.merchant_name)}" required ${locked ? "disabled" : ""}></div><div class="field-grid"><div class="field"><label for="edit-amount">金額</label><input id="edit-amount" class="input" name="paid_amount" type="number" inputmode="numeric" step="1" value="${integer(transaction.paid_amount)}" required ${locked ? "disabled" : ""}><small>返金はマイナスで入力</small></div><div class="field"><label for="edit-date">日付</label><input id="edit-date" class="input" name="occurred_at" type="date" value="${esc(dateValue(transaction.occurred_at))}" required ${locked ? "disabled" : ""}></div></div><div class="field-grid"><div class="field"><label for="edit-category">分類</label><input id="edit-category" class="input" name="category" value="${esc(transaction.category || "")}" placeholder="食費" ${locked ? "disabled" : ""}></div><div class="field"><label for="edit-status">状態</label><select id="edit-status" name="status" ${locked ? "disabled" : ""}><option value="provisional" ${transaction.status === "provisional" ? "selected" : ""}>仮</option><option value="confirmed" ${transaction.status === "confirmed" ? "selected" : ""}>確定</option><option value="cancelled" ${transaction.status === "cancelled" ? "selected" : ""}>取消</option><option value="refunded" ${transaction.status === "refunded" ? "selected" : ""}>返金</option><option value="corrected" ${transaction.status === "corrected" ? "selected" : ""}>訂正</option></select></div></div><div class="field"><label for="edit-note">メモ</label><textarea id="edit-note" class="textarea" name="note" rows="2" ${locked ? "disabled" : ""}>${esc(transaction.note || "")}</textarea></div>${locked ? "" : `<button class="button primary-button" type="submit">取引を保存</button>`}</form>`;
  return `<section class="transaction-detail"><button class="text-button back-to-list" type="button" data-close-transaction>← ${isSplit ? "お店" : "取引"}一覧</button><div class="transaction-detail-heading"><div><div class="detail-status">${transactionStatusTags(transaction)}${generated ? `<span class="origin-label">自動生成</span>` : ""}</div><h2>${esc(transaction.merchant_name)}</h2><span>${esc(formatDate(transaction.occurred_at))}</span></div><strong>${esc(yen(transaction.paid_amount))}</strong></div>${origin}${issues.length ? `<div class="notice error-notice">${[...new Set(issues.map((issue) => transactionIssueText(issue.code)))].map(esc).join("<br>")}</div>` : ""}${editForm}${renderPaymentRows(project, transaction, locked)}${isSplit ? renderItemRows(project, transaction, locked) : sourceRows}${locked ? "" : `<button class="button danger-button full-width" type="button" data-delete-transaction="${esc(transaction.id)}">取引を削除</button>`}</section>`;
}

function renderSplitSettlement(project) {
  const calculation = Split.calculateSplit(state, project.id);
  const validation = Split.validateProjectTransactions(state, project.id);
  const transfers = calculation.transfers.length ? calculation.transfers.map((transfer) => `<div class="transfer-row"><span>${esc(memberName(transfer.from_member_id))}</span><span aria-hidden="true">→</span><span>${esc(memberName(transfer.to_member_id))}</span><strong>${esc(yen(transfer.amount))}</strong></div>`).join("") : `<div class="empty-state compact-empty">精算はありません</div>`;
  const balances = calculation.balances.map((balance) => `<div class="balance-row"><strong>${esc(balance.member.display_name)}</strong><span><small>負担</small>${esc(yen(balance.burden))}</span><span><small>立替</small>${esc(yen(balance.advance))}</span><span class="${balance.balance >= 0 ? "positive" : "negative"}"><small>差額</small>${balance.balance > 0 ? "+" : ""}${esc(yen(balance.balance))}</span></div>`).join("");
  const links = membersFor(project.id).map((member) => `<div class="link-summary-row"><span>${esc(member.display_name)}</span><strong class="${member.linked_household_project_id ? "linked-text" : "muted-text"}">${member.linked_household_project_id ? esc(projectName(member.linked_household_project_id)) : "未連携"}</strong></div>`).join("");
  const finalize = project.finalized_at
    ? `<button class="button secondary-button" type="button" data-reopen-project="${esc(project.id)}">再開</button>`
    : `<button class="button primary-button" type="button" data-finalize-project="${esc(project.id)}" ${validation.valid ? "" : "disabled"}>確定</button>`;
  return `<section aria-labelledby="settlement-title"><div class="section-heading"><div><h2 id="settlement-title">精算</h2><span>${transactionsFor(project.id).length}件</span></div></div>${validation.valid ? "" : `<div class="notice error-notice">金額が一致していない取引が ${validation.transactions.filter((row) => !row.valid).length}件あります</div>`}<div class="summary-grid"><div class="summary-cell"><span>取引合計</span><strong>${esc(yen(calculation.total_burden))}</strong></div><div class="summary-cell"><span>参加者</span><strong>${calculation.members.length}人</strong></div></div><section class="settlement-section"><div class="inline-heading"><h3>支払い</h3><span>${calculation.transfers.length}件</span></div><div class="transfer-list">${transfers}</div></section><section class="settlement-section"><div class="inline-heading"><h3>内訳</h3></div><div class="balance-list">${balances}</div></section><section class="settlement-section"><div class="inline-heading"><h3>家計簿連携</h3></div><div class="link-summary">${links || `<div class="empty-state compact-empty">参加者はいません</div>`}</div></section><div class="settlement-actions">${finalize}<button class="button secondary-button" type="button" data-share-project="${esc(project.id)}">共有リンク</button></div><div id="share-box" class="share-box"></div><button class="text-button danger-text" type="button" data-delete-project="${esc(project.id)}">プロジェクトを削除</button></section>`;
}

function renderHouseholdProject(project) {
  const transaction = ui.selectedTransactionId
    ? state.transactions.find((row) => row.id === ui.selectedTransactionId && row.project_id === project.id)
    : null;
  let content;
  if (transaction) content = renderTransactionDetail(project, transaction, false);
  else if (ui.householdTab === "imports") content = renderHouseholdImports(project);
  else if (ui.householdTab === "summary") content = renderHouseholdSummary(project);
  else content = renderHouseholdTransactions(project);
  return shell(`<main class="page detail-page household-page">${renderProjectHeader(project, [["transactions", "取引"], ["imports", "取込"], ["summary", "集計"]], ui.householdTab)}<div class="tab-content">${content}</div></main>`);
}

function renderHouseholdTransactions(project) {
  const members = membersFor(project.id, true);
  const selectedMonth = ui.householdMonth;
  const transactions = transactionsFor(project.id)
    .filter((row) => !selectedMonth || String(row.occurred_at).slice(0, 7) === selectedMonth)
    .sort((left, right) => String(right.occurred_at).localeCompare(String(left.occurred_at)));
  const form = ui.showHouseholdForm ? `<form id="add-household-transaction-form" class="form-panel form-stack"><div class="form-panel-head"><h3>手入力</h3><button class="icon-button" type="button" data-close-household-form aria-label="閉じる">×</button></div><div class="field"><label for="household-merchant">店名</label><input id="household-merchant" class="input" name="merchant_name" placeholder="店名" required></div><div class="field-grid"><div class="field"><label for="household-amount">金額</label><input id="household-amount" class="input" name="paid_amount" type="number" inputmode="numeric" step="1" required><small>返金はマイナスで入力</small></div><div class="field"><label for="household-date">日付</label><input id="household-date" class="input" name="occurred_at" type="date" value="${today()}" required></div></div><div class="field-grid"><div class="field"><label for="household-category">分類</label><input id="household-category" class="input" name="category" placeholder="食費"></div><div class="field"><label for="household-method">支払方法</label><select id="household-method" name="payment_method">${paymentMethodOptions()}</select></div></div><div class="field-grid"><div class="field"><label for="household-payer">記録者</label><select id="household-payer" name="payer_member_id" required>${memberOptions(project.id, members[0]?.id, true)}</select></div><div class="field"><label for="household-status">状態</label><select id="household-status" name="status"><option value="confirmed">確定</option><option value="provisional">仮</option></select></div></div><div class="field"><label for="household-note">メモ</label><textarea id="household-note" class="textarea" name="note" rows="2"></textarea></div><button class="button household-button" type="submit">追加</button></form>` : `<button class="button household-button section-action" type="button" data-show-household-form>手入力</button>`;
  return `<section aria-labelledby="household-transactions-title"><div class="section-heading filter-heading"><div><h2 id="household-transactions-title">取引</h2><span>${transactions.length}件</span></div><label class="month-filter"><span>月</span><input type="month" value="${esc(selectedMonth)}" data-household-month></label></div>${form}<div class="transaction-list">${transactions.length ? transactions.map(renderTransactionRow).join("") : `<div class="empty-state">取引はありません</div>`}</div></section>`;
}

function renderCsvPreview() {
  if (!ui.csvPreview?.rows?.length) return "";
  const rows = ui.csvPreview.rows.slice(0, 8);
  const width = Math.max(...rows.map((row) => row.length), 0);
  return `<div class="csv-preview"><div class="inline-heading"><strong>${esc(ui.csvPreview.name)}</strong><span>${ui.csvPreview.totalRows}行</span></div><div class="table-scroll"><table><tbody>${rows.map((row, rowIndex) => `<tr>${Array.from({ length: width }, (_, index) => `<${rowIndex === 0 ? "th" : "td"}>${esc(row[index] || "")}</${rowIndex === 0 ? "th" : "td"}>`).join("")}</tr>`).join("")}</tbody></table></div><button class="button household-button full-width" type="button" data-import-csv>確認へ追加</button></div>`;
}

function renderImportReview(project, projectIds = new Set([project.id]), includeGmail = true) {
  const records = state.import_records
    .filter((row) => projectIds.has(row.project_id) && ["received", "parsed", "review"].includes(row.source_status))
    .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)));
  const gmail = includeGmail ? renderGmailImport(project) : "";
  if (!records.length) return `${gmail}<div class="empty-state compact-empty">確認待ちはありません</div>`;
  return gmail + records.map((record) => {
    const transactions = transactionsFor(record.project_id).filter((row) => !["cancelled", "refunded"].includes(row.status));
    return `<div class="review-row"><div class="review-row-head"><span class="source-type">${esc(SOURCE_TYPES[record.source_type] || record.source_type)}</span><span>${esc(formatDate(record.occurred_at_raw || record.created_at))}</span></div><div class="review-row-value"><strong>${esc(record.merchant_raw || "店名未設定")}</strong><strong>${esc(yen(record.paid_amount_raw ?? record.gross_amount_raw))}</strong></div><div class="review-actions"><button class="small-button household-small" type="button" data-create-from-import="${esc(record.id)}">取引にする</button><select data-import-link-select="${esc(record.id)}" aria-label="既存の取引"><option value="">既存の取引</option>${transactions.map((transaction) => `<option value="${esc(transaction.id)}">${esc(dateValue(transaction.occurred_at))} ${esc(transaction.merchant_name)} ${esc(yen(transaction.paid_amount))}</option>`).join("")}</select><button class="small-button" type="button" data-link-import="${esc(record.id)}">紐付け</button><button class="icon-button quiet" type="button" data-reject-import="${esc(record.id)}" aria-label="却下">×</button></div></div>`;
  }).join("");
}

function renderHouseholdImports(project, projectIds = new Set([project.id])) {
  const includeGmail = primaryHouseholdProject()?.id === project.id;
  return `<section aria-labelledby="imports-title"><div class="section-heading"><div><h2 id="imports-title">取込</h2><span>${state.import_records.filter((row) => projectIds.has(row.project_id)).length}件</span></div></div><div class="import-tools"><section class="import-section"><div class="inline-heading"><h3>レシート</h3></div><div class="file-actions"><label class="file-button household-file"><input type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" data-household-receipt="${esc(project.id)}"><span>画像を選ぶ</span></label><label class="file-button secondary-button"><input type="file" accept="image/*" capture="environment" data-household-receipt="${esc(project.id)}"><span>撮影する</span></label></div></section><section class="import-section"><div class="inline-heading"><h3>CSV</h3></div><div class="csv-controls"><select data-csv-source aria-label="CSVの種類"><option value="">自動判定</option><option value="card_csv" ${ui.csvSourceType === "card_csv" ? "selected" : ""}>カード</option><option value="paypay_csv" ${ui.csvSourceType === "paypay_csv" ? "selected" : ""}>PayPay</option><option value="bank_csv" ${ui.csvSourceType === "bank_csv" ? "selected" : ""}>銀行</option><option value="manual" ${ui.csvSourceType === "manual" ? "selected" : ""}>その他</option></select><label class="file-button household-file"><input type="file" accept=".csv,text/csv" data-csv-file="${esc(project.id)}"><span>CSVを選ぶ</span></label></div>${renderCsvPreview()}</section><section class="import-section"><div class="inline-heading"><h3>通知</h3></div><form id="notification-import-form" class="form-stack"><textarea class="textarea" name="raw_text" rows="4" placeholder="通知本文" required></textarea><button class="button secondary-button" type="submit">確認へ追加</button></form></section></div><section class="review-section" aria-labelledby="review-title"><div class="inline-heading"><h3 id="review-title">確認待ち</h3></div><div class="review-list">${renderImportReview(project, projectIds, includeGmail)}</div></section></section>`;
}

function renderCalendarImports() {
  const project = primaryHouseholdProject();
  if (!project) return `<section class="calendar-section" aria-labelledby="home-heading"><div class="page-heading"><h1 id="home-heading">家計簿</h1></div>${renderCalendarTabs()}<div class="empty-state">取込記録はありません</div></section>`;
  const projectIds = new Set([project.id]);
  return `<section class="calendar-section" aria-labelledby="home-heading"><div class="page-heading"><h1 id="home-heading">家計簿</h1></div>${renderCalendarTabs()}${renderHouseholdImports(project, projectIds)}</section>`;
}

function householdSummaryGroups(projectId) {
  const included = transactionsFor(projectId).filter(confirmedLedgerTransaction);
  const ids = new Set(included.map((row) => row.id));
  const includedById = new Map(included.map((row) => [row.id, row]));
  const monthly = new Map();
  const categories = new Map();
  const payments = new Map();
  for (const transaction of included) {
    const month = String(transaction.occurred_at).slice(0, 7) || "未設定";
    const category = transaction.category || "未分類";
    monthly.set(month, (monthly.get(month) || 0) + integer(transaction.paid_amount));
    categories.set(category, (categories.get(category) || 0) + integer(transaction.paid_amount));
  }
  for (const payment of state.transaction_payments) {
    const relatedTransaction = includedById.get(transactionId(payment));
    const refundedPayment = payment.payment_status === "refunded" && relatedTransaction?.entry_type === "refund";
    if (!ids.has(transactionId(payment)) || payment.payment_status === "cancelled" || payment.payment_status === "refunded" && !refundedPayment) continue;
    const method = PAYMENT_METHODS[payment.payment_method] || "その他";
    payments.set(method, (payments.get(method) || 0) + integer(payment.amount));
  }
  const sortValues = (map) => [...map.entries()].sort((left, right) => right[1] - left[1]);
  return { included, monthly: sortValues(monthly), categories: sortValues(categories), payments: sortValues(payments) };
}

function cloudHouseholdSummary(projectId) {
  const result = ui.householdSummaries[projectId];
  if (!result) return null;
  return {
    aggregate: {
      total_amount: integer(result.summary?.confirmed_total),
      transaction_count: integer(result.summary?.transaction_count),
    },
    groups: {
      monthly: (result.by_month || []).map((row) => [row.month || "未設定", integer(row.total_amount)]),
      categories: (result.by_category || []).map((row) => [row.category || "未分類", integer(row.total_amount)]),
      payments: (result.by_payment_method || []).map((row) => [PAYMENT_METHODS[row.payment_method] || "その他", integer(row.total_amount)]),
    },
  };
}

function renderBarGroup(title, rows) {
  const max = Math.max(...rows.map((row) => Math.abs(row[1])), 1);
  return `<section class="summary-section"><div class="inline-heading"><h3>${esc(title)}</h3><span>${rows.length}項目</span></div><div class="bar-list">${rows.length ? rows.map(([label, value]) => `<div class="bar-row"><div><span>${esc(label)}</span><strong>${esc(yen(value))}</strong></div><div class="bar-track"><span style="width:${Math.max(2, Math.round(Math.abs(value) / max * 100))}%"></span></div></div>`).join("") : `<div class="empty-state compact-empty">集計はありません</div>`}</div></section>`;
}

function renderHouseholdSummary(project) {
  const cloud = cloudHouseholdSummary(project.id);
  const aggregate = cloud?.aggregate || Split.aggregateHousehold(state, project.id);
  const groups = cloud?.groups || householdSummaryGroups(project.id);
  const provisional = transactionsFor(project.id).filter((row) => row.status === "provisional").length;
  return `<section aria-labelledby="summary-title"><div class="section-heading"><div><h2 id="summary-title">集計</h2><span>確定分</span></div></div><div class="summary-grid three"><div class="summary-cell"><span>合計</span><strong>${esc(yen(aggregate.total_amount))}</strong></div><div class="summary-cell"><span>取引</span><strong>${aggregate.transaction_count}件</strong></div><div class="summary-cell"><span>仮</span><strong>${provisional}件</strong></div></div>${renderBarGroup("月別", groups.monthly)}${renderBarGroup("分類別", groups.categories)}${renderBarGroup("支払方法別", groups.payments)}<button class="text-button danger-text" type="button" data-delete-project="${esc(project.id)}">家計簿データを削除</button></section>`;
}

function mergeSummaryRows(target, rows) {
  for (const [label, value] of rows) target.set(label, (target.get(label) || 0) + integer(value));
}

function renderCalendarSummary() {
  const project = primaryHouseholdProject();
  const totals = { total_amount: 0, transaction_count: 0 };
  const monthly = new Map();
  const categories = new Map();
  const payments = new Map();
  if (project) {
    const cloud = cloudHouseholdSummary(project.id);
    const aggregate = cloud?.aggregate || Split.aggregateHousehold(state, project.id);
    const groups = cloud?.groups || householdSummaryGroups(project.id);
    totals.total_amount += integer(aggregate.total_amount);
    totals.transaction_count += integer(aggregate.transaction_count);
    mergeSummaryRows(monthly, groups.monthly);
    mergeSummaryRows(categories, groups.categories);
    mergeSummaryRows(payments, groups.payments);
  }
  const sorted = (map) => [...map.entries()].sort((left, right) => right[1] - left[1]);
  const provisional = calendarTransactions().filter((row) => row.status === "provisional").length;
  return `<section class="calendar-section" aria-labelledby="home-heading"><div class="page-heading"><h1 id="home-heading">家計簿</h1></div>${renderCalendarTabs()}<section aria-labelledby="summary-title"><div class="section-heading"><div><h2 id="summary-title">集計</h2><span>確定分</span></div></div><div class="summary-grid three"><div class="summary-cell"><span>合計</span><strong>${esc(yen(totals.total_amount))}</strong></div><div class="summary-cell"><span>取引</span><strong>${totals.transaction_count}件</strong></div><div class="summary-cell"><span>仮</span><strong>${provisional}件</strong></div></div>${renderBarGroup("月別", sorted(monthly))}${renderBarGroup("分類別", sorted(categories))}${renderBarGroup("支払方法別", sorted(payments))}</section></section>`;
}

function touchProject(next, projectId, timestamp = now()) {
  const project = next.projects.find((row) => row.id === projectId);
  if (project) project.updated_at = timestamp;
}

function cleanReceiptItems(target) {
  return (ui.ocr[target]?.items || [])
    .map((item) => ({ name: String(item.name || "").trim(), amount: integer(item.amount) }))
    .filter((item) => item.name && item.amount > 0)
    .slice(0, 40);
}

function setAllocations(next, transactionItemId, memberIds, amount, timestamp = now()) {
  const distinctIds = [...new Set(memberIds.filter(Boolean))];
  const existing = next.item_allocations.filter((row) => itemId(row) === transactionItemId);
  const byMember = new Map(existing.map((row) => [row.project_member_id, row]));
  next.item_allocations = next.item_allocations.filter((row) => itemId(row) !== transactionItemId);
  for (const share of Split.splitAmount(integer(amount), distinctIds)) {
    const old = byMember.get(share.mid);
    next.item_allocations.push({
      id: old?.id || makeId("alc"),
      transaction_item_id: transactionItemId,
      project_member_id: share.mid,
      allocated_amount: share.amount,
      created_at: old?.created_at || timestamp,
      updated_at: timestamp,
    });
  }
}

function removeItem(next, transactionItemId) {
  next.transaction_items = next.transaction_items.filter((row) => row.id !== transactionItemId);
  next.item_allocations = next.item_allocations.filter((row) => itemId(row) !== transactionItemId);
}

function appendItem(next, transactionIdValue, input, memberIds, timestamp, sortOrder) {
  const item = {
    id: input.id || makeId("itm"),
    transaction_id: transactionIdValue,
    name: input.name,
    amount: integer(input.amount),
    quantity: Number(input.quantity || 1),
    item_type: input.item_type || "product",
    category: input.category ?? null,
    sort_order: Number.isSafeInteger(sortOrder) ? sortOrder : 0,
    is_hidden: input.is_hidden ? 1 : 0,
    created_at: timestamp,
    updated_at: timestamp,
  };
  next.transaction_items.push(item);
  setAllocations(next, item.id, memberIds, item.amount, timestamp);
  return item;
}

function appendTransactionBundle(next, projectId, input) {
  const timestamp = input.created_at || now();
  const transactionIdValue = input.id || makeId("txn");
  const amount = integer(input.paid_amount ?? input.amount);
  const transaction = {
    id: transactionIdValue,
    project_id: projectId,
    merchant_name: String(input.merchant_name || input.store || "お店").trim(),
    merchant_normalized: normalizeMerchant(input.merchant_name || input.store || "お店"),
    gross_amount: integer(input.gross_amount ?? amount),
    paid_amount: amount,
    discount_amount: integer(input.discount_amount),
    point_amount: integer(input.point_amount),
    category: input.category || null,
    status: input.status || "confirmed",
    occurred_at: input.occurred_at || today(),
    settled_at: input.settled_at || null,
    note: input.note || null,
    entry_type: input.entry_type || "purchase",
    origin_project_id: input.origin_project_id || null,
    origin_transaction_id: input.origin_transaction_id || null,
    origin_member_id: input.origin_member_id || null,
    generated_automatically: input.generated_automatically ? 1 : 0,
    created_at: timestamp,
    updated_at: timestamp,
  };
  next.transactions.push(transaction);
  if (input.payer_member_id) {
    next.transaction_payments.push({
      id: makeId("pay"),
      transaction_id: transaction.id,
      payer_member_id: input.payer_member_id,
      amount,
      payment_method: input.payment_method || "other",
      provider: null,
      account_label: null,
      external_payment_id: null,
      payment_status: input.status === "provisional" ? "provisional" : "confirmed",
      occurred_at: transaction.occurred_at,
      created_at: timestamp,
      updated_at: timestamp,
    });
  }
  const allocationMembers = [...new Set(input.allocation_member_ids || [])];
  const products = (input.items || []).filter((item) => item.name && integer(item.amount) > 0);
  if (!products.length) {
    appendItem(next, transaction.id, { name: "合計", amount, item_type: "summary" }, allocationMembers, timestamp, 0);
  } else {
    products.forEach((item, index) => appendItem(next, transaction.id, { ...item, item_type: "product" }, allocationMembers, timestamp, index));
    const itemTotal = products.reduce((sum, item) => sum + integer(item.amount), 0);
    if (itemTotal !== amount) {
      appendItem(next, transaction.id, { name: "差額調整", amount: amount - itemTotal, item_type: "adjustment", is_hidden: 1 }, allocationMembers, timestamp, products.length);
    }
  }
  touchProject(next, projectId, timestamp);
  return transaction;
}

function reconcileSplitItems(next, projectId, transactionIdValue) {
  const transaction = next.transactions.find((row) => row.id === transactionIdValue);
  if (!transaction) return next;
  const timestamp = now();
  const activeIds = next.project_members.filter((row) => row.project_id === projectId && row.is_active !== 0).map((row) => row.id);
  const allItems = next.transaction_items.filter((row) => transactionId(row) === transactionIdValue);
  const products = allItems.filter((row) => row.item_type === "product" && row.is_hidden !== 1);
  const summaries = allItems.filter((row) => row.item_type === "summary");
  const adjustments = allItems.filter((row) => row.item_type === "adjustment" || row.is_hidden === 1);
  if (!products.length) {
    for (const row of [...adjustments, ...summaries.slice(1)]) removeItem(next, row.id);
    let summary = summaries[0];
    if (!summary) summary = appendItem(next, transactionIdValue, { name: "合計", amount: transaction.paid_amount, item_type: "summary" }, activeIds, timestamp, 0);
    summary.amount = integer(transaction.paid_amount);
    summary.updated_at = timestamp;
    const allocationIds = next.item_allocations.filter((row) => itemId(row) === summary.id).map((row) => row.project_member_id);
    setAllocations(next, summary.id, allocationIds.length ? allocationIds : activeIds, summary.amount, timestamp);
    return next;
  }
  for (const summary of summaries) removeItem(next, summary.id);
  const desired = integer(transaction.paid_amount) - products.reduce((sum, row) => sum + integer(row.amount), 0);
  if (desired === 0) {
    for (const adjustment of adjustments) removeItem(next, adjustment.id);
    return next;
  }
  let adjustment = adjustments[0];
  for (const extra of adjustments.slice(1)) removeItem(next, extra.id);
  if (!adjustment) adjustment = appendItem(next, transactionIdValue, { name: "差額調整", amount: desired, item_type: "adjustment", is_hidden: 1 }, activeIds, timestamp, products.length);
  adjustment.amount = desired;
  adjustment.sort_order = products.length;
  adjustment.is_hidden = 1;
  adjustment.updated_at = timestamp;
  const allocatedIds = next.item_allocations.filter((row) => itemId(row) === adjustment.id).map((row) => row.project_member_id);
  setAllocations(next, adjustment.id, allocatedIds.length ? allocatedIds : activeIds, desired, timestamp);
  return next;
}

function synchronizeSplit(next, projectId) {
  if (typeof Household.synchronizeSplitAllocations !== "function") return next;
  return Household.synchronizeSplitAllocations(next, projectId, { now: now() });
}

function resetSplitDraft(scope) {
  if (scope === "createSplit") {
    ui.drafts.createSplit = { name: "", participant: "", store: "", amount: "", payer: "", occurred_at: today() };
    ui.draftNames = [];
  } else {
    ui.drafts.split = { store: "", amount: "", payer: "", occurred_at: today(), status: "confirmed" };
  }
  ui.ocr[scope] = { status: "", type: "", items: [] };
}

async function createSplitProject(form) {
  const name = String(new FormData(form).get("name") || "").trim() || `${new Date().getMonth() + 1}月${new Date().getDate()}日の割り勘`;
  if (ui.draftNames.length < 2) {
    toast("参加者を2人以上追加してください");
    return;
  }
  const timestamp = now();
  const projectId = makeId("prj");
  const next = cloneState();
  const project = {
    id: projectId,
    name,
    project_type: "split",
    currency: "JPY",
    share_token: null,
    share_role: "editor",
    share_expires_at: null,
    finalized_at: null,
    created_at: timestamp,
    updated_at: timestamp,
  };
  next.projects.unshift(project);
  const members = ui.draftNames.map((displayName) => ({
    id: makeId("mem"),
    project_id: projectId,
    display_name: displayName,
    role: "member",
    is_active: 1,
    linked_household_project_id: null,
    linked_at: null,
    created_at: timestamp,
    updated_at: timestamp,
  }));
  next.project_members.push(...members);
  const data = new FormData(form);
  const store = String(data.get("store") || "").trim();
  const amount = integer(data.get("amount"));
  if ((store && amount === 0) || (!store && amount !== 0)) {
    toast("最初のお店は店名と金額を入力してください");
    return;
  }
  if (store && amount !== 0) {
    const payerIndex = Number(data.get("payer"));
    const payer = Number.isInteger(payerIndex) ? members[payerIndex] : null;
    if (!payer) {
      toast("支払者を選択してください");
      return;
    }
    appendTransactionBundle(next, projectId, {
      merchant_name: store,
      amount,
      occurred_at: data.get("occurred_at") || today(),
      status: "confirmed",
      entry_type: entryTypeForAmount(amount),
      payer_member_id: payer.id,
      allocation_member_ids: members.map((row) => row.id),
      items: cleanReceiptItems("createSplit"),
    });
  }
  ui.createMode = null;
  ui.splitTab = store ? "settlement" : "members";
  ui.selectedTransactionId = null;
  resetSplitDraft("createSplit");
  await commitState(next, "割り勘を作成しました", { render: false });
  location.hash = `#/p/${encodeURIComponent(projectId)}`;
}

function renderGmailImport(project) {
  const connections = gmailUi.connections.filter((row) => row.household_project_id === project.id).map((row) => `<div class="review-row"><div class="review-row-value"><strong>${esc(row.gmail_email)}</strong><span>${esc(row.status)}</span></div><div class="review-actions"><select data-gmail-days="${esc(row.id)}"><option value="7">7日</option><option value="30" selected>30日</option><option value="90">90日</option></select><button class="small-button household-small" type="button" data-gmail-sync="${esc(row.id)}">同期</button><button class="small-button" type="button" data-gmail-disconnect="${esc(row.id)}">解除</button></div></div>`).join("");
  const candidates = gmailUi.candidates.filter((row) => !["ignored", "imported", "parse_error"].includes(row.status)).map((row) => {
    const complete = String(row.merchant_name || "").trim() && Number.isSafeInteger(row.amount) && row.amount !== 0 && row.occurred_at;
    const incompleteNotice = complete ? "" : "<span>金額と店名を入力してください</span>";
    return `<form class="review-row" data-gmail-candidate-form="${esc(row.id)}"><div class="review-row-head"><span>${esc(row.provider || "gmail")}</span><span>${row.duplicate_warning ? "同額・前後7日の候補あり" : ""}</span></div><div class="field-grid"><input class="input" name="merchant_name" value="${esc(row.merchant_name || "")}" aria-label="店名"><input class="input" name="amount" type="number" value="${row.amount ?? ""}" aria-label="金額"><input class="input" name="occurred_at" type="datetime-local" value="${esc(row.occurred_at ? row.occurred_at.slice(0, 16) : "")}" aria-label="日時"></div><div class="review-actions">${incompleteNotice}<button class="small-button" type="submit">編集を保存</button><button class="small-button" type="button" data-gmail-ignore="${esc(row.id)}">無視</button><button class="small-button household-small" type="button" data-gmail-import="${esc(row.id)}" ${complete ? "" : "disabled"}>家計簿へ登録</button></div></form>`;
  }).join("");
  return `<section class="import-section"><div class="inline-heading"><h3>Gmail支払い通知</h3><button class="button secondary-button" type="button" data-gmail-connect>Gmailを接続</button></div>${connections || `<div class="empty-state compact-empty">Gmail接続はありません</div>`}${candidates}</section>`;
}

async function refreshGmailImport(shouldRender = true) {
  if (!isCloud) return;
  try {
    const [connections, candidates] = await Promise.all([Api.listGmailConnections(), Api.listGmailCandidates(undefined, { from_date: gmailUi.from_date, to_date: gmailUi.to_date })]);
    gmailUi.connections = connections.connections || [];
    gmailUi.candidates = candidates.candidates || [];
    gmailUi.total_count = Number(candidates.total_count || gmailUi.candidates.length);
    gmailUi.has_more = Boolean(candidates.has_more);
    const visible = new Set(gmailUi.candidates.map((row) => row.id));
    for (const id of gmailSelected) if (!visible.has(id)) gmailSelected.delete(id);
    if (shouldRender) render();
  } catch (error) {
    toast(`Gmail情報を読み込めませんでした: ${error.message || "取得に失敗しました"}`);
  }
}

async function createHouseholdProject(form) {
  const data = new FormData(form);
  const name = String(data.get("name") || "").trim();
  const ownerName = String(data.get("owner_name") || "自分").trim() || "自分";
  if (!name) return;
  if (primaryHouseholdProject()) {
    ui.createMode = null;
    toast("家計簿はすでに作成されています");
    render();
    return;
  }
  const next = Household.createHouseholdProject(state, { name, owner_name: ownerName }, { now: now() });
  const projectId = next.projects.find((row) => !state.projects.some((old) => old.id === row.id))?.id;
  ui.createMode = null;
  ui.householdTab = "transactions";
  ui.selectedTransactionId = null;
  ui.drafts.createHousehold = { name: "", owner_name: "自分" };
  await commitState(next, "家計簿を作成しました", { render: false });
  if (projectId) location.hash = `#/p/${encodeURIComponent(projectId)}`;
}

async function ensureHouseholdCalendar() {
  const existing = primaryHouseholdProject();
  if (existing) return existing;
  const next = Household.createHouseholdProject(state, { name: "家計簿", owner_name: "自分" }, { now: now() });
  const project = next.projects.find((row) => !state.projects.some((old) => old.id === row.id));
  if (!project) throw new Error("家計簿を準備できませんでした");
  await commitState(next, "家計簿を準備しました", { render: false });
  return projectById(project.id);
}

async function openCalendarEntryForm() {
  await ensureHouseholdCalendar();
  ui.calendarEntryOpen = true;
  ui.calendarTransactionId = null;
  render();
  requestAnimationFrame(() => document.querySelector("#calendar-merchant")?.focus());
}

function addMember(project, form) {
  const displayName = String(new FormData(form).get("display_name") || "").trim();
  if (!displayName) return;
  const timestamp = now();
  let next = cloneState();
  next.project_members.push({
    id: makeId("mem"),
    project_id: project.id,
    display_name: displayName,
    role: "member",
    is_active: 1,
    linked_household_project_id: null,
    linked_at: null,
    created_at: timestamp,
    updated_at: timestamp,
  });
  touchProject(next, project.id, timestamp);
  next = synchronizeSplit(next, project.id);
  commitState(next, "参加者を追加しました");
}

function updateMember(project, form) {
  const memberIdValue = form.dataset.memberEdit;
  const data = new FormData(form);
  const displayName = String(data.get("display_name") || "").trim();
  if (!displayName) return;
  let next = cloneState();
  const beforeMember = next.project_members.find((row) => row.id === memberIdValue);
  if (!beforeMember) return;
  beforeMember.display_name = displayName;
  beforeMember.is_active = data.get("is_active") === "on" ? 1 : 0;
  beforeMember.updated_at = now();
  const householdProjectId = String(data.get("linked_household_project_id") || "");
  next = Household.linkSplitMember(next, memberIdValue, householdProjectId || null, { now: now() });
  touchProject(next, project.id);
  next = synchronizeSplit(next, project.id);
  commitState(next, "参加者を保存しました");
}

function addSplitTransaction(project, form) {
  const data = new FormData(form);
  const amount = integer(data.get("amount"));
  if (amount === 0) {
    toast("金額は0円以外で入力してください");
    return;
  }
  const activeIds = membersFor(project.id, true).map((row) => row.id);
  let next = cloneState();
  const transaction = appendTransactionBundle(next, project.id, {
    merchant_name: String(data.get("store") || "").trim(),
    amount,
    occurred_at: data.get("occurred_at") || today(),
    status: data.get("status") || "confirmed",
    entry_type: entryTypeForAmount(amount),
    payer_member_id: data.get("payer"),
    allocation_member_ids: activeIds,
    items: cleanReceiptItems("split"),
  });
  next = synchronizeSplit(next, project.id);
  ui.showSplitForm = false;
  ui.selectedTransactionId = transaction.id;
  resetSplitDraft("split");
  commitState(next, "お店を追加しました");
}

function updatePayment(project, form) {
  const next = cloneState();
  const payment = next.transaction_payments.find((row) => row.id === form.dataset.paymentEdit);
  if (!payment) return;
  const data = new FormData(form);
  const amount = integer(data.get("amount"));
  if (amount === 0) {
    toast("支払額は0円以外で入力してください");
    return;
  }
  payment.payer_member_id = data.get("payer_member_id");
  payment.amount = amount;
  payment.payment_method = data.get("payment_method") || "other";
  payment.updated_at = now();
  touchProject(next, project.id);
  commitState(next, "支払いを保存しました");
}

function addPayment(project, transaction, form) {
  const data = new FormData(form);
  const amount = integer(data.get("amount"));
  if (amount === 0) {
    toast("支払額は0円以外で入力してください");
    return;
  }
  const timestamp = now();
  const next = cloneState();
  next.transaction_payments.push({
    id: makeId("pay"),
    transaction_id: transaction.id,
    payer_member_id: data.get("payer_member_id"),
    amount,
    payment_method: data.get("payment_method") || "other",
    provider: null,
    account_label: null,
    external_payment_id: null,
    payment_status: transaction.status === "provisional" ? "provisional" : "confirmed",
    occurred_at: transaction.occurred_at,
    created_at: timestamp,
    updated_at: timestamp,
  });
  touchProject(next, project.id, timestamp);
  commitState(next, "支払いを追加しました");
}

function deletePayment(project, paymentId) {
  const next = cloneState();
  next.transaction_payments = next.transaction_payments.filter((row) => row.id !== paymentId);
  touchProject(next, project.id);
  commitState(next, "支払いを削除しました");
}

function updateItem(project, form) {
  const next = cloneState();
  const item = next.transaction_items.find((row) => row.id === form.dataset.itemEdit);
  if (!item) return;
  const data = new FormData(form);
  item.name = String(data.get("name") || "").trim();
  item.amount = integer(data.get("amount"));
  item.updated_at = now();
  setAllocations(next, item.id, data.getAll("allocation_members"), item.amount);
  reconcileSplitItems(next, project.id, transactionId(item));
  touchProject(next, project.id);
  const synchronized = synchronizeSplit(next, project.id);
  commitState(synchronized, "品目と配分を保存しました");
}

function addItem(project, transaction, form) {
  const data = new FormData(form);
  let next = cloneState();
  const summaries = next.transaction_items.filter((row) => transactionId(row) === transaction.id && row.item_type === "summary");
  for (const summary of summaries) removeItem(next, summary.id);
  const products = next.transaction_items.filter((row) => transactionId(row) === transaction.id && row.item_type === "product");
  appendItem(next, transaction.id, {
    name: String(data.get("name") || "").trim(),
    amount: integer(data.get("amount")),
    item_type: "product",
  }, data.getAll("allocation_members"), now(), products.length);
  reconcileSplitItems(next, project.id, transaction.id);
  touchProject(next, project.id);
  next = synchronizeSplit(next, project.id);
  commitState(next, "品目を追加しました");
}

function deleteItem(project, transaction, transactionItemId) {
  let next = cloneState();
  removeItem(next, transactionItemId);
  reconcileSplitItems(next, project.id, transaction.id);
  touchProject(next, project.id);
  next = synchronizeSplit(next, project.id);
  commitState(next, "品目を削除しました");
}

function reconcileHouseholdBundle(next, transaction) {
  const timestamp = now();
  const payments = next.transaction_payments.filter((row) => transactionId(row) === transaction.id);
  const items = next.transaction_items.filter((row) => transactionId(row) === transaction.id);
  const firstPayment = payments[0];
  if (firstPayment) {
    firstPayment.amount = integer(transaction.paid_amount);
    firstPayment.payment_status = transaction.status === "provisional" ? "provisional" : transaction.status === "cancelled" ? "cancelled" : transaction.status === "refunded" ? "refunded" : "confirmed";
    firstPayment.occurred_at = transaction.occurred_at;
    firstPayment.updated_at = timestamp;
  }
  const firstItem = items[0];
  if (firstItem) {
    firstItem.amount = integer(transaction.paid_amount);
    firstItem.category = transaction.category;
    firstItem.updated_at = timestamp;
    const ids = next.item_allocations.filter((row) => itemId(row) === firstItem.id).map((row) => row.project_member_id);
    setAllocations(next, firstItem.id, ids, firstItem.amount, timestamp);
  }
}

function updateTransaction(project, transaction, form) {
  let next = cloneState();
  const row = next.transactions.find((value) => value.id === transaction.id);
  if (!row) return;
  const data = new FormData(form);
  const amount = integer(data.get("paid_amount"));
  if (amount === 0) {
    toast("金額は0円以外で入力してください");
    return;
  }
  row.merchant_name = String(data.get("merchant_name") || "").trim();
  row.merchant_normalized = normalizeMerchant(row.merchant_name);
  row.paid_amount = amount;
  row.gross_amount = row.paid_amount;
  row.entry_type = entryTypeForAmount(amount, row.entry_type);
  row.occurred_at = data.get("occurred_at") || today();
  row.category = String(data.get("category") || "").trim() || null;
  row.status = data.get("status") || "confirmed";
  row.note = String(data.get("note") || "").trim() || null;
  row.updated_at = now();
  if (project.project_type === "split") {
    reconcileSplitItems(next, project.id, row.id);
    next = synchronizeSplit(next, project.id);
  } else {
    reconcileHouseholdBundle(next, row);
  }
  touchProject(next, project.id);
  commitState(next, "取引を保存しました");
}

function removeTransactionRows(next, transactionIdValue) {
  const itemIds = new Set(next.transaction_items.filter((row) => transactionId(row) === transactionIdValue).map((row) => row.id));
  next.transactions = next.transactions.filter((row) => row.id !== transactionIdValue);
  next.transaction_payments = next.transaction_payments.filter((row) => transactionId(row) !== transactionIdValue);
  next.transaction_items = next.transaction_items.filter((row) => transactionId(row) !== transactionIdValue);
  next.item_allocations = next.item_allocations.filter((row) => !itemIds.has(itemId(row)));
  next.import_records = next.import_records.map((row) => transactionId(row) === transactionIdValue ? { ...row, transaction_id: null, source_status: "review", updated_at: now() } : row);
}

function deleteTransaction(project, transaction) {
  let next;
  if (project.project_type === "split" && typeof Household.deleteSourceTransaction === "function") {
    next = Household.deleteSourceTransaction(state, project.id, transaction.id, { now: now() });
  } else {
    next = cloneState();
    removeTransactionRows(next, transaction.id);
  }
  touchProject(next, project.id);
  ui.selectedTransactionId = null;
  ui.calendarTransactionId = null;
  commitState(next, "取引を削除しました");
}

function addHouseholdTransaction(project, form) {
  const data = new FormData(form);
  const amount = integer(data.get("paid_amount"));
  if (amount === 0) {
    toast("金額は0円以外で入力してください");
    return;
  }
  let next = Household.createManualHouseholdTransaction(state, project.id, {
    merchant_name: String(data.get("merchant_name") || "").trim(),
    paid_amount: amount,
    entry_type: entryTypeForAmount(amount),
    occurred_at: data.get("occurred_at") || today(),
    category: String(data.get("category") || "").trim() || null,
    payment_method: data.get("payment_method") || "other",
    payer_member_id: data.get("payer_member_id"),
    status: data.get("status") || "confirmed",
    note: String(data.get("note") || "").trim() || null,
  }, { now: now() });
  touchProject(next, project.id);
  const transaction = next.transactions.find((row) => !state.transactions.some((old) => old.id === row.id));
  ui.showHouseholdForm = false;
  ui.selectedTransactionId = transaction?.id || null;
  commitState(next, "取引を追加しました");
}

function addCalendarTransaction(form) {
  const project = primaryHouseholdProject();
  if (!project) throw new Error("家計簿が見つかりません");
  const data = new FormData(form);
  const amount = integer(data.get("paid_amount"));
  if (amount === 0) {
    toast("金額は0円以外で入力してください");
    return;
  }
  let next = Household.createManualHouseholdTransaction(state, project.id, {
    merchant_name: String(data.get("merchant_name") || "").trim(),
    paid_amount: amount,
    entry_type: entryTypeForAmount(amount),
    occurred_at: data.get("occurred_at") || ui.calendarDay,
    category: String(data.get("category") || "").trim() || null,
    payment_method: data.get("payment_method") || "other",
    payer_member_id: data.get("payer_member_id"),
    status: data.get("status") || "confirmed",
    note: String(data.get("note") || "").trim() || null,
  }, { now: now() });
  touchProject(next, project.id);
  ui.calendarDay = String(data.get("occurred_at") || ui.calendarDay);
  ui.calendarMonth = ui.calendarDay.slice(0, 7);
  ui.calendarEntryOpen = false;
  commitState(next, "支出を追加しました");
}

async function refreshCloudProject(projectId, shouldRender = true) {
  if (!isCloud || typeof Api.getProject !== "function") return;
  const graph = await Api.getProject(projectId);
  state = Storage.mergeProjectGraph(state, graph);
  saveLocal();
  if (shouldRender) render();
}

async function refreshCloudCalendar(shouldRender = true) {
  if (!isCloud || typeof Api.getProject !== "function") return;
  const project = primaryHouseholdProject();
  const projectIds = project ? [project.id] : [];
  const results = await Promise.allSettled(projectIds.map((projectId) => Api.getProject(projectId)));
  const graphs = results.filter((result) => result.status === "fulfilled").map((result) => result.value);
  for (const graph of graphs) state = Storage.mergeProjectGraph(state, graph);
  if (graphs.length) saveLocal();
  if (projectIds.length && graphs.length === 0) throw results.find((result) => result.status === "rejected")?.reason || new Error("家計簿を読み込めませんでした");
  if (shouldRender) render();
}

async function refreshCloudCalendarSummaries(shouldRender = true) {
  if (!isCloud || typeof Api.getProjectSummaries !== "function") return;
  const project = primaryHouseholdProject();
  const projectIds = project ? [project.id] : [];
  const results = await Promise.allSettled(projectIds.map((projectId) => Api.getProjectSummaries(projectId)));
  let fulfilled = 0;
  results.forEach((result, index) => {
    if (result.status !== "fulfilled") return;
    ui.householdSummaries[projectIds[index]] = result.value;
    fulfilled += 1;
  });
  if (projectIds.length && fulfilled === 0) throw results.find((result) => result.status === "rejected")?.reason || new Error("家計簿の集計を読み込めませんでした");
  if (shouldRender) render();
}

async function refreshCloudSummary(projectId, shouldRender = true) {
  if (!isCloud || typeof Api.getProjectSummaries !== "function") return;
  ui.householdSummaries[projectId] = await Api.getProjectSummaries(projectId);
  if (shouldRender) render();
}

function finalizeSplitProject(project) {
  try {
    let next = synchronizeSplit(cloneState(), project.id);
    next = Household.finalizeProjectState(next, project.id, { now: now(), split: Split });
    commitState(next, "割り勘を確定しました", {
      remoteFilter: (operation) => !operation.generated && !(operation.table === "projects" && operation.id === project.id),
      remoteAction: async () => {
        await Api.finalizeProject(project.id);
        await refreshCloudProject(project.id);
      },
    });
  } catch (error) {
    toast(error.message || "確定できませんでした");
  }
}

function reopenSplitProject(project) {
  try {
    const next = Household.reopenProjectState(state, project.id, { now: now() });
    commitState(next, "割り勘を再開しました", {
      remoteFilter: (operation) => !(operation.table === "projects" && operation.id === project.id),
      remoteAction: async () => {
        await Api.reopenProject(project.id);
        await refreshCloudProject(project.id);
      },
    });
  } catch (error) {
    toast(error.message || "再開できませんでした");
  }
}

function removeProjectFromState(project) {
  let next = project.project_type === "split" && typeof Household.cancelGeneratedTransactionsForSource === "function"
    ? Household.cancelGeneratedTransactionsForSource(state, project.id, null, { now: now() })
    : cloneState();
  if (project.project_type === "split") {
    for (const transaction of next.transactions.filter((row) => row.origin_project_id === project.id && row.generated_automatically === 1)) {
      transaction.status = "cancelled";
      transaction.updated_at = now();
      for (const payment of next.transaction_payments.filter((row) => transactionId(row) === transaction.id)) {
        payment.payment_status = "cancelled";
        payment.updated_at = now();
      }
    }
  }
  const transactionIds = new Set(next.transactions.filter((row) => row.project_id === project.id).map((row) => row.id));
  const itemIds = new Set(next.transaction_items.filter((row) => transactionIds.has(transactionId(row))).map((row) => row.id));
  next.projects = next.projects.filter((row) => row.id !== project.id);
  next.project_members = next.project_members
    .filter((row) => row.project_id !== project.id)
    .map((row) => row.linked_household_project_id === project.id
      ? { ...row, linked_household_project_id: null, linked_at: null, updated_at: now() }
      : row);
  next.transactions = next.transactions.filter((row) => !transactionIds.has(row.id));
  next.transaction_payments = next.transaction_payments.filter((row) => !transactionIds.has(transactionId(row)));
  next.transaction_items = next.transaction_items.filter((row) => !transactionIds.has(transactionId(row)));
  next.item_allocations = next.item_allocations.filter((row) => !itemIds.has(itemId(row)));
  next.import_records = next.import_records.filter((row) => row.project_id !== project.id);
  return next;
}

function deleteProject(project) {
  const next = removeProjectFromState(project);
  ui.selectedTransactionId = null;
  commitState(next, project.project_type === "split" ? "プロジェクトを削除しました" : "家計簿データを削除しました", {
    render: false,
    remoteFilter: (operation) => operation.table === "projects" && operation.action === "delete" && operation.id === project.id,
  });
  location.hash = "#/";
}

async function shareProject(projectId) {
  if (!isCloud || typeof Api.createProjectShare !== "function") {
    toast("共有リンクはクラウド接続時に作成できます");
    return;
  }
  try {
    const result = await Api.createProjectShare(projectId);
    const token = result?.token || result?.share?.token || result?.project?.share_token;
    if (!token) throw new Error("共有情報を受け取れませんでした");
    const url = `${location.origin}${location.pathname}#/join/${encodeURIComponent(token)}`;
    const box = document.querySelector("#share-box");
    if (box) box.innerHTML = `<div class="share-url"><span>${esc(url)}</span><button class="small-button" type="button" data-copy-share="${esc(url)}">コピー</button></div>`;
    await navigator.clipboard?.writeText(url);
    toast("共有リンクをコピーしました");
  } catch (error) {
    toast(`共有リンクを作成できませんでした: ${error.message}`);
  }
}

function stableHash(value) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function parseMoney(value) {
  const normalized = String(value ?? "").normalize("NFKC").replace(/[￥¥円,\s]/gu, "").replace(/[△▲]/gu, "-");
  const number = Number(normalized.replace(/[^0-9+.-]/gu, ""));
  return Number.isFinite(number) ? Math.round(number) : 0;
}

function normalizeImportedDate(value) {
  const text = String(value || "").trim().replace(/[年月.]/gu, "/").replace(/日/gu, "").replace(/-/gu, "/");
  const match = text.match(/(20\d{2})\/(\d{1,2})\/(\d{1,2})/u);
  if (!match) return today();
  return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
}

function findHeaderIndex(headers, candidates) {
  const normalized = headers.map((value) => String(value || "").normalize("NFKC").trim().toLowerCase().replace(/\s/gu, ""));
  return normalized.findIndex((value) => candidates.some((candidate) => value === candidate || value.includes(candidate)));
}

function csvRecords(projectId, preview) {
  const [headers = [], ...rows] = preview.rows;
  const merchantIndex = findHeaderIndex(headers, ["利用店名", "加盟店", "店舗", "店名", "摘要", "内容", "merchant", "description"]);
  const amountIndex = findHeaderIndex(headers, ["利用金額", "支払金額", "金額", "amount"]);
  const dateIndex = findHeaderIndex(headers, ["利用日", "取引日", "日付", "date"]);
  const externalIndex = findHeaderIndex(headers, ["取引番号", "利用番号", "transactionid", "id"]);
  const timestamp = now();
  return rows.filter((row) => row.some((value) => String(value).trim())).map((row, index) => {
    const rawIdentity = `${preview.name}:${index + 1}:${JSON.stringify(row)}`;
    const merchant = String(row[merchantIndex >= 0 ? merchantIndex : 0] || "").trim() || "CSV取引";
    const amount = parseMoney(row[amountIndex >= 0 ? amountIndex : Math.max(row.length - 1, 0)]);
    return {
      id: makeId("imp"),
      project_id: projectId,
      transaction_id: null,
      source_type: preview.sourceType,
      source_record_id: `csv:${stableHash(rawIdentity)}`,
      source_status: "review",
      merchant_raw: merchant,
      merchant_normalized: normalizeMerchant(merchant),
      gross_amount_raw: amount,
      paid_amount_raw: amount,
      occurred_at_raw: normalizeImportedDate(row[dateIndex >= 0 ? dateIndex : 0]),
      settled_at_raw: null,
      payment_method_raw: preview.sourceType === "card_csv" ? "credit_card" : preview.sourceType === "paypay_csv" ? "paypay" : preview.sourceType === "bank_csv" ? "bank" : "other",
      external_transaction_id: externalIndex >= 0 ? String(row[externalIndex] || "").trim() || null : null,
      image_url: null,
      raw_text: null,
      raw_payload: JSON.stringify({ headers, row }),
      parse_confidence: amount && merchant ? 0.8 : 0.4,
      parser_version: "wari-ui-csv-1",
      match_score: null,
      match_reason_json: null,
      created_at: timestamp,
      updated_at: timestamp,
    };
  });
}

function sourceProfile(sourceType) {
  if (sourceType === "card_csv") return "card";
  if (sourceType === "paypay_csv") return "paypay";
  if (sourceType === "bank_csv") return "bank";
  return "generic";
}

function addCsvImports(project) {
  const preview = ui.csvPreview;
  if (!preview) return;
  const next = cloneState();
  const existing = new Set(next.import_records.filter((row) => row.project_id === project.id).map((row) => row.source_record_id).filter(Boolean));
  const records = csvRecords(project.id, preview).filter((row) => !existing.has(row.source_record_id));
  next.import_records.push(...records);
  touchProject(next, project.id);
  ui.csvPreview = null;
  commitState(next, records.length ? `${records.length}件を確認へ追加しました` : "同じ取引は追加しませんでした", {
    remoteFilter: (operation) => operation.table !== "import_records",
    remoteAction: async () => {
      await Api.importCsv(project.id, {
        csv_text: preview.text,
        profile: sourceProfile(preview.sourceType),
        options: { source_type: preview.sourceType },
      });
      await refreshCloudProject(project.id);
    },
  });
}

function importRecordFromReceipt(projectId, result) {
  const timestamp = now();
  return {
    id: makeId("imp"),
    project_id: projectId,
    transaction_id: null,
    source_type: "receipt",
    source_record_id: `receipt:${stableHash(`${result.store_name}:${result.total_amount}:${timestamp}`)}`,
    source_status: "review",
    merchant_raw: result.store_name || "レシート",
    merchant_normalized: normalizeMerchant(result.store_name || "レシート"),
    gross_amount_raw: integer(result.total_amount),
    paid_amount_raw: integer(result.total_amount),
    occurred_at_raw: result.occurred_at || today(),
    settled_at_raw: null,
    payment_method_raw: result.payment_method || null,
    external_transaction_id: null,
    image_url: null,
    raw_text: result.raw_text || null,
    raw_payload: JSON.stringify({ items: result.items || [], notes: result.notes || null }),
    parse_confidence: Number.isFinite(result.confidence) ? result.confidence : null,
    parser_version: result.model || "receipt-ocr",
    match_score: null,
    match_reason_json: null,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

function addReceiptImport(project, result) {
  const record = importRecordFromReceipt(project.id, result);
  const next = cloneState();
  next.import_records.push(record);
  touchProject(next, project.id);
  commitState(next, "レシートを確認へ追加しました", {
    remoteFilter: (operation) => operation.table !== "import_records",
    remoteAction: async () => {
      await Api.importReceipt(project.id, {
        id: record.id,
        source_record_id: record.source_record_id,
        merchant_raw: record.merchant_raw,
        paid_amount_raw: record.paid_amount_raw,
        gross_amount_raw: record.gross_amount_raw,
        occurred_at_raw: record.occurred_at_raw,
        raw_payload: { items: result.items || [], notes: result.notes || null },
        parse_confidence: record.parse_confidence,
        parser_version: record.parser_version,
      });
      await refreshCloudProject(project.id);
    },
  });
}

function notificationFields(rawText) {
  const lines = String(rawText || "").split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const amountMatch = String(rawText || "").normalize("NFKC").match(/[￥¥]?\s*[-+]?\d[\d,]*\s*円?/u);
  const dateMatch = String(rawText || "").normalize("NFKC").match(/20\d{2}[\/.年-]\d{1,2}[\/.月-]\d{1,2}日?/u);
  const merchant = lines.find((line) => !/[￥¥]?\s*\d[\d,]*\s*円?/u.test(line) && !/20\d{2}[\/.年-]\d{1,2}/u.test(line)) || "通知取引";
  return {
    merchant,
    amount: parseMoney(amountMatch?.[0] || 0),
    occurredAt: normalizeImportedDate(dateMatch?.[0] || today()),
  };
}

function addNotificationImport(project, rawText) {
  const fields = notificationFields(rawText);
  const timestamp = now();
  const record = {
    id: makeId("imp"),
    project_id: project.id,
    transaction_id: null,
    source_type: "gmail_notification",
    source_record_id: `notification:${stableHash(rawText)}`,
    source_status: "review",
    merchant_raw: fields.merchant,
    merchant_normalized: normalizeMerchant(fields.merchant),
    gross_amount_raw: fields.amount,
    paid_amount_raw: fields.amount,
    occurred_at_raw: fields.occurredAt,
    settled_at_raw: null,
    payment_method_raw: null,
    external_transaction_id: null,
    image_url: null,
    raw_text: rawText,
    raw_payload: null,
    parse_confidence: fields.amount ? 0.6 : 0.3,
    parser_version: "wari-ui-notification-1",
    match_score: null,
    match_reason_json: null,
    created_at: timestamp,
    updated_at: timestamp,
  };
  const next = cloneState();
  next.import_records.push(record);
  touchProject(next, project.id);
  commitState(next, "通知を確認へ追加しました", {
    remoteFilter: (operation) => operation.table !== "import_records",
    remoteAction: async () => {
      await Api.importNotification(project.id, {
        id: record.id,
        source_record_id: record.source_record_id,
        merchant_raw: record.merchant_raw,
        paid_amount_raw: record.paid_amount_raw,
        occurred_at_raw: record.occurred_at_raw,
        raw_text: rawText,
        parse_confidence: record.parse_confidence,
        parser_version: record.parser_version,
      });
      await refreshCloudProject(project.id);
    },
  });
}

function paymentMethodFromImport(record) {
  const value = String(record.payment_method_raw || "").toLowerCase();
  return Object.prototype.hasOwnProperty.call(PAYMENT_METHODS, value) ? value
    : record.source_type === "card_csv" ? "credit_card"
      : record.source_type === "paypay_csv" ? "paypay"
        : record.source_type === "bank_csv" ? "bank" : "other";
}

function createFromImport(project, record) {
  const transactionIdValue = makeId("txn");
  let next = Household.createManualHouseholdTransaction(state, project.id, {
    id: transactionIdValue,
    merchant_name: record.merchant_raw || "取込取引",
    paid_amount: integer(record.paid_amount_raw ?? record.gross_amount_raw),
    gross_amount: integer(record.gross_amount_raw ?? record.paid_amount_raw),
    occurred_at: record.occurred_at_raw || today(),
    payment_method: paymentMethodFromImport(record),
    status: "provisional",
  }, { now: now() });
  const importRow = next.import_records.find((row) => row.id === record.id);
  importRow.transaction_id = transactionIdValue;
  importRow.source_status = "linked";
  importRow.updated_at = now();
  touchProject(next, project.id);
  ui.selectedTransactionId = transactionIdValue;
  ui.householdTab = "transactions";
  commitState(next, "仮の取引を作成しました", {
    remoteFilter: () => false,
    remoteAction: async () => {
      await Api.reconcileImport(record.id, { action: "create", new_transaction_id: transactionIdValue });
      await refreshCloudProject(project.id);
    },
  });
}

function linkImport(project, record, transactionIdValue) {
  if (!transactionIdValue) {
    toast("既存の取引を選択してください");
    return;
  }
  const next = cloneState();
  const row = next.import_records.find((value) => value.id === record.id);
  row.transaction_id = transactionIdValue;
  row.source_status = "linked";
  row.updated_at = now();
  touchProject(next, project.id);
  commitState(next, "取引へ紐付けました", {
    remoteFilter: () => false,
    remoteAction: async () => {
      await Api.reconcileImport(record.id, { action: "link", transaction_id: transactionIdValue });
      await refreshCloudProject(project.id);
    },
  });
}

function rejectImport(project, record) {
  const next = cloneState();
  const row = next.import_records.find((value) => value.id === record.id);
  row.source_status = "rejected";
  row.updated_at = now();
  touchProject(next, project.id);
  commitState(next, "取込候補を却下しました", {
    remoteFilter: () => false,
    remoteAction: async () => {
      await Api.reconcileImport(record.id, { action: "reject" });
      await refreshCloudProject(project.id);
    },
  });
}

async function readReceiptFile(file, projectId) {
  Imports.validateImageFile(file);
  const imageDataUrl = await Imports.readImageAsDataUrl(file);
  const payload = { image_data_url: imageDataUrl, project_id: projectId };
  const shareToken = shareTokensByProject.get(projectId);
  if (shareToken) payload.share_token = shareToken;
  if (typeof Api.readReceipt === "function") return Api.readReceipt(payload);
  return requestApi("/api/ocr-receipt", { method: "POST", json: payload });
}

async function bulkGmailCandidates(action) {
  const selected = gmailUi.candidates.filter((row) => gmailSelected.has(row.id));
  const applicable = action === "import" ? selected.filter((row) => row.status === "ready" && String(row.merchant_name || "").trim() && Number.isSafeInteger(row.amount) && row.amount !== 0 && row.occurred_at) : selected.filter((row) => ["ready", "needs_review"].includes(row.status));
  if (!applicable.length) { toast(action === "import" ? "適用できる候補がありません" : "破棄する候補を選択してください"); return; }
  const total = applicable.reduce((sum, row) => sum + Number(row.amount || 0), 0);
  const message = action === "import" ? `${applicable.length}件、合計${yen(total)}を家計簿へ登録します` : `${applicable.length}件を取込候補から破棄します\n破棄したメールは次回同期でも再解析されません`;
  if (!globalThis.confirm?.(message)) return;
  const aggregate = { imported_count: 0, already_imported_count: 0, skipped_count: 0, failed_count: 0 };
  let processed = 0;
  try {
    for (let index = 0; index < applicable.length; index += 50) {
      const chunk = applicable.slice(index, index + 50);
      const result = await Api.bulkGmailCandidates(action, chunk.map((row) => row.id));
      for (const key of Object.keys(aggregate)) aggregate[key] += Number(result?.[key] || 0);
      processed += chunk.length;
      toast(`${action === "import" ? "一括適用" : "一括破棄"}中: ${processed} / ${applicable.length}件`);
    }
    await refreshGmailImport(false);
    const project = primaryHouseholdProject();
    if (project) await refreshCloudProject(project.id, false);
    await refreshCloudCalendar(false);
    gmailSelected.clear();
    render();
    toast(`${action === "import" ? "一括適用完了" : "一括破棄完了"}: 登録${aggregate.imported_count}件、確認が必要${aggregate.skipped_count}件、登録済み${aggregate.already_imported_count}件、失敗${aggregate.failed_count}件`);
  } catch (error) {
    gmailSelected.clear();
    await refreshGmailImport();
    toast(error.message || "一括処理に失敗しました");
  }
}

async function handleSplitReceipt(input) {
  const target = input.dataset.receiptTarget;
  const receipt = ui.ocr[target];
  if (!receipt || !input.files?.[0]) return;
  receipt.status = "読み取り中";
  receipt.type = "";
  render();
  try {
    const project = target === "createSplit" ? currentProject() || primaryHouseholdProject() : currentProject();
    if (!project) throw new Error("プロジェクトを選択してください");
    const result = await readReceiptFile(input.files[0], project.id);
    receipt.items = (result.items || []).map((item) => ({ name: String(item.name || "").trim(), amount: integer(item.amount) })).filter((item) => item.name && item.amount > 0);
    receipt.status = `${receipt.items.length}件を読み取りました`;
    receipt.type = "success";
    const scope = target === "createSplit" ? "createSplit" : "split";
    if (result.store_name) ui.drafts[scope].store = result.store_name;
    if (result.total_amount) ui.drafts[scope].amount = String(integer(result.total_amount));
    render();
    toast("レシートを読み取りました");
  } catch (error) {
    receipt.status = error.message || "読み取れませんでした";
    receipt.type = "error";
    render();
    toast("レシートを読み取れませんでした");
  }
}

async function handleHouseholdReceipt(input) {
  const project = projectById(input.dataset.householdReceipt);
  if (!project || !input.files?.[0]) return;
  toast("レシートを読み取っています");
  try {
    const result = await readReceiptFile(input.files[0], project.id);
    addReceiptImport(project, result);
  } catch (error) {
    toast(error.message || "レシートを読み取れませんでした");
  }
}

async function handleCsvFile(input) {
  const file = input.files?.[0];
  if (!file) return;
  try {
    const text = Imports.decodeCsvArrayBuffer(await file.arrayBuffer());
    const rows = Imports.parseCsvRows(text, { maxRows: 5001 });
    if (rows.length < 2) throw new Error("CSVに取引行がありません");
    const sourceType = Imports.selectCsvSourceType(ui.csvSourceType, file.name, rows.slice(0, 6));
    ui.csvSourceType = sourceType;
    ui.csvPreview = { name: file.name, text, rows, totalRows: rows.length - 1, sourceType };
    render();
  } catch (error) {
    ui.csvPreview = null;
    render();
    toast(error.message || "CSVを読み込めませんでした");
  }
}

function addDraftName() {
  const name = String(ui.drafts.createSplit.participant || "").trim();
  if (!name) return;
  if (ui.draftNames.includes(name)) {
    toast("同じ名前があります");
    return;
  }
  ui.draftNames.push(name);
  ui.drafts.createSplit.participant = "";
  if (ui.drafts.createSplit.payer === "") ui.drafts.createSplit.payer = "0";
  render();
  requestAnimationFrame(() => document.querySelector("#draft-participant")?.focus());
}

function render() {
  const root = document.querySelector("#app");
  if (root) root.innerHTML = currentProject() ? renderProject() : renderHome();
  renderGmailProgress();
  renderGmailCandidateControls();
}

function mergeProjectSummaries(rows) {
  const next = cloneState();
  const localById = new Map(next.projects.map((row) => [row.id, row]));
  for (const row of rows) {
    const existing = localById.get(row.id);
    if (existing) Object.assign(existing, row);
    else next.projects.push({
      id: row.id,
      name: row.name || "プロジェクト",
      project_type: row.project_type || "split",
      currency: row.currency || "JPY",
      share_token: row.share_token || null,
      share_role: row.share_role || "editor",
      share_expires_at: row.share_expires_at || null,
      finalized_at: row.finalized_at || null,
      created_at: row.created_at || now(),
      updated_at: row.updated_at || row.created_at || now(),
      ...row,
    });
  }
  state = next;
  saveLocal();
}

async function bootCloud() {
  if (typeof Api.getSession !== "function" || typeof Api.listProjects !== "function") {
    cloudSession = { status: "error", user: null };
    return;
  }
  try {
    const session = await Api.getSession();
    if (!session?.authenticated) {
      isCloud = false;
      cloudSession = { status: "unauthenticated", user: null };
      return;
    }
    cloudSession = { status: "authenticated", user: session.user || null };
    const result = await Api.listProjects();
    isCloud = true;
    mergeProjectSummaries(Array.isArray(result) ? result : result.projects || []);
  } catch (error) {
    isCloud = false;
    cloudSession = error?.status === 401
      ? { status: "unauthenticated", user: null }
      : { status: "error", user: null };
  }
}

async function startGoogleLogin() {
  const result = await Api.startGoogleLogin();
  if (!result?.url) throw new Error("認可先を取得できませんでした");
  location.assign(result.url);
}

async function logoutGoogle() {
  await Api.logout();
  isCloud = false;
  cloudSession = { status: "unauthenticated", user: null };
  remoteSyncQueue = Promise.resolve();
  gmailUi.connections = [];
  gmailUi.candidates = [];
  ui.householdSummaries = {};
  shareTokensByProject.clear();
  state = Storage.loadState();
  render();
}

async function joinSharedProject(token) {
  if (typeof Api.getSharedProject !== "function") throw new Error("共有機能を利用できません");
  const graph = await Api.getSharedProject(token);
  isCloud = true;
  state = Storage.mergeProjectGraph(state, graph);
  saveLocal();
  const projectId = graph.projects?.[0]?.id;
  if (graph.share?.role === "editor" && graph.share?.token && projectId) shareTokensByProject.set(projectId, graph.share.token);
  if (!projectId) throw new Error("共有プロジェクトが見つかりません");
  location.hash = `#/p/${encodeURIComponent(projectId)}`;
}

async function route() {
  const shareMatch = location.hash.match(/^#\/join\/([^/?]+)/);
  if (shareMatch) {
    try {
      await joinSharedProject(decodeURIComponent(shareMatch[1]));
    } catch (error) {
      toast(`共有リンクを開けませんでした: ${error.message}`);
      location.hash = "#/";
    }
    return;
  }
  const match = location.hash.match(/^#\/p\/([^/?]+)/);
  const projectId = match ? decodeURIComponent(match[1]) : null;
  if (projectId !== activeProjectId) {
    activeProjectId = projectId;
    ui.selectedTransactionId = null;
    ui.showSplitForm = false;
    ui.showHouseholdForm = false;
  }
  if (isCloud) {
    try {
      await remoteSyncQueue;
      if (projectId) {
        await refreshCloudProject(projectId, false);
        if (projectById(projectId)?.project_type !== "split" && ui.householdTab === "summary") {
          await refreshCloudSummary(projectId, false);
        }
      } else {
        await refreshCloudCalendar(false);
      }
    } catch (error) {
      if (projectId && !projectById(projectId)) toast(`読み込めませんでした: ${error.message}`);
    }
  }
  render();
}

document.addEventListener("input", (event) => {
  const target = event.target;
  const scope = target.dataset.draftScope;
  const field = target.dataset.draftField;
  if (scope && field && ui.drafts[scope]) ui.drafts[scope][field] = target.value;
  if (target.dataset.ocrName) {
    const [ocrTarget, index] = target.dataset.ocrName.split(":");
    if (ui.ocr[ocrTarget]?.items[index]) ui.ocr[ocrTarget].items[index].name = target.value;
  }
  if (target.dataset.ocrAmount) {
    const [ocrTarget, index] = target.dataset.ocrAmount.split(":");
    if (ui.ocr[ocrTarget]?.items[index]) ui.ocr[ocrTarget].items[index].amount = integer(target.value);
  }
});

document.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  const calendarSelectedTransaction = ui.calendarTransactionId
    ? state.transactions.find((row) => row.id === ui.calendarTransactionId)
    : null;
  const project = currentProject() || (calendarSelectedTransaction ? projectById(calendarSelectedTransaction.project_id) : primaryHouseholdProject());
  const transaction = calendarSelectedTransaction || (project && ui.selectedTransactionId
    ? state.transactions.find((row) => row.id === ui.selectedTransactionId && row.project_id === project.id)
    : null);
  try {
    if (form.dataset.gmailCandidateForm) {
      const values = Object.fromEntries(new FormData(form));
      await Api.updateGmailCandidate(form.dataset.gmailCandidateForm, { merchant_name: values.merchant_name, amount: values.amount === "" ? null : Number(values.amount), occurred_at: values.occurred_at ? new Date(values.occurred_at).toISOString() : null, status: "ready" });
      await refreshGmailImport();
    } else if (form.id === "calendar-entry-form") addCalendarTransaction(form);
    else if (form.id === "create-split-form") await createSplitProject(form);
    else if (form.id === "create-household-form") await createHouseholdProject(form);
    else if (form.id === "add-member-form" && project) addMember(project, form);
    else if (form.dataset.memberEdit && project) updateMember(project, form);
    else if (form.id === "add-split-transaction-form" && project) addSplitTransaction(project, form);
    else if (form.dataset.paymentEdit && project) updatePayment(project, form);
    else if (form.id === "add-payment-form" && project && transaction) addPayment(project, transaction, form);
    else if (form.dataset.itemEdit && project) updateItem(project, form);
    else if (form.id === "add-item-form" && project && transaction) addItem(project, transaction, form);
    else if (form.id === "edit-transaction-form" && project && transaction) updateTransaction(project, transaction, form);
    else if (form.id === "add-household-transaction-form" && project) addHouseholdTransaction(project, form);
    else if (form.id === "notification-import-form" && project) addNotificationImport(project, String(new FormData(form).get("raw_text") || ""));
  } catch (error) {
    toast(error.message || "保存できませんでした");
  }
});

document.addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  const calendarSelectedTransaction = ui.calendarTransactionId
    ? state.transactions.find((row) => row.id === ui.calendarTransactionId)
    : null;
  const project = currentProject() || (calendarSelectedTransaction ? projectById(calendarSelectedTransaction.project_id) : primaryHouseholdProject());
  const transaction = calendarSelectedTransaction || (project && ui.selectedTransactionId
    ? state.transactions.find((row) => row.id === ui.selectedTransactionId && row.project_id === project.id)
    : null);
  try {
    if (button.dataset.googleLogin !== undefined) {
      await startGoogleLogin();
      return;
    }
    if (button.dataset.googleLogout !== undefined) {
      await logoutGoogle();
      toast("ログアウトしました");
      return;
    }
    if (button.dataset.gmailConnect !== undefined) {
      const result = await Api.startGmailConnection();
      if (!result?.url) throw new Error("Gmailの認可先を取得できませんでした");
      location.assign(result.url);
      return;
    }
    if (button.dataset.gmailSelectAll !== undefined) {
      gmailUi.candidates.forEach((row) => gmailSelected.add(row.id));
      render();
      return;
    }
    if (button.dataset.gmailClearSelection !== undefined) {
      gmailSelected.clear();
      render();
      return;
    }
    if (button.dataset.gmailBulkImport !== undefined) {
      await bulkGmailCandidates("import");
      return;
    }
    if (button.dataset.gmailBulkIgnore !== undefined) {
      await bulkGmailCandidates("ignore");
      return;
    }
    if (button.dataset.gmailSync) {
      const days = Number(document.querySelector(`[data-gmail-days="${CSS.escape(button.dataset.gmailSync)}"]`)?.value || 30);
      await syncGmailImport(button.dataset.gmailSync, days);
      return;
    }
    if (button.dataset.gmailDisconnect) {
      await Api.disconnectGmail(button.dataset.gmailDisconnect);
      await refreshGmailImport();
      return;
    }
    if (button.dataset.gmailIgnore) {
      await Api.updateGmailCandidate(button.dataset.gmailIgnore, { status: "ignored" });
      await refreshGmailImport();
      return;
    }
    if (button.dataset.gmailImport) {
      await Api.importGmailCandidate(button.dataset.gmailImport);
      await refreshGmailImport();
      await loadCloudState();
      return;
    }
  } catch (error) {
    toast(error.message || "操作を実行できませんでした");
    return;
  }
  if (button.dataset.calendarView) {
    ui.calendarView = button.dataset.calendarView;
    ui.calendarEntryOpen = false;
    ui.calendarTransactionId = null;
    if (ui.calendarView === "summary") {
      try {
        await refreshCloudCalendarSummaries(false);
      } catch (error) {
        toast(error.message || "家計簿の集計を読み込めませんでした");
      }
    }
    render();
    return;
  }
  if (button.dataset.home !== undefined) {
    ui.selectedTransactionId = null;
    ui.calendarTransactionId = null;
    ui.calendarEntryOpen = false;
    location.hash = "#/";
    return;
  }
  if (button.dataset.calendarPrevious !== undefined) {
    shiftCalendarMonth(-1);
    render();
    return;
  }
  if (button.dataset.calendarNext !== undefined) {
    shiftCalendarMonth(1);
    render();
    return;
  }
  if (button.dataset.calendarDay) {
    ui.calendarDay = button.dataset.calendarDay;
    render();
    return;
  }
  if (button.dataset.addCalendarEntry !== undefined) {
    await openCalendarEntryForm();
    return;
  }
  if (button.dataset.closeCalendarEntry !== undefined) {
    ui.calendarEntryOpen = false;
    render();
    return;
  }
  if (button.dataset.openHouseholdLedger !== undefined) {
    const household = primaryHouseholdProject();
    if (household) {
      ui.householdTab = "transactions";
      ui.selectedTransactionId = null;
      location.hash = `#/p/${encodeURIComponent(household.id)}`;
    }
    return;
  }
  if (button.dataset.openCalendarTransaction) {
    const calendarTransaction = state.transactions.find((row) => row.id === button.dataset.openCalendarTransaction);
    if (calendarTransaction) {
      ui.calendarEntryOpen = false;
      ui.calendarTransactionId = calendarTransaction.id;
      render();
    }
    return;
  }
  if (button.dataset.createMode) {
    ui.createMode = button.dataset.createMode;
    render();
    requestAnimationFrame(() => document.querySelector("dialog input")?.focus());
    return;
  }
  if (button.dataset.closeModal !== undefined) {
    ui.createMode = null;
    render();
    return;
  }
  if (button.dataset.addDraftName !== undefined) {
    addDraftName();
    return;
  }
  if (button.dataset.removeDraftName !== undefined) {
    ui.draftNames.splice(Number(button.dataset.removeDraftName), 1);
    if (Number(ui.drafts.createSplit.payer) >= ui.draftNames.length) ui.drafts.createSplit.payer = ui.draftNames.length ? "0" : "";
    render();
    return;
  }
  if (button.dataset.removeOcr) {
    const [target, index] = button.dataset.removeOcr.split(":");
    ui.ocr[target]?.items.splice(Number(index), 1);
    render();
    return;
  }
  if (button.dataset.openProject) {
    ui.selectedTransactionId = null;
    location.hash = `#/p/${encodeURIComponent(button.dataset.openProject)}`;
    return;
  }
  if (button.dataset.projectTab) {
    ui.selectedTransactionId = null;
    if (project?.project_type === "split") ui.splitTab = button.dataset.projectTab;
    else ui.householdTab = button.dataset.projectTab;
    render();
    if (project?.project_type === "household" && primaryHouseholdProject()?.id === project.id && button.dataset.projectTab === "imports") {
      await refreshGmailImport(false);
    }
    if (project?.project_type !== "split" && button.dataset.projectTab === "summary") {
      try {
        await refreshCloudSummary(project.id);
      } catch (error) {
        toast(`集計を読み込めませんでした: ${error.message}`);
      }
    }
    return;
  }
  if (button.dataset.showSplitForm !== undefined) {
    ui.showSplitForm = true;
    render();
    return;
  }
  if (button.dataset.closeSplitForm !== undefined) {
    ui.showSplitForm = false;
    render();
    return;
  }
  if (button.dataset.showHouseholdForm !== undefined) {
    ui.showHouseholdForm = true;
    render();
    return;
  }
  if (button.dataset.closeHouseholdForm !== undefined) {
    ui.showHouseholdForm = false;
    render();
    return;
  }
  if (button.dataset.openTransaction) {
    ui.selectedTransactionId = button.dataset.openTransaction;
    render();
    return;
  }
  if (button.dataset.closeTransaction !== undefined) {
    ui.selectedTransactionId = null;
    ui.calendarTransactionId = null;
    render();
    return;
  }
  if (button.dataset.openOriginProject) {
    ui.selectedTransactionId = button.dataset.openOriginProject ? null : ui.selectedTransactionId;
    ui.calendarTransactionId = null;
    ui.splitTab = "settlement";
    location.hash = `#/p/${encodeURIComponent(button.dataset.openOriginProject)}`;
    return;
  }
  if (button.dataset.deletePayment && project && confirm("この支払いを削除しますか？")) {
    deletePayment(project, button.dataset.deletePayment);
    return;
  }
  if (button.dataset.deleteItem && project && transaction && confirm("この品目を削除しますか？")) {
    deleteItem(project, transaction, button.dataset.deleteItem);
    return;
  }
  if (button.dataset.deleteTransaction && project && transaction && confirm("この取引を削除しますか？")) {
    deleteTransaction(project, transaction);
    return;
  }
  if (button.dataset.finalizeProject && project) {
    finalizeSplitProject(project);
    return;
  }
  if (button.dataset.reopenProject && project) {
    reopenSplitProject(project);
    return;
  }
  if (button.dataset.shareProject) {
    await shareProject(button.dataset.shareProject);
    return;
  }
  if (button.dataset.copyShare) {
    await navigator.clipboard?.writeText(button.dataset.copyShare);
    toast("共有リンクをコピーしました");
    return;
  }
  if (button.dataset.deleteProject && project && confirm(project.project_type === "split" ? "このプロジェクトを削除しますか？" : "この家計簿データを削除しますか？")) {
    deleteProject(project);
    return;
  }
  if (button.dataset.importCsv !== undefined && project) {
    addCsvImports(project);
    return;
  }
  if (button.dataset.createFromImport && project) {
    const record = state.import_records.find((row) => row.id === button.dataset.createFromImport);
    if (record) createFromImport(projectById(record.project_id) || project, record);
    return;
  }
  if (button.dataset.linkImport && project) {
    const record = state.import_records.find((row) => row.id === button.dataset.linkImport);
    const select = document.querySelector(`[data-import-link-select="${CSS.escape(button.dataset.linkImport)}"]`);
    if (record) linkImport(projectById(record.project_id) || project, record, select?.value || "");
    return;
  }
  if (button.dataset.rejectImport && project) {
    const record = state.import_records.find((row) => row.id === button.dataset.rejectImport);
    if (record) rejectImport(projectById(record.project_id) || project, record);
  }
});

document.addEventListener("change", (event) => {
  const target = event.target;
  if (target.dataset.gmailSelect) {
    if (target.checked) gmailSelected.add(target.dataset.gmailSelect);
    else gmailSelected.delete(target.dataset.gmailSelect);
    renderGmailCandidateControls();
    return;
  }
  if (target.dataset.gmailFromDate || target.dataset.gmailToDate) {
    const fromDate = document.querySelector("[data-gmail-from-date]")?.value || gmailUi.from_date;
    const toDate = document.querySelector("[data-gmail-to-date]")?.value || gmailUi.to_date;
    if (!validGmailDateRange(fromDate, toDate)) { toast("Gmail同期期間は90日以内で、開始日を終了日以前にしてください"); return; }
    gmailUi.from_date = fromDate;
    gmailUi.to_date = toDate;
    gmailSelected.clear();
    void refreshGmailImport();
    return;
  }
  const scope = target.dataset.draftScope;
  const field = target.dataset.draftField;
  if (scope && field && ui.drafts[scope]) ui.drafts[scope][field] = target.value;
  if (target.dataset.receiptTarget) void handleSplitReceipt(target);
  if (target.dataset.householdReceipt) void handleHouseholdReceipt(target);
  if (target.dataset.csvFile) void handleCsvFile(target);
  if (target.dataset.csvSource !== undefined) {
    ui.csvSourceType = target.value;
    if (ui.csvPreview) {
      ui.csvPreview.sourceType = Imports.selectCsvSourceType(target.value, ui.csvPreview.name, ui.csvPreview.rows.slice(0, 6));
      render();
    }
  }
  if (target.dataset.householdMonth !== undefined) {
    ui.householdMonth = target.value;
    render();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && event.target.id === "draft-participant") {
    event.preventDefault();
    addDraftName();
  }
  if (event.key === "Escape" && ui.createMode) {
    ui.createMode = null;
    render();
  }
});

window.addEventListener("hashchange", () => void route());

if (!location.hash) location.hash = "#/";
render();
await bootCloud();
if (isCloud) await refreshGmailImport(false);
render();
await route();

if ("serviceWorker" in navigator) {
  if (["localhost", "127.0.0.1", "[::1]"].includes(location.hostname)) {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.map((registration) => registration.unregister()));
    if ("caches" in globalThis) {
      const cacheNames = await caches.keys();
      await Promise.all(cacheNames.filter((name) => name.startsWith("wari-pwa-")).map((name) => caches.delete(name)));
    }
  } else {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/service-worker.js").catch(() => {});
    });
  }
}
