import {
  createProject,
  createProjectMember,
  createProjectShare,
  createTransaction,
  createTransactionItem,
  createTransactionPayment,
  deleteProject,
  deleteProjectMember,
  deleteTransaction,
  deleteTransactionItem,
  deleteTransactionPayment,
  getProjectGraph,
  getProjectSummaries,
  getSharedProject,
  getTransactionGraph,
  listProjectMembers,
  listProjectsForUser,
  listProjects,
  listTransactions,
  markProjectFinalized,
  markProjectReopened,
  replaceItemAllocations,
  requireProject,
  updateMemberHouseholdLink,
  updateProject,
  updateProjectMember,
  updateTransaction,
  updateTransactionItem,
  updateTransactionPayment,
} from "../lib/api-data.js";
import {
  CSRF_COOKIE,
  clearCookieHeader,
  createSession,
  ensureUser,
  getSessionUser,
  requireUser,
  revokeCurrentSession,
  sessionCookieHeaders,
  assertCsrf,
} from "../lib/auth.js";
import { assertOrigin } from "../lib/csrf.js";
import { createGoogleStart, finishGoogleCallback } from "../lib/oauth.js";
import {
  grantProjectRole,
  projectIdForImport,
  projectIdForItem,
  projectIdForMember,
  projectIdForPayment,
  projectIdForTransaction,
  requireProjectRole,
  requireProjectShareRole,
} from "../lib/permissions.js";
import { withSecurityHeaders } from "../lib/security-headers.js";
import {
  cancelGeneratedForSource,
  syncSplitProjectToHouseholds,
  syncSplitTransactionToHouseholds,
  validateSplitProject,
} from "../lib/household.js";
import {
  createCsvImports,
  createNotificationImport,
  createReceiptImport,
  listImports,
  reconcileImport,
} from "../lib/imports.js";
import { handleReceiptOcr } from "../lib/ocr.js";
import {
  disconnectGmail,
  disconnectAllGmail,
  finishGmailOAuth,
  importCandidate,
  listCandidates,
  listConnections,
  listSyncRuns,
  startGmailOAuth,
  syncGmail,
  updateCandidate,
} from "../lib/gmail.js";
import { ApiError, errorResponse, json, methodNotAllowed, readJson, readOptionalJson } from "../lib/responses.js";

const IMPORT_STATUSES = new Set(["received", "parsed", "linked", "review", "rejected", "error"]);
const IMPORT_SOURCES = new Set(["receipt", "gmail_notification", "card_csv", "paypay_csv", "bank_csv", "manual"]);
const CSV_PROFILES = new Set(["generic", "card", "paypay", "bank"]);
const RECONCILE_ACTIONS = new Set(["link", "create", "reject", "unlink"]);

export async function onRequest(context) {
  const request = context.request;
  try {
    assertOrigin(request, context.env || {});
    const url = new URL(request.url);
    const path = requestPath(url.pathname);
    const db = context.env?.DB;
    if (!db) throw new ApiError(500, "missing_d1_binding");
    if (path[0] === "ocr-receipt" && path.length === 1) {
      return withSecurityHeaders(await dispatchReceiptOcr(request, db, context.env || {}, url));
    }
    const response = await dispatch(request, db, context.env || {}, url, path);
    return withSecurityHeaders(response);
  } catch (error) {
    return withSecurityHeaders(errorResponse(error));
  }
}

async function dispatchReceiptOcr(request, db, env, url) {
  return invoke(request, ["POST"], async () => {
    const body = await readJson(request);
    const projectId = body.project_id ?? url.searchParams.get("project_id");
    if (typeof projectId !== "string" || projectId.trim() === "") throw new ApiError(400, "missing_field", { field: "project_id" });
    const user = await getSessionUser(db, request);
    if (user) {
      assertCsrf(request, user);
      try {
        await requireProjectRole(db, user, projectId, "editor");
        return handleReceiptOcr(request, env, body);
      } catch (error) {
        if (!(error instanceof ApiError) || error.code !== "not_found") throw error;
      }
    }
    const shareToken = bearerToken(request) ?? body.share_token ?? url.searchParams.get("share_token");
    if (shareToken) {
      await requireProjectShareRole(db, projectId, shareToken, "editor");
      return handleReceiptOcr(request, env, body);
    }
    if (!user) throw new ApiError(401, "authentication_required");
    throw new ApiError(404, "not_found");
  });
}

