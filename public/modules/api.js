class ApiError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "ApiError";
    this.status = options.status ?? 0;
    this.code = options.code || "api_error";
    this.details = options.details;
    this.data = options.data;
    this.url = options.url;
    this.method = options.method;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

const CREATE_FIELDS = Object.freeze({
  projects: ["id", "name", "project_type", "currency"],
  project_members: ["id", "display_name", "role", "is_active"],
  transactions: [
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
  ],
  transaction_payments: [
    "id",
    "payer_member_id",
    "amount",
    "payment_method",
    "provider",
    "account_label",
    "external_payment_id",
    "payment_status",
    "occurred_at",
  ],
  transaction_items: ["id", "name", "amount", "quantity", "item_type", "category", "sort_order", "is_hidden"],
  item_allocations: ["id", "project_member_id", "allocated_amount"],
  import_records: [
    "id",
    "source_type",
    "source_record_id",
    "source_status",
    "merchant_raw",
    "merchant_normalized",
    "gross_amount_raw",
    "paid_amount_raw",
    "occurred_at_raw",
    "settled_at_raw",
    "payment_method_raw",
    "external_transaction_id",
    "image_url",
    "raw_text",
    "raw_payload",
    "parse_confidence",
    "parser_version",
    "match_score",
    "match_reason_json",
    "transaction_id",
  ],
});

const UPDATE_FIELDS = Object.freeze({
  projects: CREATE_FIELDS.projects.filter((field) => field !== "id"),
  project_members: CREATE_FIELDS.project_members.filter((field) => field !== "id"),
  transactions: CREATE_FIELDS.transactions.filter((field) => field !== "id"),
  transaction_payments: CREATE_FIELDS.transaction_payments.filter((field) => field !== "id"),
  transaction_items: CREATE_FIELDS.transaction_items.filter((field) => field !== "id"),
  item_allocations: CREATE_FIELDS.item_allocations.filter((field) => field !== "id"),
  import_records: CREATE_FIELDS.import_records.filter((field) => field !== "id"),
});

const IMPORT_INPUT_FIELDS = Object.freeze([
  "id",
  "source_record_id",
  "receipt_id",
  "document_id",
  "message_id",
  "notification_id",
  "merchant_raw",
  "merchant_name",
  "store_name",
  "merchant",
  "paid_amount_raw",
  "paid_amount",
  "total_amount",
  "amount",
  "gross_amount_raw",
  "gross_amount",
  "occurred_at_raw",
  "occurred_at",
  "paid_at",
  "date",
  "received_at",
  "settled_at_raw",
  "settled_at",
  "payment_method_raw",
  "payment_method",
  "external_transaction_id",
  "external_payment_id",
  "transaction_id",
  "image_url",
  "receipt_image_url",
  "raw_text",
  "text",
  "raw_payload",
  "payload",
  "parse_confidence",
  "confidence",
  "parser_version",
  "account_label",
  "provider",
  "payer_member_id",
  "category",
  "discount_amount",
  "point_amount",
  "status",
  "valid",
]);

function pickFields(value, fields) {
  const source = value && typeof value === "object" ? value : {};
  return Object.fromEntries(fields.filter((field) => Object.prototype.hasOwnProperty.call(source, field)).map((field) => [field, source[field]]));
}

function encoded(value, field = "id") {
  if (value === undefined || value === null || String(value) === "") {
    throw new TypeError(`${field} is required`);
  }
  return encodeURIComponent(String(value));
}

function queryString(values) {
  if (!values || typeof values !== "object") return "";
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) {
      if (value.length) query.set(key, value.map((item) => String(item)).join(","));
    } else {
      query.set(key, String(value));
    }
  }
  const text = query.toString();
  return text ? `?${text}` : "";
}

