PRAGMA defer_foreign_keys = ON;

CREATE TABLE _0009_migration_guard (
  check_name TEXT PRIMARY KEY,
  ok INTEGER NOT NULL CHECK (ok = 1)
);

INSERT INTO _0009_migration_guard (check_name, ok)
SELECT 'no_shared_household', CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END
FROM projects
WHERE project_type = 'shared_household';

INSERT INTO _0009_migration_guard (check_name, ok)
SELECT 'household_owner_is_unique', CASE WHEN NOT EXISTS (
  SELECT 1 FROM projects p
  LEFT JOIN project_user_roles r
    ON r.project_id = p.id AND r.role = 'owner' AND r.revoked_at IS NULL
  WHERE p.project_type = 'household'
  GROUP BY p.id
  HAVING COUNT(r.user_id) <> 1
) THEN 1 ELSE 0 END;

INSERT INTO _0009_migration_guard (check_name, ok)
SELECT 'household_has_no_non_owner_roles', CASE WHEN NOT EXISTS (
  SELECT 1
  FROM projects p
  JOIN project_user_roles r ON r.project_id = p.id
  WHERE p.project_type = 'household'
    AND r.role <> 'owner'
    AND r.revoked_at IS NULL
) THEN 1 ELSE 0 END;

INSERT INTO _0009_migration_guard (check_name, ok)
SELECT 'household_has_no_shares', CASE WHEN NOT EXISTS (
  SELECT 1 FROM projects p JOIN project_shares s ON s.project_id = p.id
  WHERE p.project_type = 'household'
) THEN 1 ELSE 0 END;

INSERT INTO _0009_migration_guard (check_name, ok)
SELECT 'household_has_no_legacy_share_token', CASE WHEN NOT EXISTS (
  SELECT 1 FROM projects WHERE project_type = 'household' AND share_token IS NOT NULL
) THEN 1 ELSE 0 END;

INSERT INTO _0009_migration_guard (check_name, ok)
SELECT 'household_owner_is_active', CASE WHEN NOT EXISTS (
  SELECT 1
  FROM projects p
  JOIN project_user_roles r
    ON r.project_id = p.id AND r.role = 'owner' AND r.revoked_at IS NULL
  JOIN users u ON u.id = r.user_id
  WHERE p.project_type = 'household'
    AND (u.deleted_at IS NOT NULL OR u.deletion_started_at IS NOT NULL)
) THEN 1 ELSE 0 END;

INSERT INTO _0009_migration_guard (check_name, ok)
SELECT 'one_household_per_owner', CASE WHEN NOT EXISTS (
  SELECT 1
  FROM projects p
  JOIN project_user_roles r
    ON r.project_id = p.id AND r.role = 'owner' AND r.revoked_at IS NULL
  WHERE p.project_type = 'household'
  GROUP BY r.user_id
  HAVING COUNT(*) > 1
) THEN 1 ELSE 0 END;

INSERT INTO _0009_migration_guard (check_name, ok)
SELECT 'gmail_household_is_unique', CASE WHEN NOT EXISTS (
  SELECT 1
  FROM gmail_connections gc
  WHERE (
    SELECT COUNT(*)
    FROM projects p
    JOIN project_user_roles r
      ON r.project_id = p.id AND r.role = 'owner' AND r.revoked_at IS NULL
    JOIN users u ON u.id = r.user_id
    WHERE p.project_type = 'household'
      AND r.user_id = gc.user_id
      AND u.deleted_at IS NULL
      AND u.deletion_started_at IS NULL
  ) <> 1
) THEN 1 ELSE 0 END;

DROP TRIGGER IF EXISTS trg_household_sync_guard_insert;
DROP INDEX IF EXISTS idx_projects_share_token;
DROP INDEX IF EXISTS idx_project_members_project;
DROP INDEX IF EXISTS idx_transactions_project_date;
DROP INDEX IF EXISTS idx_transactions_project_amount_date;
DROP INDEX IF EXISTS idx_transactions_project_status;
DROP INDEX IF EXISTS idx_transaction_payments_transaction;
DROP INDEX IF EXISTS idx_transaction_items_transaction;
DROP INDEX IF EXISTS idx_item_allocations_item;
DROP INDEX IF EXISTS idx_import_records_project_status;
DROP INDEX IF EXISTS idx_import_records_project_amount_date;
DROP INDEX IF EXISTS idx_import_records_transaction;
DROP INDEX IF EXISTS idx_project_user_roles_user;
DROP INDEX IF EXISTS idx_project_shares_project;
DROP INDEX IF EXISTS idx_gmail_connections_user;
DROP INDEX IF EXISTS idx_gmail_sync_runs_connection;
DROP INDEX IF EXISTS idx_gmail_messages_run;
DROP INDEX IF EXISTS idx_gmail_candidates_user_status;
DROP INDEX IF EXISTS idx_gmail_candidates_amount_date;