async function dispatch(request, db, env, url, path) {
  if (path[0] === "auth") return dispatchAuth(request, db, env, url, path);
  if (path[0] === "account" && path.length === 1) return dispatchAccount(request, db, env);
  if (path[0] === "share" && path.length === 2) {
    return invoke(request, ["GET"], async () => json(await getSharedProject(db, path[1])));
  }
  const user = await requireUser(db, request);
  assertCsrf(request, user);
  if (path[0] === "gmail") return dispatchGmail(request, db, env, url, path, user);
  if (path[0] === "projects") return dispatchProjects(request, db, url, path, user);
  if ((path[0] === "project-members" || path[0] === "members") && path.length >= 2) {
    return dispatchMember(request, db, path, user);
  }
  if (path[0] === "transactions" && path.length >= 2) {
    return dispatchTransaction(request, db, path, user);
  }
  if ((path[0] === "transaction-payments" || path[0] === "payments") && path.length === 2) {
    return dispatchPayment(request, db, path[1], user);
  }
  if ((path[0] === "transaction-items" || path[0] === "items") && path.length >= 2) {
    return dispatchItem(request, db, path, user);
  }
  if (path[0] === "imports" && path.length === 3 && path[2] === "reconcile") {
    return invoke(request, ["POST"], async () => {
      await requireProjectRole(db, user, await projectIdForImport(db, path[1]), "editor");
      return handleReconcile(request, db, path[1]);
    });
  }
  return json({ error: "not_found" }, 404);
}

async function dispatchAuth(request, db, env, url, path) {
  if (path.length === 2 && path[1] === "session") {
    return invoke(request, ["GET"], async () => {
      const user = await getSessionUser(db, request);
      const headers = new Headers();
      if (user) headers.append("set-cookie", `${CSRF_COOKIE}=${encodeURIComponent(user.csrf_token)}; Path=/; Secure; SameSite=Lax`);
      return json({ authenticated: Boolean(user), user: user ? publicUser(user) : null, csrf_token: user?.csrf_token || null }, 200, headers);
    });
  }
  if (path.length === 3 && path[1] === "google" && path[2] === "start") {
    return invoke(request, ["POST"], async () => {
      const start = await createGoogleStart(db, env, request);
      return json({ url: start.url }, 200, { "set-cookie": start.cookie });
    });
  }
  if (path.length === 3 && path[1] === "google" && path[2] === "callback") {
    return invoke(request, ["GET"], async () => {
      const callback = await finishGoogleCallback(db, env, request);
      const user = await ensureUser(db, callback.profile);
      const session = await createSession(db, user.id);
      const headers = new Headers({
        location: env.APP_ORIGIN || new URL("/", url).toString(),
      });
      headers.append("set-cookie", callback.clearCookie);
      for (const cookie of sessionCookieHeaders(session)) headers.append("set-cookie", cookie);
      return new Response(null, { status: 302, headers });
    });
  }
  if (path.length === 2 && path[1] === "logout") {
    return invoke(request, ["POST"], async () => {
      const user = await requireUser(db, request);
      assertCsrf(request, user);
      await revokeCurrentSession(db, request);
      const headers = new Headers();
      headers.append("set-cookie", clearCookieHeader("wari_session"));
      headers.append("set-cookie", clearCookieHeader(CSRF_COOKIE));
      return json({ ok: true }, 200, headers);
    });
  }
  return json({ error: "not_found" }, 404);
}

async function dispatchAccount(request, db, env) {
  return invoke(request, ["DELETE"], async () => {
    const user = await requireUser(db, request);
    assertCsrf(request, user);
    await disconnectAllGmail(db, env, user);
    const timestamp = new Date().toISOString();
    await db.batch([
      db.prepare("UPDATE users SET deleted_at = ?, updated_at = ? WHERE id = ?").bind(timestamp, timestamp, user.id),
      db.prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL").bind(timestamp, user.id),
      db.prepare("UPDATE project_user_roles SET revoked_at = ?, updated_at = ? WHERE user_id = ? AND revoked_at IS NULL").bind(timestamp, timestamp, user.id),
    ]);
    const headers = new Headers();
    headers.append("set-cookie", clearCookieHeader("wari_session"));
    headers.append("set-cookie", clearCookieHeader(CSRF_COOKIE));
    return json({ ok: true }, 200, headers);
  });
}