function joinUrl(baseUrl, path) {
  const value = String(path || "");
  if (/^https?:\/\//iu.test(value)) return value;
  const base = String(baseUrl || "").replace(/\/+$/u, "");
  if (!base) return value.startsWith("/") ? value : `/${value}`;
  if (value === base || value.startsWith(`${base}/`) || value.startsWith(`${base}?`)) return value;
  const suffix = value.replace(/^\/+/, "");
  return `${base}/${suffix}`;
}

function plainJsonBody(value) {
  if (value === null || value === undefined || typeof value === "string") return false;
  if (typeof Blob !== "undefined" && value instanceof Blob) return false;
  if (typeof FormData !== "undefined" && value instanceof FormData) return false;
  if (typeof URLSearchParams !== "undefined" && value instanceof URLSearchParams) return false;
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return false;
  return typeof value === "object";
}

function createFetchClient(options = {}) {
  const values = typeof options === "function" ? { fetch: options } : { ...(options || {}) };
  const baseUrl = values.baseUrl ?? values.baseURL ?? "/api";
  const defaultHeaders = { Accept: "application/json", ...(values.headers || {}) };
  let csrfToken = values.csrfToken || "";

  function cookieValue(name) {
    if (typeof document === "undefined") return "";
    const prefix = `${name}=`;
    const entry = document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(prefix));
    return entry ? decodeURIComponent(entry.slice(prefix.length)) : "";
  }

  async function request(path, requestOptions = {}) {
    const fetchImplementation = requestOptions.fetch || values.fetch || globalThis.fetch;
    if (typeof fetchImplementation !== "function") throw new TypeError("fetch is required");
    const method = String(requestOptions.method || "GET").toUpperCase();
    const url = `${joinUrl(baseUrl, path)}${queryString(requestOptions.query)}`;
    const headers = new Headers(defaultHeaders);
    for (const [key, value] of new Headers(requestOptions.headers || {})) headers.set(key, value);
    if (["POST", "PUT", "PATCH", "DELETE"].includes(method) && !headers.has("x-csrf-token")) {
      csrfToken = csrfToken || cookieValue("wari_csrf");
      if (csrfToken) headers.set("x-csrf-token", csrfToken);
    }
    let body = Object.prototype.hasOwnProperty.call(requestOptions, "json") ? requestOptions.json : requestOptions.body;
    if (plainJsonBody(body)) {
      body = JSON.stringify(body);
      if (!headers.has("content-type")) headers.set("content-type", "application/json");
    }
    let response;
    try {
      const { query, json, fetch: requestFetch, ...fetchOptions } = requestOptions;
      response = await fetchImplementation(url, {
        credentials: "same-origin",
        ...fetchOptions,
        method,
        headers,
        body,
      });
    } catch (cause) {
      throw new ApiError(cause?.message || "Network request failed", {
        status: 0,
        code: "network_error",
        url,
        method,
        cause,
      });
    }
    if (response.status === 204) return null;
    const text = await response.text();
    let data = null;
    if (text !== "") {
      try {
        data = JSON.parse(text);
      } catch (cause) {
        throw new ApiError("Invalid JSON response", {
          status: response.status,
          code: "invalid_json_response",
          details: { body: text.slice(0, 1000) },
          url,
          method,
          cause,
        });
      }
    }
    if (!response.ok) {
      const code = data && typeof data === "object" ? data.error || data.code : null;
      const message = data && typeof data === "object" ? data.message || code : null;
      throw new ApiError(message || `HTTP ${response.status}`, {
        status: response.status,
        code: code || `http_${response.status}`,
        details: data && typeof data === "object" ? data.details ?? data : data,
        data,
        url,
        method,
      });
    }
    if (data && typeof data === "object" && typeof data.csrf_token === "string") csrfToken = data.csrf_token;
    return data;
  }

  return { request, fetchJson: request, apiRequest: request, setCsrfToken: (value) => { csrfToken = String(value || ""); } };
}