ALTER TABLE gmail_import_candidates RENAME TO _0009_gmail_import_candidates_legacy;
ALTER TABLE gmail_messages RENAME TO _0009_gmail_messages_legacy;
ALTER TABLE gmail_sync_runs RENAME TO _0009_gmail_sync_runs_legacy;
ALTER TABLE gmail_connections RENAME TO _0009_gmail_connections_legacy;
ALTER TABLE gmail_oauth_states RENAME TO _0009_gmail_oauth_states_legacy;
ALTER TABLE item_allocations RENAME TO _0009_item_allocations_legacy;
ALTER TABLE transaction_payments RENAME TO _0009_transaction_payments_legacy;
ALTER TABLE transaction_items RENAME TO _0009_transaction_items_legacy;
ALTER TABLE import_records RENAME TO _0009_import_records_legacy;
ALTER TABLE transactions RENAME TO _0009_transactions_legacy;
ALTER TABLE project_members RENAME TO _0009_project_members_legacy;
ALTER TABLE project_user_roles RENAME TO _0009_project_user_roles_legacy;
ALTER TABLE project_shares RENAME TO _0009_project_shares_legacy;
ALTER TABLE projects RENAME TO _0009_projects_legacy;

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  project_type TEXT NOT NULL DEFAULT 'split' CHECK (
  project_type IN ('split', 'household')
    AND (project_type = 'split' OR (owner_user_id IS NOT NULL AND share_token IS NULL))
  ),
  owner_user_id TEXT,
  currency TEXT NOT NULL DEFAULT 'JPY' CHECK (length(currency) = 3),
  share_token TEXT,
  share_role TEXT NOT NULL DEFAULT 'editor' CHECK (share_role IN ('editor', 'viewer')),
  share_expires_at TEXT,
  finalized_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (owner_user_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE project_user_roles (
  project_id TEXT NOT NULL, user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, revoked_at TEXT,
  PRIMARY KEY (project_id, user_id),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE TABLE project_shares (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('editor', 'viewer')), expires_at TEXT,
  revoked_at TEXT, created_by_user_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE SET NULL
);

CREATE TABLE project_members (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) > 0),
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'editor', 'member', 'viewer')),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  linked_household_project_id TEXT, linked_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (linked_household_project_id) REFERENCES projects(id) ON UPDATE CASCADE ON DELETE SET NULL
);

CREATE TABLE transactions (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, merchant_name TEXT NOT NULL,
  merchant_normalized TEXT NOT NULL DEFAULT '', gross_amount INTEGER NOT NULL CHECK (typeof(gross_amount) = 'integer'),
  paid_amount INTEGER NOT NULL CHECK (typeof(paid_amount) = 'integer'), discount_amount INTEGER NOT NULL DEFAULT 0 CHECK (typeof(discount_amount) = 'integer'),
  point_amount INTEGER NOT NULL DEFAULT 0 CHECK (typeof(point_amount) = 'integer'), category TEXT,
  status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('provisional', 'confirmed', 'cancelled', 'refunded', 'corrected')),
  occurred_at TEXT NOT NULL, settled_at TEXT, note TEXT,
  entry_type TEXT NOT NULL DEFAULT 'purchase' CHECK (entry_type IN ('purchase', 'split_expense', 'advance', 'settlement_out', 'settlement_in', 'refund', 'adjustment')),
  origin_project_id TEXT, origin_transaction_id TEXT, origin_member_id TEXT,
  generated_automatically INTEGER NOT NULL DEFAULT 0 CHECK (generated_automatically IN (0, 1)),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (origin_project_id) REFERENCES projects(id) ON UPDATE CASCADE ON DELETE SET NULL,
  FOREIGN KEY (origin_transaction_id) REFERENCES transactions(id) ON UPDATE CASCADE ON DELETE SET NULL,
  FOREIGN KEY (origin_member_id) REFERENCES project_members(id) ON UPDATE CASCADE ON DELETE SET NULL
);