async function dispatchGmail(request, db, env, url, path, user) {
  if (path.length === 3 && path[1] === "oauth" && path[2] === "start") {
    return invoke(request, ["POST"], async () => {
      await readOptionalJson(request);
      const result = await startGmailOAuth(db, env, request, user);
      return json({ url: result.url }, 200, { "set-cookie": result.cookie });
    });
  }
  if (path.length === 3 && path[1] === "oauth" && path[2] === "callback") {
    return invoke(request, ["GET"], async () => {
      try {
        const result = await finishGmailOAuth(db, env, request, user);
        const headers = new Headers({ location: env.APP_ORIGIN || new URL("/", url).toString() });
        headers.append("set-cookie", result.clearCookie);
        return new Response(null, { status: 302, headers });
      } catch (error) {
        const response = errorResponse(error);
        response.headers.append("set-cookie", clearCookieHeader("wari_gmail_oauth"));
        return response;
      }
    });
  }
  if (path.length === 2 && path[1] === "connections") return invoke(request, ["GET"], async () => json(await listConnections(db, user)));
  if (path.length === 3 && path[1] === "connections") {
    return invoke(request, ["DELETE"], async () => json(await disconnectGmail(db, env, user, path[2])));
  }
  if (path.length === 4 && path[1] === "connections" && path[3] === "sync") {
    return invoke(request, ["POST"], async () => json(await syncGmail(db, env, user, path[2], await readJson(request))));
  }
  if (path.length === 4 && path[1] === "connections" && path[3] === "sync-runs") {
    return invoke(request, ["GET"], async () => json(await listSyncRuns(db, user, path[2])));
  }
  if (path.length === 2 && path[1] === "candidates") {
    return invoke(request, ["GET"], async () => {
      assertQueryFields(url.searchParams, new Set(["status"]));
      return json(await listCandidates(db, user, url.searchParams.get("status")));
    });
  }
  if (path.length === 3 && path[1] === "candidates") {
    return invoke(request, ["PATCH"], async () => json(await updateCandidate(db, user, path[2], await readJson(request))));
  }
  if (path.length === 4 && path[1] === "candidates" && path[3] === "import") {
    return invoke(request, ["POST"], async () => json(await importCandidate(db, user, path[2], await readJson(request))), 201);
  }
  return json({ error: "not_found" }, 404);
}

async function dispatchProjects(request, db, url, path, user) {
  if (path.length === 1) {
    if (request.method === "GET") return json(await listProjectsForUser(db, user));
    if (request.method === "POST") {
      const result = await createProject(db, await readJson(request));
      await grantProjectRole(db, result.projects[0].id, user.id, "owner");
      return json(result, 201);
    }
    return methodNotAllowed(["GET", "POST"]);
  }
  const projectId = path[1];
  if (path.length === 2) {
    if (request.method === "GET") {
      await requireProjectRole(db, user, projectId, "viewer");
      const graph = await getProjectGraph(db, projectId);
      if (graph.projects.length === 0) throw new ApiError(404, "not_found");
      return json(graph);
    }
    if (request.method === "PATCH") {
      await requireProjectRole(db, user, projectId, "editor");
      const result = await updateProject(db, projectId, await readJson(request));
      if (result.project.project_type !== "split") await cancelGeneratedForSource(db, projectId);
      else await syncSplitProjectToHouseholds(db, projectId, { validate: false });
      return json(result);
    }
    if (request.method === "DELETE") {
      await requireProjectRole(db, user, projectId, "owner");
      await cancelGeneratedForSource(db, projectId);
      return json(await deleteProject(db, projectId));
    }
    return methodNotAllowed(["GET", "PATCH", "DELETE"]);
  }
  if (path[2] === "share" && path.length === 3) {
    return invoke(request, ["POST"], async () => {
      await requireProjectRole(db, user, projectId, "owner");
      return json(await createProjectShare(db, projectId, await readOptionalJson(request), user));
    });
  }
  if (path[2] === "members") return dispatchProjectMembers(request, db, url, path, user);
  if (path[2] === "transactions") return dispatchProjectTransactions(request, db, url, path, user);
  if (path[2] === "imports") return dispatchProjectImports(request, db, url, path, user);
  if (path[2] === "summaries" && path.length === 3) {
    return invoke(request, ["GET"], async () => {
      await requireProjectRole(db, user, projectId, "viewer");
      return json(await getProjectSummaries(db, projectId));
    });
  }
  if (path[2] === "finalize" && path.length === 3) {
    return invoke(request, ["POST"], async () => {
      await requireProjectRole(db, user, projectId, "editor");
      return finalizeProject(db, projectId);
    });
  }
  if (path[2] === "reopen" && path.length === 3) {
    return invoke(request, ["POST"], async () => {
      await requireProjectRole(db, user, projectId, "editor");
      return reopenProject(db, projectId);
    });
  }
  return json({ error: "not_found" }, 404);
}

