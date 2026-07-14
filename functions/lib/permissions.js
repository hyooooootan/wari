import { ApiError } from "./responses.js";
import { sha256Hex } from "./crypto.js";

const ROLE_LEVELS = Object.freeze({ viewer: 1, editor: 2, owner: 3 });
const SHARE_ROLE_LEVELS = Object.freeze({ viewer: 1, editor: 2 });

export async function grantProjectRole(db, projectId, userId, role, timestamp = now()) {
  if (!ROLE_LEVELS[role]) throw new ApiError(400, "invalid_role");
  await db.prepare(`INSERT INTO project_user_roles (
    project_id, user_id, role, created_at, updated_at, revoked_at
  ) VALUES (?, ?, ?, ?, ?, NULL)
  ON CONFLICT(project_id, user_id) DO UPDATE SET
    role = excluded.role,
    updated_at = excluded.updated_at,
    revoked_at = NULL`).bind(projectId, userId, role, timestamp, timestamp).run();
}

export async function requireProjectRole(db, user, projectId, requiredRole = "viewer") {
  const access = await projectRole(db, user, projectId);
  if (!access || ROLE_LEVELS[access.role] < ROLE_LEVELS[requiredRole]) throw new ApiError(404, "not_found");
  return access;
}

export async function requireProjectShareRole(db, projectId, token, requiredRole = "viewer") {
  const project = boundedString(projectId, "project_id", 1, 128, true);
  const bearer = boundedString(token, "share_token", 16, 256, false);
  const timestamp = now();
  const share = await db.prepare(`SELECT project_shares.project_id, project_shares.role, project_shares.expires_at
    FROM project_shares
    JOIN projects ON projects.id = project_shares.project_id
    WHERE project_shares.project_id = ?
      AND projects.project_type = 'split'
      AND token_hash = ?
      AND revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at > ?)
    LIMIT 1`).bind(project, await sha256Hex(bearer), timestamp).first();
  if (share) {
    if (SHARE_ROLE_LEVELS[share.role] < SHARE_ROLE_LEVELS[requiredRole]) throw new ApiError(404, "not_found");
    return { project_id: share.project_id, role: share.role, expires_at: share.expires_at };
  }
  const legacy = await db.prepare(`SELECT id AS project_id, share_role AS role, share_expires_at AS expires_at
    FROM projects
    WHERE id = ?
      AND project_type = 'split'
      AND share_token = ?
      AND (share_expires_at IS NULL OR share_expires_at > ?)
    LIMIT 1`).bind(project, bearer, timestamp).first();
  if (!legacy || SHARE_ROLE_LEVELS[legacy.role] < SHARE_ROLE_LEVELS[requiredRole]) throw new ApiError(404, "not_found");
  return legacy;
}

export async function projectRole(db, user, projectId) {
  if (!user) return null;
  const row = await db.prepare(`SELECT
      projects.id AS project_id,
      CASE WHEN projects.project_type = 'household' THEN 'owner' ELSE roles.role END AS role
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
        OR (projects.project_type = 'split' AND roles.user_id IS NOT NULL)
      )`).bind(user.id, projectId).first();
  return row ? { project_id: row.project_id, user_id: user.id, role: row.role } : null;
}

export async function projectIdForMember(db, memberId) {
  const row = await db.prepare("SELECT project_id FROM project_members WHERE id = ?").bind(memberId).first();
  if (!row) throw new ApiError(404, "not_found");
  return row.project_id;
}

export async function projectIdForTransaction(db, transactionId) {
  const row = await db.prepare("SELECT project_id FROM transactions WHERE id = ?").bind(transactionId).first();
  if (!row) throw new ApiError(404, "not_found");
  return row.project_id;
}

export async function projectIdForPayment(db, paymentId) {
  const row = await db.prepare(`SELECT transactions.project_id
    FROM transaction_payments payments
    JOIN transactions ON transactions.id = payments.transaction_id
    WHERE payments.id = ?`).bind(paymentId).first();
  if (!row) throw new ApiError(404, "not_found");
  return row.project_id;
}

export async function projectIdForItem(db, itemId) {
  const row = await db.prepare(`SELECT transactions.project_id
    FROM transaction_items items
    JOIN transactions ON transactions.id = items.transaction_id
    WHERE items.id = ?`).bind(itemId).first();
  if (!row) throw new ApiError(404, "not_found");
  return row.project_id;
}

export async function projectIdForImport(db, importId) {
  const row = await db.prepare("SELECT project_id FROM import_records WHERE id = ?").bind(importId).first();
  if (!row) throw new ApiError(404, "not_found");
  return row.project_id;
}

function now() {
  return new Date().toISOString();
}

function boundedString(value, field, minimum, maximum, trim) {
  if (typeof value !== "string") throw new ApiError(400, "invalid_field", { field });
  const result = trim ? value.trim() : value;
  if (result.length < minimum || result.length > maximum) throw new ApiError(400, "invalid_field", { field });
  return result;
}