CREATE TABLE transaction_payments (
  id TEXT PRIMARY KEY, transaction_id TEXT NOT NULL, payer_member_id TEXT,
  amount INTEGER NOT NULL CHECK (typeof(amount) = 'integer'),
  payment_method TEXT NOT NULL DEFAULT 'other' CHECK (payment_method IN ('cash', 'credit_card', 'paypay', 'suica', 'pasmo', 'bank', 'point', 'other')),
  provider TEXT, account_label TEXT, external_payment_id TEXT,
  payment_status TEXT NOT NULL DEFAULT 'confirmed' CHECK (payment_status IN ('provisional', 'confirmed', 'cancelled', 'refunded')),
  occurred_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (payer_member_id) REFERENCES project_members(id) ON UPDATE CASCADE ON DELETE SET NULL
);

CREATE TABLE transaction_items (
  id TEXT PRIMARY KEY, transaction_id TEXT NOT NULL, name TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (typeof(amount) = 'integer'), quantity REAL NOT NULL DEFAULT 1 CHECK (typeof(quantity) IN ('integer', 'real') AND quantity > 0),
  item_type TEXT NOT NULL DEFAULT 'product' CHECK (item_type IN ('product', 'summary', 'adjustment')),
  category TEXT, sort_order INTEGER NOT NULL DEFAULT 0 CHECK (typeof(sort_order) = 'integer' AND sort_order >= 0),
  is_hidden INTEGER NOT NULL DEFAULT 0 CHECK (is_hidden IN (0, 1)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE TABLE item_allocations (
  id TEXT PRIMARY KEY, transaction_item_id TEXT NOT NULL, project_member_id TEXT NOT NULL,
  allocated_amount INTEGER NOT NULL CHECK (typeof(allocated_amount) = 'integer'), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (transaction_item_id, project_member_id),
  FOREIGN KEY (transaction_item_id) REFERENCES transaction_items(id) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (project_member_id) REFERENCES project_members(id) ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE import_records (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, transaction_id TEXT,
  source_type TEXT NOT NULL CHECK (source_type IN ('receipt', 'gmail_notification', 'card_csv', 'paypay_csv', 'bank_csv', 'manual')),
  source_record_id TEXT, source_status TEXT NOT NULL DEFAULT 'received' CHECK (source_status IN ('received', 'parsed', 'linked', 'review', 'rejected', 'error')),
  merchant_raw TEXT, merchant_normalized TEXT, gross_amount_raw INTEGER CHECK (gross_amount_raw IS NULL OR typeof(gross_amount_raw) = 'integer'),
  paid_amount_raw INTEGER CHECK (paid_amount_raw IS NULL OR typeof(paid_amount_raw) = 'integer'), occurred_at_raw TEXT, settled_at_raw TEXT,
  payment_method_raw TEXT, external_transaction_id TEXT, image_url TEXT, raw_text TEXT, raw_payload TEXT,
  parse_confidence REAL CHECK (parse_confidence IS NULL OR (typeof(parse_confidence) IN ('integer', 'real') AND parse_confidence BETWEEN 0 AND 1)),
  parser_version TEXT, match_score INTEGER CHECK (match_score IS NULL OR typeof(match_score) = 'integer'), match_reason_json TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON UPDATE CASCADE ON DELETE SET NULL
);

CREATE TABLE gmail_connections (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, household_project_id TEXT NOT NULL, gmail_email TEXT NOT NULL,
  refresh_token_ciphertext TEXT NOT NULL, refresh_token_iv TEXT NOT NULL, key_generation INTEGER NOT NULL CHECK (key_generation > 0),
  aad_version INTEGER NOT NULL DEFAULT 1 CHECK (aad_version = 1),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'reauthorization_required', 'disconnecting', 'disconnected')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_synced_at TEXT,
  UNIQUE (user_id, gmail_email),
  FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (household_project_id) REFERENCES projects(id) ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE gmail_oauth_states (
  state_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, project_id TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE TABLE gmail_sync_runs (
  id TEXT PRIMARY KEY, connection_id TEXT NOT NULL, user_id TEXT NOT NULL,
  days INTEGER NOT NULL CHECK (days IN (7, 30, 90)), message_limit INTEGER NOT NULL CHECK (message_limit BETWEEN 1 AND 500),
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'partial', 'rate_limited', 'reauthorization_required', 'failed')),
  listed_count INTEGER NOT NULL DEFAULT 0, processed_count INTEGER NOT NULL DEFAULT 0, candidate_count INTEGER NOT NULL DEFAULT 0,
  duplicate_count INTEGER NOT NULL DEFAULT 0, error_count INTEGER NOT NULL DEFAULT 0, error_code TEXT, started_at TEXT NOT NULL, finished_at TEXT,
  FOREIGN KEY (connection_id) REFERENCES gmail_connections(id) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE TABLE gmail_messages (
  id TEXT PRIMARY KEY, connection_id TEXT NOT NULL, gmail_message_id TEXT NOT NULL, sync_run_id TEXT NOT NULL,
  parse_status TEXT NOT NULL CHECK (parse_status IN ('parsed', 'needs_review', 'parse_error')), provider TEXT, received_at TEXT, created_at TEXT NOT NULL,
  UNIQUE (connection_id, gmail_message_id),
  FOREIGN KEY (connection_id) REFERENCES gmail_connections(id) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (sync_run_id) REFERENCES gmail_sync_runs(id) ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE TABLE gmail_import_candidates (
  id TEXT PRIMARY KEY, connection_id TEXT NOT NULL, gmail_message_row_id TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'needs_review' CHECK (status IN ('needs_review', 'ready', 'ignored', 'imported', 'parse_error')),
  provider TEXT, merchant_name TEXT, amount INTEGER CHECK (amount IS NULL OR typeof(amount) = 'integer'), occurred_at TEXT, payment_method TEXT,
  external_transaction_id TEXT, duplicate_warning INTEGER NOT NULL DEFAULT 0 CHECK (duplicate_warning IN (0, 1)), imported_project_id TEXT, import_record_id TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  FOREIGN KEY (connection_id) REFERENCES gmail_connections(id) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (gmail_message_row_id) REFERENCES gmail_messages(id) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (imported_project_id) REFERENCES projects(id) ON UPDATE CASCADE ON DELETE SET NULL,
  FOREIGN KEY (import_record_id) REFERENCES import_records(id) ON UPDATE CASCADE ON DELETE SET NULL
);

INSERT INTO projects SELECT id, name, project_type,
  CASE WHEN project_type = 'household' THEN (SELECT user_id FROM _0009_project_user_roles_legacy r WHERE r.project_id = p.id AND r.role = 'owner' AND r.revoked_at IS NULL) ELSE NULL END,
  currency, share_token, share_role, share_expires_at, finalized_at, created_at, updated_at
FROM _0009_projects_legacy p;

INSERT INTO project_user_roles SELECT * FROM _0009_project_user_roles_legacy;
INSERT INTO project_shares SELECT * FROM _0009_project_shares_legacy;
INSERT INTO project_members SELECT * FROM _0009_project_members_legacy;
INSERT INTO transactions SELECT * FROM _0009_transactions_legacy;
INSERT INTO transaction_payments SELECT * FROM _0009_transaction_payments_legacy;
INSERT INTO transaction_items SELECT * FROM _0009_transaction_items_legacy;
INSERT INTO item_allocations SELECT * FROM _0009_item_allocations_legacy;
INSERT INTO import_records SELECT * FROM _0009_import_records_legacy;
INSERT INTO gmail_connections (
  id, user_id, household_project_id, gmail_email, refresh_token_ciphertext, refresh_token_iv,
  key_generation, aad_version, status, created_at, updated_at, last_synced_at
)
SELECT g.id, g.user_id, p.id, g.gmail_email, g.refresh_token_ciphertext, g.refresh_token_iv,
  g.key_generation, g.aad_version, g.status, g.created_at, g.updated_at, g.last_synced_at
FROM _0009_gmail_connections_legacy g
JOIN projects p ON p.project_type = 'household' AND p.owner_user_id = g.user_id;
INSERT INTO gmail_oauth_states SELECT * FROM _0009_gmail_oauth_states_legacy;
INSERT INTO gmail_sync_runs SELECT * FROM _0009_gmail_sync_runs_legacy;
INSERT INTO gmail_messages SELECT * FROM _0009_gmail_messages_legacy;
INSERT INTO gmail_import_candidates SELECT * FROM _0009_gmail_import_candidates_legacy;

UPDATE project_user_roles
SET revoked_at = COALESCE(revoked_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE project_id IN (SELECT id FROM projects WHERE project_type = 'household')
  AND role = 'owner' AND revoked_at IS NULL;

DROP TABLE _0009_gmail_import_candidates_legacy;
DROP TABLE _0009_gmail_messages_legacy;
DROP TABLE _0009_gmail_sync_runs_legacy;
DROP TABLE _0009_gmail_connections_legacy;
DROP TABLE _0009_gmail_oauth_states_legacy;
DROP TABLE _0009_item_allocations_legacy;
DROP TABLE _0009_transaction_payments_legacy;
DROP TABLE _0009_transaction_items_legacy;
DROP TABLE _0009_import_records_legacy;
DROP TABLE _0009_transactions_legacy;
DROP TABLE _0009_project_members_legacy;
DROP TABLE _0009_project_user_roles_legacy;
DROP TABLE _0009_project_shares_legacy;
DROP TABLE _0009_projects_legacy;

CREATE UNIQUE INDEX idx_projects_share_token ON projects(share_token) WHERE share_token IS NOT NULL;
CREATE UNIQUE INDEX idx_projects_household_owner ON projects(owner_user_id) WHERE project_type = 'household' AND owner_user_id IS NOT NULL;
CREATE UNIQUE INDEX idx_transaction_payments_external_payment ON transaction_payments(external_payment_id) WHERE external_payment_id IS NOT NULL;
CREATE UNIQUE INDEX idx_import_records_source_record ON import_records(project_id, source_type, source_record_id) WHERE source_record_id IS NOT NULL;
CREATE UNIQUE INDEX idx_generated_household_transaction ON transactions(project_id, origin_project_id, origin_transaction_id, origin_member_id, entry_type) WHERE generated_automatically = 1;
CREATE INDEX idx_project_members_project ON project_members(project_id, is_active);
CREATE INDEX idx_transactions_project_date ON transactions(project_id, occurred_at DESC);
CREATE INDEX idx_transactions_project_amount_date ON transactions(project_id, paid_amount, occurred_at);
CREATE INDEX idx_transactions_project_status ON transactions(project_id, status, occurred_at DESC);
CREATE INDEX idx_transaction_payments_transaction ON transaction_payments(transaction_id);
CREATE INDEX idx_transaction_items_transaction ON transaction_items(transaction_id, sort_order);
CREATE INDEX idx_item_allocations_item ON item_allocations(transaction_item_id);
CREATE INDEX idx_import_records_project_status ON import_records(project_id, source_status, created_at DESC);
CREATE INDEX idx_import_records_project_amount_date ON import_records(project_id, paid_amount_raw, occurred_at_raw);
CREATE INDEX idx_import_records_transaction ON import_records(transaction_id);
CREATE INDEX idx_project_user_roles_user ON project_user_roles(user_id, role) WHERE revoked_at IS NULL;
CREATE INDEX idx_project_shares_project ON project_shares(project_id, revoked_at);
CREATE INDEX idx_gmail_connections_user ON gmail_connections(user_id, status);
CREATE INDEX idx_gmail_oauth_states_expiry ON gmail_oauth_states(expires_at);
CREATE INDEX idx_gmail_sync_runs_connection ON gmail_sync_runs(connection_id, started_at DESC);
CREATE INDEX idx_gmail_messages_run ON gmail_messages(sync_run_id);
CREATE INDEX idx_gmail_candidates_user_status ON gmail_import_candidates(user_id, status, created_at DESC);
CREATE INDEX idx_gmail_candidates_amount_date ON gmail_import_candidates(user_id, amount, occurred_at);

CREATE TRIGGER trg_household_sync_guard_insert
BEFORE INSERT ON household_sync_guards
WHEN NOT EXISTS (
  SELECT 1 FROM project_user_roles JOIN users ON users.id = project_user_roles.user_id
  WHERE project_user_roles.project_id = NEW.project_id AND project_user_roles.user_id = NEW.user_id
    AND project_user_roles.role IN ('owner', 'editor') AND project_user_roles.revoked_at IS NULL
    AND users.deleted_at IS NULL AND users.deletion_started_at IS NULL
)
BEGIN SELECT RAISE(ABORT, 'household_sync_access_denied'); END;

CREATE TRIGGER trg_projects_household_owner_guard
BEFORE INSERT ON projects
WHEN NEW.project_type = 'household' AND NOT EXISTS (
  SELECT 1 FROM users WHERE id = NEW.owner_user_id AND deleted_at IS NULL AND deletion_started_at IS NULL
)
BEGIN SELECT RAISE(ABORT, 'household_owner_invalid'); END;

CREATE TRIGGER trg_projects_household_update_guard
BEFORE UPDATE OF project_type, owner_user_id ON projects
WHEN NEW.project_type = 'household' AND NOT EXISTS (
  SELECT 1 FROM users WHERE id = NEW.owner_user_id AND deleted_at IS NULL AND deletion_started_at IS NULL
)
BEGIN SELECT RAISE(ABORT, 'household_owner_invalid'); END;

CREATE TRIGGER trg_projects_household_sharing_guard
BEFORE UPDATE OF project_type, owner_user_id, share_token, share_role, share_expires_at ON projects
WHEN NEW.project_type = 'household' AND (
  NEW.share_token IS NOT NULL
  OR EXISTS (SELECT 1 FROM project_user_roles WHERE project_id = NEW.id)
  OR EXISTS (SELECT 1 FROM project_shares WHERE project_id = NEW.id)
)
BEGIN SELECT RAISE(ABORT, 'household_sharing_forbidden'); END;

CREATE TRIGGER trg_project_user_roles_household_insert
BEFORE INSERT ON project_user_roles
WHEN EXISTS (SELECT 1 FROM projects WHERE id = NEW.project_id AND project_type = 'household')
BEGIN SELECT RAISE(ABORT, 'household_roles_forbidden'); END;

CREATE TRIGGER trg_project_user_roles_household_update
BEFORE UPDATE ON project_user_roles
WHEN EXISTS (SELECT 1 FROM projects WHERE id = NEW.project_id AND project_type = 'household')
BEGIN SELECT RAISE(ABORT, 'household_roles_forbidden'); END;

CREATE TRIGGER trg_project_shares_household_insert
BEFORE INSERT ON project_shares
WHEN EXISTS (SELECT 1 FROM projects WHERE id = NEW.project_id AND project_type = 'household')
BEGIN SELECT RAISE(ABORT, 'household_shares_forbidden'); END;

CREATE TRIGGER trg_project_shares_household_update
BEFORE UPDATE ON project_shares
WHEN EXISTS (SELECT 1 FROM projects WHERE id = NEW.project_id AND project_type = 'household')
BEGIN SELECT RAISE(ABORT, 'household_shares_forbidden'); END;

CREATE TRIGGER trg_gmail_connections_household_guard
BEFORE INSERT ON gmail_connections
WHEN NOT EXISTS (
  SELECT 1 FROM projects p JOIN users u ON u.id = p.owner_user_id
  WHERE p.id = NEW.household_project_id AND p.project_type = 'household'
    AND p.owner_user_id = NEW.user_id AND u.deleted_at IS NULL AND u.deletion_started_at IS NULL
)
BEGIN SELECT RAISE(ABORT, 'gmail_household_owner_mismatch'); END;

CREATE TRIGGER trg_gmail_connections_household_update_guard
BEFORE UPDATE OF user_id, household_project_id ON gmail_connections
WHEN NOT EXISTS (
  SELECT 1 FROM projects p JOIN users u ON u.id = p.owner_user_id
  WHERE p.id = NEW.household_project_id AND p.project_type = 'household'
    AND p.owner_user_id = NEW.user_id AND u.deleted_at IS NULL AND u.deletion_started_at IS NULL
)
BEGIN SELECT RAISE(ABORT, 'gmail_household_owner_mismatch'); END;

DROP TABLE _0009_migration_guard;