async function dispatchProjectMembers(request, db, url, path, user) {
  const projectId = path[1];
  if (path.length === 3) {
    if (request.method === "GET") {
      await requireProjectRole(db, user, projectId, "viewer");
      assertQueryFields(url.searchParams, new Set(["include_inactive"]));
      const includeInactive = booleanQuery(url.searchParams.get("include_inactive"), "include_inactive", false);
      return json(await listProjectMembers(db, projectId, includeInactive));
    }
    if (request.method === "POST") {
      await requireProjectRole(db, user, projectId, "editor");
      return json(await createProjectMember(db, projectId, await readJson(request)), 201);
    }
    return methodNotAllowed(["GET", "POST"]);
  }
  if (path.length === 4) {
    if (request.method === "PATCH") {
      await requireProjectRole(db, user, projectId, "editor");
      const result = await updateProjectMember(db, path[3], await readJson(request), projectId);
      await syncSplitProjectToHouseholds(db, projectId, { validate: false });
      return json(result);
    }
    if (request.method === "DELETE") {
      await requireProjectRole(db, user, projectId, "editor");
      const result = await deleteProjectMember(db, path[3], projectId);
      await syncSplitProjectToHouseholds(db, projectId, { validate: false });
      return json(result);
    }
    return methodNotAllowed(["PATCH", "DELETE"]);
  }
  return json({ error: "not_found" }, 404);
}

async function dispatchMember(request, db, path, user) {
  const memberId = path[1];
  if (path.length === 2) {
    if (request.method === "PATCH") {
      await requireProjectRole(db, user, await projectIdForMember(db, memberId), "editor");
      const result = await updateProjectMember(db, memberId, await readJson(request));
      await syncSplitProjectToHouseholds(db, result.project_member.project_id, { validate: false });
      return json(result);
    }
    if (request.method === "DELETE") {
      await requireProjectRole(db, user, await projectIdForMember(db, memberId), "editor");
      const member = await memberProject(db, memberId);
      const result = await deleteProjectMember(db, memberId);
      await syncSplitProjectToHouseholds(db, member.project_id, { validate: false });
      return json(result);
    }
    return methodNotAllowed(["PATCH", "DELETE"]);
  }
  if (path.length === 3 && path[2] === "household-link") {
    return invoke(request, ["PATCH"], async () => {
      await requireProjectRole(db, user, await projectIdForMember(db, memberId), "editor");
      const result = await updateMemberHouseholdLink(db, memberId, await readJson(request));
      await syncSplitProjectToHouseholds(db, result.project_member.project_id, { validate: false });
      return json(result);
    });
  }
  return json({ error: "not_found" }, 404);
}

async function dispatchProjectTransactions(request, db, url, path, user) {
  const projectId = path[1];
  if (path.length === 3) {
    if (request.method === "GET") {
      await requireProjectRole(db, user, projectId, "viewer");
      return json(await listTransactions(db, projectId, url.searchParams));
    }
    if (request.method === "POST") {
      await requireProjectRole(db, user, projectId, "editor");
      const result = await createTransaction(db, projectId, await readJson(request));
      await syncSplitTransactionToHouseholds(db, result.transaction.id, { validate: false });
      return json(result, 201);
    }
    return methodNotAllowed(["GET", "POST"]);
  }
  if (path.length === 4) {
    await requireProjectRole(db, user, projectId, "viewer");
    await assertTransactionProject(db, path[3], projectId);
    return dispatchTransaction(request, db, ["transactions", path[3]], user);
  }
  return json({ error: "not_found" }, 404);
}