function routedRow(parentOrRow, maybeRow, parentField) {
  if (parentOrRow && typeof parentOrRow === "object" && maybeRow === undefined) {
    return { parentId: parentOrRow[parentField], row: parentOrRow };
  }
  return { parentId: parentOrRow, row: maybeRow || {} };
}

function createApiClient(options = {}) {
  const client = createFetchClient(options);
  const transport = client.request;
  const allocationsByItem = new Map();
  const allocationById = new Map();
  const itemTransactions = new Map();
  const generatedTransactions = new Set();
  const generatedItems = new Set();
  const projectFinalized = new Map();

  function setCachedAllocations(itemId, rows) {
    const previous = allocationsByItem.get(itemId) || [];
    for (const row of previous) allocationById.delete(row.id);
    const next = rows.map((row) => ({ ...row, transaction_item_id: row.transaction_item_id || itemId }));
    allocationsByItem.set(itemId, next);
    for (const row of next) allocationById.set(row.id, row);
  }

  function rememberResponse(data) {
    if (!data || typeof data !== "object") return;
    const projects = Array.isArray(data.projects) ? data.projects : data.project ? [data.project] : [];
    for (const project of projects) projectFinalized.set(project.id, Boolean(project.finalized_at));
    const transactions = Array.isArray(data.transactions)
      ? data.transactions
      : data.transaction ? [data.transaction] : [];
    for (const transaction of transactions) {
      if (transaction.generated_automatically === 1 || String(transaction.id).startsWith("household:transaction:")) {
        generatedTransactions.add(transaction.id);
      }
    }
    const items = Array.isArray(data.transaction_items)
      ? data.transaction_items
      : data.transaction_item ? [data.transaction_item] : [];
    for (const item of items) {
      itemTransactions.set(item.id, item.transaction_id);
      if (generatedTransactions.has(item.transaction_id) || String(item.id).startsWith("household:item:")) {
        generatedItems.add(item.id);
      }
    }
    if (!Array.isArray(data.item_allocations)) return;
    const grouped = new Map();
    for (const allocation of data.item_allocations) {
      const itemId = allocation.transaction_item_id;
      if (!grouped.has(itemId)) grouped.set(itemId, []);
      grouped.get(itemId).push(allocation);
    }
    if (Array.isArray(data.transaction_items)) {
      for (const item of data.transaction_items) setCachedAllocations(item.id, grouped.get(item.id) || []);
    } else {
      for (const [itemId, rows] of grouped) setCachedAllocations(itemId, rows);
    }
  }

  async function request(path, requestOptions) {
    const data = await transport(path, requestOptions);
    rememberResponse(data);
    return data;
  }

  const listProjects = (query) => request("/projects", { query });
  const getProject = (projectId) => request(`/projects/${encoded(projectId, "projectId")}`);
  const createProject = (row) => request("/projects", { method: "POST", json: pickFields(row, CREATE_FIELDS.projects) });
  const updateProject = (projectId, row) => request(`/projects/${encoded(projectId, "projectId")}`, {
    method: "PATCH",
    json: pickFields(row, UPDATE_FIELDS.projects),
  });
  const deleteProject = (projectId) => request(`/projects/${encoded(projectId, "projectId")}`, { method: "DELETE" });

  const listProjectMembers = (projectId, query) => request(`/projects/${encoded(projectId, "projectId")}/members`, {
    query: typeof query === "boolean" ? { include_inactive: query ? 1 : 0 } : query,
  });
  const createProjectMember = (projectIdOrRow, maybeRow) => {
    const { parentId, row } = routedRow(projectIdOrRow, maybeRow, "project_id");
    return request(`/projects/${encoded(parentId, "projectId")}/members`, {
      method: "POST",
      json: pickFields(row, CREATE_FIELDS.project_members),
    });
  };
  const updateProjectMember = (memberId, row) => request(`/project-members/${encoded(memberId, "memberId")}`, {
    method: "PATCH",
    json: pickFields(row, UPDATE_FIELDS.project_members),
  });
  const deleteProjectMember = (memberId) => request(`/project-members/${encoded(memberId, "memberId")}`, { method: "DELETE" });
  const linkProjectMember = (memberId, householdProjectId) => request(`/project-members/${encoded(memberId, "memberId")}/household-link`, {
    method: "PATCH",
    json: householdProjectId ? { action: "link", household_project_id: householdProjectId } : { action: "unlink" },
  });

  const listTransactions = (projectId, query) => request(`/projects/${encoded(projectId, "projectId")}/transactions`, { query });
  const getTransaction = (transactionId) => request(`/transactions/${encoded(transactionId, "transactionId")}`);
  const createTransaction = (projectIdOrRow, maybeRow) => {
    const { parentId, row } = routedRow(projectIdOrRow, maybeRow, "project_id");
    return request(`/projects/${encoded(parentId, "projectId")}/transactions`, {
      method: "POST",
      json: pickFields(row, CREATE_FIELDS.transactions),
    });
  };
  const updateTransaction = (transactionId, row) => request(`/transactions/${encoded(transactionId, "transactionId")}`, {
    method: "PATCH",
    json: pickFields(row, UPDATE_FIELDS.transactions),
  });
  const deleteTransaction = (transactionId) => request(`/transactions/${encoded(transactionId, "transactionId")}`, { method: "DELETE" });

  const createTransactionPayment = (transactionIdOrRow, maybeRow) => {
    const { parentId, row } = routedRow(transactionIdOrRow, maybeRow, "transaction_id");
    return request(`/transactions/${encoded(parentId, "transactionId")}/payments`, {
      method: "POST",
      json: pickFields(row, CREATE_FIELDS.transaction_payments),
    });
  };
  const updateTransactionPayment = (paymentId, row) => request(`/transaction-payments/${encoded(paymentId, "paymentId")}`, {
    method: "PATCH",
    json: pickFields(row, UPDATE_FIELDS.transaction_payments),
  });
  const deleteTransactionPayment = (paymentId) => request(`/transaction-payments/${encoded(paymentId, "paymentId")}`, { method: "DELETE" });

  const createTransactionItem = (transactionIdOrRow, maybeRow) => {
    const { parentId, row } = routedRow(transactionIdOrRow, maybeRow, "transaction_id");
    return request(`/transactions/${encoded(parentId, "transactionId")}/items`, {
      method: "POST",
      json: pickFields(row, CREATE_FIELDS.transaction_items),
    });
  };
  const updateTransactionItem = (itemId, row) => request(`/transaction-items/${encoded(itemId, "itemId")}`, {
    method: "PATCH",
    json: pickFields(row, UPDATE_FIELDS.transaction_items),
  });
  const deleteTransactionItem = (itemId) => request(`/transaction-items/${encoded(itemId, "itemId")}`, { method: "DELETE" });

  const replaceItemAllocations = async (itemId, allocations) => {
    const rows = (Array.isArray(allocations) ? allocations : allocations?.allocations || []).map(
      (row) => ({ ...pickFields(row, CREATE_FIELDS.item_allocations), transaction_item_id: itemId }),
    );
    const result = await request(`/transaction-items/${encoded(itemId, "itemId")}/allocations`, {
      method: "PUT",
      json: { allocations: rows.map((row) => pickFields(row, CREATE_FIELDS.item_allocations)) },
    });
    setCachedAllocations(itemId, result?.item_allocations || rows);
    return result;
  };
  const createItemAllocation = async (itemIdOrRow, maybeRow) => {
    const { parentId, row } = routedRow(itemIdOrRow, maybeRow, "transaction_item_id");
    const current = allocationsByItem.get(parentId) || [];
    const replacement = [
      ...current.filter((entry) => entry.id !== row.id && entry.project_member_id !== row.project_member_id),
      row,
    ];
    return replaceItemAllocations(parentId, replacement);
  };
  const updateItemAllocation = (allocationId, row = {}) => {
    const existing = allocationById.get(allocationId) || {};
    const itemId = row.transaction_item_id || existing.transaction_item_id;
    if (!itemId) throw new TypeError("transaction_item_id is required for allocation updates");
    const current = allocationsByItem.get(itemId) || [];
    const replacement = current.some((entry) => entry.id === allocationId)
      ? current.map((entry) => entry.id === allocationId ? { ...entry, ...row, id: allocationId } : entry)
      : [...current, { ...existing, ...row, id: allocationId }];
    return replaceItemAllocations(itemId, replacement);
  };
  const deleteItemAllocation = (allocationId, options = {}) => {
    const row = options.row || options;
    const existing = allocationById.get(allocationId) || row;
    const itemId = existing.transaction_item_id;
    if (!itemId) throw new TypeError("transaction_item_id is required for allocation deletion");
    const current = allocationsByItem.get(itemId) || [existing];
    return replaceItemAllocations(itemId, current.filter((entry) => entry.id !== allocationId));
  };

  const listImports = (projectId, query) => request(`/projects/${encoded(projectId, "projectId")}/imports`, { query });
  const createImportRecord = (projectIdOrRow, maybeRow) => {
    const { parentId, row } = routedRow(projectIdOrRow, maybeRow, "project_id");
    if (row.source_type === "receipt") return importReceipt(parentId, pickFields(row, IMPORT_INPUT_FIELDS));
    if (row.source_type === "gmail_notification") return importNotification(parentId, pickFields(row, IMPORT_INPUT_FIELDS));
    throw new TypeError("CSV import records must be created with createCsvImports");
  };
  const importReceipt = (projectId, payload) => request(`/projects/${encoded(projectId, "projectId")}/imports/receipt`, {
    method: "POST",
    json: pickFields(payload, IMPORT_INPUT_FIELDS),
  });
  const importNotification = (projectId, payload) => request(`/projects/${encoded(projectId, "projectId")}/imports/notification`, {
    method: "POST",
    json: pickFields(payload, IMPORT_INPUT_FIELDS),
  });
  const importCsv = (projectId, csvOrPayload, profile = "generic", options = {}) => {
    const payload = csvOrPayload && typeof csvOrPayload === "object"
      ? csvOrPayload
      : { csv: String(csvOrPayload ?? ""), profile, options };
    return request(`/projects/${encoded(projectId, "projectId")}/imports/csv`, {
      method: "POST",
      json: payload,
    });
  };
  const reconcileImport = (importId, actionOrPayload, details = {}) => {
    const payload = typeof actionOrPayload === "object"
      ? actionOrPayload
      : { ...details, action: actionOrPayload };
    return request(`/imports/${encoded(importId, "importId")}/reconcile`, { method: "POST", json: payload });
  };
  const startGmailConnection = () => request("/gmail/oauth/start", { method: "POST", json: {} });
  const listGmailConnections = () => request("/gmail/connections");
  const disconnectGmail = (connectionId) => request(`/gmail/connections/${encoded(connectionId)}`, { method: "DELETE" });
  const syncGmail = (connectionId, days = 30, limit = 100) => request(`/gmail/connections/${encoded(connectionId)}/sync`, { method: "POST", json: { days, limit } });
  const listGmailCandidates = (status) => request("/gmail/candidates", { query: status ? { status } : undefined });
  const updateGmailCandidate = (candidateId, values) => request(`/gmail/candidates/${encoded(candidateId)}`, { method: "PATCH", json: values });
  const importGmailCandidate = (candidateId, projectId) => request(`/gmail/candidates/${encoded(candidateId)}/import`, { method: "POST", json: { project_id: projectId } });
  const updateImportRecord = (importId, row = {}) => {
    if (row.source_status === "linked" && row.transaction_id) {
      return reconcileImport(importId, { action: "link", transaction_id: row.transaction_id });
    }
    if (row.source_status === "rejected") return reconcileImport(importId, { action: "reject" });
    if ((row.source_status === "parsed" || row.source_status === "review") && !row.transaction_id) {
      return reconcileImport(importId, { action: "unlink" });
    }
    throw new TypeError("Import records are updated with reconcileImport");
  };
  const deleteImportRecord = (importId) => reconcileImport(importId, { action: "reject" });

  const getProjectSummaries = (projectId, query) => request(`/projects/${encoded(projectId, "projectId")}/summaries`, { query });
  const finalizeProject = (projectId) => request(`/projects/${encoded(projectId, "projectId")}/finalize`, { method: "POST" });
  const reopenProject = (projectId) => request(`/projects/${encoded(projectId, "projectId")}/reopen`, { method: "POST" });
  const createProjectShare = (projectId, payload = {}) => request(`/projects/${encoded(projectId, "projectId")}/share`, {
    method: "POST",
    json: payload,
  });
  const getSharedProject = (token) => request(`/share/${encoded(token, "token")}`);
  const getSession = () => request("/auth/session");
  const startGoogleLogin = () => request("/auth/google/start", { method: "POST" });
  const logout = () => request("/auth/logout", { method: "POST" });
  const deleteAccount = () => request("/account", { method: "DELETE" });
  const readReceipt = (imageDataUrl) => request("/ocr-receipt", {
    method: "POST",
    json: typeof imageDataUrl === "object" ? imageDataUrl : { image_data_url: imageDataUrl },
  });

  function generatedOperation(operation) {
    const row = operation?.row || {};
    const id = operation?.id ?? row.id;
    if (operation?.table === "transactions") {
      const generated = row.generated_automatically === 1
        || generatedTransactions.has(id)
        || String(id).startsWith("household:transaction:");
      if (generated) generatedTransactions.add(id);
      return generated;
    }
    if (operation?.table === "transaction_payments") {
      return generatedTransactions.has(row.transaction_id)
        || String(row.transaction_id).startsWith("household:transaction:")
        || String(id).startsWith("household:payment:");
    }
    if (operation?.table === "transaction_items") {
      const generated = generatedTransactions.has(row.transaction_id)
        || String(row.transaction_id).startsWith("household:transaction:")
        || generatedItems.has(id)
        || String(id).startsWith("household:item:");
      if (generated) generatedItems.add(id);
      return generated;
    }
    if (operation?.table === "item_allocations") {
      return generatedItems.has(row.transaction_item_id)
        || String(row.transaction_item_id).startsWith("household:item:")
        || String(id).startsWith("household:allocation:");
    }
    return false;
  }

  async function mutateRow(operation) {
    const action = operation?.action;
    const table = operation?.table;
    const row = operation?.row || {};
    const id = operation?.id ?? row.id;
    if (generatedOperation(operation)) return { ok: true, generated_record: true };
    if (table === "projects") {
      if (action === "create") {
        const result = await createProject(row);
        if (row.project_type === "household") {
          const generatedOwner = result?.project_members?.find((member) => member.role === "owner");
          if (generatedOwner) await deleteProjectMember(generatedOwner.id);
        }
        return result;
      }
      if (action === "update") {
        const wasFinalized = projectFinalized.get(id);
        const result = await updateProject(id, row);
        const isFinalized = Boolean(row.finalized_at);
        if (isFinalized && wasFinalized !== true) await finalizeProject(id);
        if (!isFinalized && wasFinalized === true) await reopenProject(id);
        return result;
      }
      if (action === "delete") return deleteProject(id);
    }
    if (table === "project_members") {
      if (action === "create") {
        const result = await createProjectMember(row);
        if (row.linked_household_project_id) await linkProjectMember(id, row.linked_household_project_id);
        return result;
      }
      if (action === "update") {
        const updated = await updateProjectMember(id, row);
        if (row.linked_household_project_id !== undefined) await linkProjectMember(id, row.linked_household_project_id);
        return updated;
      }
      if (action === "delete") return deleteProjectMember(id);
    }
    if (table === "transactions") {
      if (action === "create") return createTransaction(row);
      if (action === "update") return updateTransaction(id, row);
      if (action === "delete") return deleteTransaction(id);
    }
    if (table === "transaction_payments") {
      if (action === "create") return createTransactionPayment(row);
      if (action === "update") return updateTransactionPayment(id, row);
      if (action === "delete") return deleteTransactionPayment(id);
    }
    if (table === "transaction_items") {
      if (action === "create") return createTransactionItem(row);
      if (action === "update") return updateTransactionItem(id, row);
      if (action === "delete") return deleteTransactionItem(id);
    }
    if (table === "item_allocations") {
      if (action === "create") return createItemAllocation(row);
      if (action === "update") return updateItemAllocation(id, row);
      if (action === "delete") return deleteItemAllocation(id, row);
    }
    if (table === "import_records") {
      if (action === "create") return createImportRecord(row);
      if (action === "update") return updateImportRecord(id, row);
      if (action === "delete") return deleteImportRecord(id);
    }
    throw new TypeError(`Unsupported row mutation: ${String(action)} ${String(table)}`);
  }

  return {
    ...client,
    request,
    fetchJson: request,
    apiRequest: request,
    listProjects,
    getProject,
    createProject,
    updateProject,
    deleteProject,
    listProjectMembers,
    listMembers: listProjectMembers,
    createProjectMember,
    createMember: createProjectMember,
    updateProjectMember,
    updateMember: updateProjectMember,
    deleteProjectMember,
    deleteMember: deleteProjectMember,
    linkProjectMember,
    linkMember: linkProjectMember,
    updateMemberHouseholdLink: linkProjectMember,
    listTransactions,
    getTransaction,
    createTransaction,
    updateTransaction,
    deleteTransaction,
    createTransactionPayment,
    createPayment: createTransactionPayment,
    updateTransactionPayment,
    updatePayment: updateTransactionPayment,
    deleteTransactionPayment,
    deletePayment: deleteTransactionPayment,
    createTransactionItem,
    createItem: createTransactionItem,
    updateTransactionItem,
    updateItem: updateTransactionItem,
    deleteTransactionItem,
    deleteItem: deleteTransactionItem,
    replaceItemAllocations,
    createItemAllocation,
    createAllocation: createItemAllocation,
    updateItemAllocation,
    updateAllocation: updateItemAllocation,
    deleteItemAllocation,
    deleteAllocation: deleteItemAllocation,
    listImports,
    listImportRecords: listImports,
    createImportRecord,
    updateImportRecord,
    deleteImportRecord,
    importReceipt,
    createReceiptImport: importReceipt,
    importNotification,
    createNotificationImport: importNotification,
    importCsv,
    createCsvImports: importCsv,
    reconcileImport,
    startGmailConnection,
    listGmailConnections,
    disconnectGmail,
    syncGmail,
    listGmailCandidates,
    updateGmailCandidate,
    importGmailCandidate,
    getProjectSummaries,
    getProjectSummary: getProjectSummaries,
    getSummaries: getProjectSummaries,
    finalizeProject,
    reopenProject,
    createProjectShare,
    createShare: createProjectShare,
    getSharedProject,
    getShare: getSharedProject,
    getSession,
    startGoogleLogin,
    logout,
    deleteAccount,
    readReceipt,
    mutateRow,
    applyRowMutation: mutateRow,
  };
}

const defaultClient = createApiClient();
const api = {
  ApiError,
  CREATE_FIELDS,
  UPDATE_FIELDS,
  createFetchClient,
  createApiClient,
  ...defaultClient,
};

if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof globalThis !== "undefined") globalThis.WariApi = api;