async function dispatchTransaction(request, db, path, user) {
  const transactionId = path[1];
  if (path.length === 2) {
    if (request.method === "GET") {
      await requireProjectRole(db, user, await projectIdForTransaction(db, transactionId), "viewer");
      return json(await getTransactionGraph(db, transactionId));
    }
    if (request.method === "PATCH") {
      await requireProjectRole(db, user, await projectIdForTransaction(db, transactionId), "editor");
      const result = await updateTransaction(db, transactionId, await readJson(request));
      await syncSplitTransactionToHouseholds(db, transactionId, { validate: false });
      return json(result);
    }
    if (request.method === "DELETE") {
      await requireProjectRole(db, user, await projectIdForTransaction(db, transactionId), "editor");
      const result = await deleteTransaction(db, transactionId);
      await syncSplitTransactionToHouseholds(db, transactionId, { sourceProjectId: result.project_id, validate: false });
      return json({ ok: true });
    }
    return methodNotAllowed(["GET", "PATCH", "DELETE"]);
  }
  if (path[2] === "payments") {
    if (path.length === 3) {
      return invoke(request, ["POST"], async () => {
        await requireProjectRole(db, user, await projectIdForTransaction(db, transactionId), "editor");
        return json(await createTransactionPayment(db, transactionId, await readJson(request)), 201);
      });
    }
    if (path.length === 4) {
      await assertPaymentTransaction(db, path[3], transactionId);
      return dispatchPayment(request, db, path[3], user);
    }
  }
  if (path[2] === "items") {
    if (path.length === 3) {
      return invoke(request, ["POST"], async () => {
        await requireProjectRole(db, user, await projectIdForTransaction(db, transactionId), "editor");
        const result = await createTransactionItem(db, transactionId, await readJson(request));
        await syncSplitTransactionToHouseholds(db, transactionId, { validate: false });
        return json(result, 201);
      });
    }
    if (path.length === 4) {
      await assertItemTransaction(db, path[3], transactionId);
      return dispatchItem(request, db, ["items", path[3]], user);
    }
    if (path.length === 5 && path[4] === "allocations") {
      await assertItemTransaction(db, path[3], transactionId);
      return replaceAllocations(request, db, path[3], user);
    }
  }
  return json({ error: "not_found" }, 404);
}

async function dispatchPayment(request, db, paymentId, user) {
  if (request.method === "PATCH") {
    await requireProjectRole(db, user, await projectIdForPayment(db, paymentId), "editor");
    return json(await updateTransactionPayment(db, paymentId, await readJson(request)));
  }
  if (request.method === "DELETE") {
    await requireProjectRole(db, user, await projectIdForPayment(db, paymentId), "editor");
    return json(await deleteTransactionPayment(db, paymentId));
  }
  return methodNotAllowed(["PATCH", "DELETE"]);
}

async function dispatchItem(request, db, path, user) {
  const itemId = path[1];
  if (path.length === 2) {
    if (request.method === "PATCH") {
      await requireProjectRole(db, user, await projectIdForItem(db, itemId), "editor");
      const result = await updateTransactionItem(db, itemId, await readJson(request));
      await syncSplitTransactionToHouseholds(db, result.transaction_item.transaction_id, { validate: false });
      return json(result);
    }
    if (request.method === "DELETE") {
      await requireProjectRole(db, user, await projectIdForItem(db, itemId), "editor");
      const result = await deleteTransactionItem(db, itemId);
      await syncSplitTransactionToHouseholds(db, result.transaction_id, { sourceProjectId: result.project_id, validate: false });
      return json({ ok: true });
    }
    return methodNotAllowed(["PATCH", "DELETE"]);
  }
  if (path.length === 3 && path[2] === "allocations") return replaceAllocations(request, db, itemId, user);
  return json({ error: "not_found" }, 404);
}

async function replaceAllocations(request, db, itemId, user) {
  return invoke(request, ["PUT"], async () => {
    await requireProjectRole(db, user, await projectIdForItem(db, itemId), "editor");
    const result = await replaceItemAllocations(db, itemId, await readJson(request));
    await syncSplitTransactionToHouseholds(db, result.transaction_id, { validate: false });
    return json(result);
  });
}

async function dispatchProjectImports(request, db, url, path, user) {
  const projectId = path[1];
  if (path.length === 3) {
    return invoke(request, ["GET"], async () => {
      await requireProjectRole(db, user, projectId, "viewer");
      const options = importListOptions(url.searchParams);
      await requireProject(db, projectId);
      return json({ imports: await listImports(db, projectId, options) });
    });
  }
  if (path.length !== 4 || !new Set(["receipt", "csv", "notification"]).has(path[3])) {
    return json({ error: "not_found" }, 404);
  }
  return invoke(request, ["POST"], async () => {
    await requireProjectRole(db, user, projectId, "editor");
    await requireOpenProject(db, projectId);
    const body = await readJson(request);
    let result;
    if (path[3] === "csv") {
      const csv = csvInput(body);
      result = await importCall(() => createCsvImports(db, projectId, csv.text, csv.profile, csv.options));
    } else {
      validateImportInput(body, path[3]);
      result = path[3] === "receipt"
        ? await importCall(() => createReceiptImport(db, projectId, body))
        : await importCall(() => createNotificationImport(db, projectId, body));
    }
    await syncSplitProjectToHouseholds(db, projectId, { validate: false });
    return json(result, 201);
  });
}

function publicUser(user) {
  return { id: user.id, email: user.email, name: user.name };
}

async function handleReconcile(request, db, importId) {
  const body = await readJson(request);
  validateReconcileInput(body);
  const record = await db.prepare("SELECT * FROM import_records WHERE id = ?").bind(importId).first();
  if (!record) throw new ApiError(404, "not_found");
  await requireOpenProject(db, record.project_id);
  if (body.action === "link") {
    const transactionId = requiredBodyString(body, "transaction_id", 128);
    await assertTransactionProject(db, transactionId, record.project_id);
  }
  if (body.action === "create") {
    if (!Number.isSafeInteger(record.paid_amount_raw) || !record.occurred_at_raw || !Number.isFinite(Date.parse(record.occurred_at_raw))) {
      throw new ApiError(422, "import_not_reconcilable");
    }
    if (body.new_transaction_id) {
      const existing = await db.prepare("SELECT id FROM transactions WHERE id = ?").bind(body.new_transaction_id).first();
      if (existing) throw new ApiError(409, "id_conflict", { field: "new_transaction_id" });
    }
  }
  const result = await reconcileImport(db, record.project_id, importId, body);
  await syncSplitProjectToHouseholds(db, record.project_id, { validate: false });
  return json(result);
}

async function finalizeProject(db, projectId) {
  const project = await requireProject(db, projectId);
  if (project.project_type !== "split") throw new ApiError(409, "project_not_split");
  const validation = await validateSplitProject(db, project.id);
  if (!validation.valid) throw new ApiError(422, "invalid_project", { validation });
  const result = await markProjectFinalized(db, project.id);
  const synchronization = await syncSplitProjectToHouseholds(db, project.id, { validate: false });
  return json({ ...result, validation, synchronization });
}

async function reopenProject(db, projectId) {
  const project = await requireProject(db, projectId);
  if (project.project_type !== "split") throw new ApiError(409, "project_not_split");
  const result = await markProjectReopened(db, projectId);
  const synchronization = await syncSplitProjectToHouseholds(db, projectId, { validate: false });
  return json({ ...result, synchronization });
}

async function invoke(request, methods, callback) {
  if (!methods.includes(request.method)) return methodNotAllowed(methods);
  return callback();
}

function requestPath(pathname) {
  const value = pathname === "/api" ? "" : pathname.startsWith("/api/") ? pathname.slice(5) : pathname.replace(/^\/+/, "");
  try {
    return value.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
  } catch {
    throw new ApiError(400, "invalid_path");
  }
}

function bearerToken(request) {
  const header = request.headers.get("authorization") || "";
  const match = /^Bearer\s+(.+)$/iu.exec(header);
  return match ? match[1].trim() : null;
}

async function memberProject(db, memberId) {
  const row = await db.prepare("SELECT project_id FROM project_members WHERE id = ?").bind(memberId).first();
  if (!row) throw new ApiError(404, "not_found");
  return row;
}

async function assertTransactionProject(db, transactionId, projectId) {
  const row = await db.prepare("SELECT id FROM transactions WHERE id = ? AND project_id = ?").bind(transactionId, projectId).first();
  if (!row) throw new ApiError(404, "not_found");
}

async function assertPaymentTransaction(db, paymentId, transactionId) {
  const row = await db.prepare("SELECT id FROM transaction_payments WHERE id = ? AND transaction_id = ?").bind(paymentId, transactionId).first();
  if (!row) throw new ApiError(404, "not_found");
}

async function assertItemTransaction(db, itemId, transactionId) {
  const row = await db.prepare("SELECT id FROM transaction_items WHERE id = ? AND transaction_id = ?").bind(itemId, transactionId).first();
  if (!row) throw new ApiError(404, "not_found");
}

async function requireOpenProject(db, projectId) {
  const project = await requireProject(db, projectId);
  if (project.finalized_at !== null && project.finalized_at !== undefined) throw new ApiError(409, "project_finalized");
  return project;
}

function importListOptions(searchParams) {
  assertQueryFields(searchParams, new Set(["status", "source_status", "source_type", "transaction_id", "before", "limit"]));
  const statuses = commaEnums(searchParams.get("status") ?? searchParams.get("source_status"), "status", IMPORT_STATUSES);
  const sourceTypes = commaEnums(searchParams.get("source_type"), "source_type", IMPORT_SOURCES);
  const transactionId = optionalQueryString(searchParams.get("transaction_id"), "transaction_id", 128);
  const before = optionalQueryDate(searchParams.get("before"), "before");
  const limit = optionalQueryInteger(searchParams.get("limit"), "limit", 1, 100);
  return {
    status: statuses,
    source_type: sourceTypes,
    ...(transactionId ? { transaction_id: transactionId } : {}),
    ...(before ? { before } : {}),
    ...(limit !== null ? { limit } : {}),
  };
}

function csvInput(body) {
  assertAllowedBody(body, new Set(["csv", "csv_text", "text", "profile", "options"]));
  const text = body.csv ?? body.csv_text ?? body.text;
  if (typeof text !== "string" || text.length === 0 || new TextEncoder().encode(text).byteLength > 5 * 1024 * 1024) {
    throw new ApiError(400, "invalid_field", { field: "csv" });
  }
  const profile = body.profile ?? "generic";
  if (typeof profile !== "string" || !CSV_PROFILES.has(profile)) throw new ApiError(400, "invalid_field", { field: "profile" });
  const options = body.options ?? {};
  if (!options || typeof options !== "object" || Array.isArray(options)) throw new ApiError(400, "invalid_field", { field: "options" });
  assertAllowedBody(options, new Set(["delimiter", "maxRows", "max_rows", "provider", "source_type"]));
  if (options.delimiter !== undefined && !new Set([",", "\t", ";", "|"]).has(options.delimiter)) throw new ApiError(400, "invalid_field", { field: "delimiter" });
  if (options.maxRows !== undefined) boundedBodyInteger(options.maxRows, "maxRows", 1, 5_000);
  if (options.max_rows !== undefined) boundedBodyInteger(options.max_rows, "max_rows", 1, 5_000);
  if (options.provider !== undefined) bodyString(options.provider, "provider", 160);
  if (options.source_type !== undefined && !IMPORT_SOURCES.has(options.source_type)) throw new ApiError(400, "invalid_field", { field: "source_type" });
  return { text, profile, options };
}

function validateImportInput(body, kind) {
  const fields = new Set([
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
  assertAllowedBody(body, fields);
  const encoded = new TextEncoder().encode(JSON.stringify(body)).byteLength;
  if (encoded > 2 * 1024 * 1024) throw new ApiError(413, "import_payload_too_large");
  validateNestedValue(body, 0);
  for (const field of ["paid_amount_raw", "paid_amount", "total_amount", "amount", "gross_amount_raw", "gross_amount", "discount_amount", "point_amount"]) {
    if (body[field] !== undefined && !Number.isSafeInteger(body[field])) throw new ApiError(400, "invalid_integer", { field });
  }
  for (const field of ["merchant_raw", "merchant_name", "store_name", "merchant", "account_label", "provider", "category"]) {
    if (body[field] !== undefined && body[field] !== null) bodyString(body[field], field, 300);
  }
  for (const field of ["id", "source_record_id", "receipt_id", "document_id", "message_id", "notification_id", "external_transaction_id", "external_payment_id", "transaction_id", "payer_member_id", "parser_version"]) {
    if (body[field] !== undefined && body[field] !== null) bodyString(body[field], field, 300);
  }
  for (const field of ["occurred_at_raw", "occurred_at", "paid_at", "date", "received_at", "settled_at_raw", "settled_at"]) {
    if (body[field] !== undefined && body[field] !== null) bodyString(body[field], field, 64);
  }
  for (const field of ["parse_confidence", "confidence"]) {
    if (body[field] !== undefined && (typeof body[field] !== "number" || !Number.isFinite(body[field]) || body[field] < 0 || body[field] > 1)) {
      throw new ApiError(400, "invalid_number", { field });
    }
  }
  if (body.valid !== undefined && typeof body.valid !== "boolean") throw new ApiError(400, "invalid_boolean", { field: "valid" });
  if (kind === "notification" && body.image_url !== undefined) bodyString(body.image_url, "image_url", 500_000);
}

function validateReconcileInput(body) {
  assertAllowedBody(body, new Set(["action", "transaction_id", "new_transaction_id", "match_score", "match_reason_json"]));
  if (typeof body.action !== "string" || !RECONCILE_ACTIONS.has(body.action)) throw new ApiError(400, "invalid_field", { field: "action" });
  if (body.transaction_id !== undefined) bodyString(body.transaction_id, "transaction_id", 128);
  if (body.new_transaction_id !== undefined) bodyString(body.new_transaction_id, "new_transaction_id", 128);
  if (body.match_score !== undefined) boundedBodyInteger(body.match_score, "match_score", 0, 100);
  if (body.match_reason_json !== undefined) {
    const value = typeof body.match_reason_json === "string" ? body.match_reason_json : JSON.stringify(body.match_reason_json);
    if (value.length > 20_000) throw new ApiError(400, "invalid_field", { field: "match_reason_json" });
  }
  if (body.action === "link" && body.transaction_id === undefined) throw new ApiError(400, "missing_field", { field: "transaction_id" });
}

async function importCall(callback) {
  try {
    return await callback();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof TypeError) throw new ApiError(400, "invalid_import");
    throw error;
  }
}

function assertAllowedBody(body, allowed) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiError(400, "invalid_json_body");
  const unknown = Object.keys(body).find((field) => !allowed.has(field));
  if (unknown) throw new ApiError(400, "unknown_field", { field: unknown });
}

function validateNestedValue(value, depth) {
  if (depth > 8) throw new ApiError(400, "invalid_import_payload");
  if (typeof value === "string") {
    if (value.length > 500_000) throw new ApiError(400, "invalid_import_payload");
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 1_000) throw new ApiError(400, "invalid_import_payload");
    for (const entry of value) validateNestedValue(entry, depth + 1);
    return;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length > 200) throw new ApiError(400, "invalid_import_payload");
    for (const [key, entry] of entries) {
      if (key.length > 200) throw new ApiError(400, "invalid_import_payload");
      validateNestedValue(entry, depth + 1);
    }
  }
}

function assertQueryFields(searchParams, allowed) {
  for (const field of searchParams.keys()) {
    if (!allowed.has(field)) throw new ApiError(400, "invalid_query_parameter", { field });
  }
}

function booleanQuery(value, field, fallback) {
  if (value === null) return fallback;
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  throw new ApiError(400, "invalid_query_parameter", { field });
}

function commaEnums(value, field, allowed) {
  if (value === null || value === "") return [];
  const values = [...new Set(value.split(",").map((entry) => entry.trim()).filter(Boolean))];
  if (values.length > 10 || values.some((entry) => !allowed.has(entry))) throw new ApiError(400, "invalid_query_parameter", { field });
  return values;
}

function optionalQueryString(value, field, maximum) {
  if (value === null || value === "") return null;
  if (value.length > maximum) throw new ApiError(400, "invalid_query_parameter", { field });
  return value;
}

function optionalQueryDate(value, field) {
  const result = optionalQueryString(value, field, 64);
  if (result !== null && !Number.isFinite(Date.parse(result))) throw new ApiError(400, "invalid_query_parameter", { field });
  return result;
}

function optionalQueryInteger(value, field, minimum, maximum) {
  if (value === null || value === "") return null;
  if (!/^\d+$/.test(value)) throw new ApiError(400, "invalid_query_parameter", { field });
  return boundedBodyInteger(Number(value), field, minimum, maximum, "invalid_query_parameter");
}

function requiredBodyString(body, field, maximum) {
  if (body[field] === undefined) throw new ApiError(400, "missing_field", { field });
  return bodyString(body[field], field, maximum);
}

function bodyString(value, field, maximum) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) throw new ApiError(400, "invalid_field", { field });
  return value.trim();
}

function boundedBodyInteger(value, field, minimum, maximum, code = "invalid_integer") {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new ApiError(400, code, { field });
  return value;
}
