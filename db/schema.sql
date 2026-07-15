PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
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

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  google_sub TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  deletion_started_at TEXT
);

CREATE TABLE IF NOT EXISTS receipt_ocr_correction_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  transaction_id TEXT,
  ocr_result_id TEXT NOT NULL CHECK (length(ocr_result_id) BETWEEN 8 AND 128),
  field_name TEXT NOT NULL CHECK (field_name IN ('store_name', 'total_amount', 'paid_at', 'paid_time', 'item_name', 'item_amount')),
  source_id TEXT NOT NULL CHECK (length(source_id) BETWEEN 1 AND 64),
  original_value TEXT NOT NULL CHECK (length(original_value) BETWEEN 0 AND 200),
  corrected_value TEXT NOT NULL CHECK (length(corrected_value) BETWEEN 1 AND 200),
  normalized_original_value TEXT NOT NULL CHECK (length(normalized_original_value) BETWEEN 0 AND 200),
  normalized_corrected_value TEXT NOT NULL CHECK (length(normalized_corrected_value) BETWEEN 1 AND 200),
  ocr_model TEXT NOT NULL CHECK (length(ocr_model) BETWEEN 1 AND 100),
  preprocessing TEXT NOT NULL CHECK (length(preprocessing) BETWEEN 1 AND 100),
  confidence REAL NOT NULL CHECK (typeof(confidence) IN ('integer', 'real') AND confidence BETWEEN 0 AND 1),
  bounding_box_json TEXT CHECK (bounding_box_json IS NULL OR (json_valid(bounding_box_json) AND json_type(bounding_box_json) = 'array' AND json_array_length(bounding_box_json) = 4)),
  source_text TEXT CHECK (source_text IS NULL OR length(source_text) <= 500),
  correction_source TEXT NOT NULL DEFAULT 'user_confirmed' CHECK (correction_source = 'user_confirmed'),
  created_at TEXT NOT NULL,
  UNIQUE (user_id, ocr_result_id, field_name, source_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON UPDATE CASCADE ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_receipt_ocr_corrections_user_created
ON receipt_ocr_correction_events(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_receipt_ocr_corrections_lookup
ON receipt_ocr_correction_events(user_id, field_name, normalized_original_value, normalized_corrected_value);

CREATE TABLE IF NOT EXISTS receipt_ocr_field_outcomes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  transaction_id TEXT,
  ocr_result_id TEXT NOT NULL CHECK (length(ocr_result_id) BETWEEN 8 AND 128),
  field_name TEXT NOT NULL CHECK (field_name IN ('store_name', 'total_amount', 'paid_at', 'paid_time', 'item_name', 'item_amount')),
  source_id TEXT NOT NULL CHECK (length(source_id) BETWEEN 1 AND 64),
  ocr_model TEXT NOT NULL CHECK (length(ocr_model) BETWEEN 1 AND 100),
  preprocessing TEXT NOT NULL CHECK (length(preprocessing) BETWEEN 1 AND 100),
  confidence REAL NOT NULL CHECK (typeof(confidence) IN ('integer', 'real') AND confidence BETWEEN 0 AND 1),
  was_corrected INTEGER NOT NULL CHECK (was_corrected IN (0, 1)),
  created_at TEXT NOT NULL,
  UNIQUE (user_id, ocr_result_id, field_name, source_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON UPDATE CASCADE ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_receipt_ocr_outcomes_stats
ON receipt_ocr_field_outcomes(user_id, field_name, ocr_model, preprocessing, was_corrected);

CREATE TABLE IF NOT EXISTS receipt_ocr_feedback_pending (
  import_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  transaction_id TEXT NOT NULL,
  ocr_result_id TEXT NOT NULL CHECK (length(ocr_result_id) BETWEEN 8 AND 128),
  claims_json TEXT NOT NULL CHECK (json_valid(claims_json) AND json_type(claims_json) = 'object'),
  confirmed_json TEXT NOT NULL CHECK (json_valid(confirmed_json) AND json_type(confirmed_json) = 'object'),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (import_id) REFERENCES import_records(id) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_receipt_ocr_feedback_pending_user
ON receipt_ocr_feedback_pending(user_id, created_at);

CREATE TRIGGER IF NOT EXISTS trg_receipt_ocr_correction_active_user
BEFORE INSERT ON receipt_ocr_correction_events
WHEN NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id AND deleted_at IS NULL AND deletion_started_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'ocr_correction_user_inactive');
END;

CREATE TRIGGER IF NOT EXISTS trg_receipt_ocr_outcome_active_user
BEFORE INSERT ON receipt_ocr_field_outcomes
WHEN NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id AND deleted_at IS NULL AND deletion_started_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'ocr_correction_user_inactive');
END;

CREATE TRIGGER IF NOT EXISTS trg_receipt_ocr_feedback_pending_active_user
BEFORE INSERT ON receipt_ocr_feedback_pending
WHEN NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id AND deleted_at IS NULL AND deletion_started_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'ocr_feedback_pending_user_inactive');
END;

CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  csrf_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS oauth_states (
  state_hash TEXT PRIMARY KEY,
  code_verifier_hash TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE IF NOT EXISTS project_user_roles (
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT,
  PRIMARY KEY (project_id, user_id),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS project_shares (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('editor', 'viewer')),
  expires_at TEXT,
  revoked_at TEXT,
  created_by_user_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS project_members (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) > 0),
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'editor', 'member', 'viewer')),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  linked_household_project_id TEXT,
  linked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (linked_household_project_id) REFERENCES projects(id) ON UPDATE CASCADE ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  merchant_name TEXT NOT NULL,
  merchant_normalized TEXT NOT NULL DEFAULT '',
  gross_amount INTEGER NOT NULL CHECK (typeof(gross_amount) = 'integer'),
  paid_amount INTEGER NOT NULL CHECK (typeof(paid_amount) = 'integer'),
  discount_amount INTEGER NOT NULL DEFAULT 0 CHECK (typeof(discount_amount) = 'integer'),
  point_amount INTEGER NOT NULL DEFAULT 0 CHECK (typeof(point_amount) = 'integer'),
  category TEXT,
  status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('provisional', 'confirmed', 'cancelled', 'refunded', 'corrected')),
  occurred_at TEXT NOT NULL,
  settled_at TEXT,
  note TEXT,
  entry_type TEXT NOT NULL DEFAULT 'purchase' CHECK (entry_type IN ('purchase', 'split_expense', 'advance', 'settlement_out', 'settlement_in', 'refund', 'adjustment')),
  origin_project_id TEXT,
  origin_transaction_id TEXT,
  origin_member_id TEXT,
  generated_automatically INTEGER NOT NULL DEFAULT 0 CHECK (generated_automatically IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (origin_project_id) REFERENCES projects(id) ON UPDATE CASCADE ON DELETE SET NULL,
  FOREIGN KEY (origin_transaction_id) REFERENCES transactions(id) ON UPDATE CASCADE ON DELETE SET NULL,
  FOREIGN KEY (origin_member_id) REFERENCES project_members(id) ON UPDATE CASCADE ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS transaction_payments (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL,
  payer_member_id TEXT,
  amount INTEGER NOT NULL CHECK (typeof(amount) = 'integer'),
  payment_method TEXT NOT NULL DEFAULT 'other' CHECK (payment_method IN ('cash', 'credit_card', 'paypay', 'suica', 'pasmo', 'bank', 'point', 'other')),
  provider TEXT,
  account_label TEXT,
  external_payment_id TEXT,
  payment_status TEXT NOT NULL DEFAULT 'confirmed' CHECK (payment_status IN ('provisional', 'confirmed', 'cancelled', 'refunded')),
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (payer_member_id) REFERENCES project_members(id) ON UPDATE CASCADE ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS transaction_items (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL,
  name TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (typeof(amount) = 'integer'),
  quantity REAL NOT NULL DEFAULT 1 CHECK (typeof(quantity) IN ('integer', 'real') AND quantity > 0),
  item_type TEXT NOT NULL DEFAULT 'product' CHECK (item_type IN ('product', 'summary', 'adjustment')),
  category TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0 CHECK (typeof(sort_order) = 'integer' AND sort_order >= 0),
  is_hidden INTEGER NOT NULL DEFAULT 0 CHECK (is_hidden IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS item_allocations (
  id TEXT PRIMARY KEY,
  transaction_item_id TEXT NOT NULL,
  project_member_id TEXT NOT NULL,
  allocated_amount INTEGER NOT NULL CHECK (typeof(allocated_amount) = 'integer'),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (transaction_item_id, project_member_id),
  FOREIGN KEY (transaction_item_id) REFERENCES transaction_items(id) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (project_member_id) REFERENCES project_members(id) ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS import_records (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  transaction_id TEXT,
  source_type TEXT NOT NULL CHECK (source_type IN ('receipt', 'gmail_notification', 'card_csv', 'paypay_csv', 'bank_csv', 'manual')),
  source_record_id TEXT,
  source_status TEXT NOT NULL DEFAULT 'received' CHECK (source_status IN ('received', 'parsed', 'linked', 'review', 'rejected', 'error')),
  merchant_raw TEXT,
  merchant_normalized TEXT,
  gross_amount_raw INTEGER CHECK (gross_amount_raw IS NULL OR typeof(gross_amount_raw) = 'integer'),
  paid_amount_raw INTEGER CHECK (paid_amount_raw IS NULL OR typeof(paid_amount_raw) = 'integer'),
  occurred_at_raw TEXT,
  settled_at_raw TEXT,
  payment_method_raw TEXT,
  external_transaction_id TEXT,
  image_url TEXT,
  raw_text TEXT,
  raw_payload TEXT,
  parse_confidence REAL CHECK (parse_confidence IS NULL OR (typeof(parse_confidence) IN ('integer', 'real') AND parse_confidence BETWEEN 0 AND 1)),
  parser_version TEXT,
  match_score INTEGER CHECK (match_score IS NULL OR typeof(match_score) = 'integer'),
  match_reason_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON UPDATE CASCADE ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_share_token
ON projects(share_token)
WHERE share_token IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_household_owner
ON projects(owner_user_id)
WHERE project_type = 'household' AND owner_user_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_transaction_payments_external_payment
ON transaction_payments(external_payment_id)
WHERE external_payment_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_import_records_source_record
ON import_records(project_id, source_type, source_record_id)
WHERE source_record_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_generated_household_transaction
ON transactions(project_id, origin_project_id, origin_transaction_id, origin_member_id, entry_type)
WHERE generated_automatically = 1;

CREATE INDEX IF NOT EXISTS idx_project_members_project
ON project_members(project_id, is_active);

CREATE INDEX IF NOT EXISTS idx_transactions_project_date
ON transactions(project_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_transactions_project_amount_date
ON transactions(project_id, paid_amount, occurred_at);

CREATE INDEX IF NOT EXISTS idx_transactions_project_status
ON transactions(project_id, status, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_transaction_payments_transaction
ON transaction_payments(transaction_id);

CREATE INDEX IF NOT EXISTS idx_transaction_items_transaction
ON transaction_items(transaction_id, sort_order);

CREATE INDEX IF NOT EXISTS idx_item_allocations_item
ON item_allocations(transaction_item_id);

CREATE INDEX IF NOT EXISTS idx_import_records_project_status
ON import_records(project_id, source_status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_import_records_project_amount_date
ON import_records(project_id, paid_amount_raw, occurred_at_raw);

CREATE INDEX IF NOT EXISTS idx_import_records_transaction
ON import_records(transaction_id);

CREATE INDEX IF NOT EXISTS idx_sessions_user
ON sessions(user_id, expires_at);

CREATE INDEX IF NOT EXISTS idx_oauth_states_expiry
ON oauth_states(expires_at);

CREATE INDEX IF NOT EXISTS idx_project_user_roles_user
ON project_user_roles(user_id, role)
WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_project_shares_project
ON project_shares(project_id, revoked_at);

CREATE TABLE IF NOT EXISTS household_sync_guards (
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  PRIMARY KEY (project_id, user_id)
);

CREATE TRIGGER IF NOT EXISTS trg_household_sync_guard_insert
BEFORE INSERT ON household_sync_guards
WHEN NOT EXISTS (
  SELECT 1
  FROM projects
  JOIN users ON users.id = projects.owner_user_id
  WHERE projects.id = NEW.project_id
    AND projects.project_type = 'household'
    AND projects.owner_user_id = NEW.user_id
    AND users.deleted_at IS NULL
    AND users.deletion_started_at IS NULL
  UNION ALL
  SELECT 1
  FROM project_user_roles
  JOIN users ON users.id = project_user_roles.user_id
  JOIN projects ON projects.id = project_user_roles.project_id
  WHERE project_user_roles.project_id = NEW.project_id
    AND project_user_roles.user_id = NEW.user_id
    AND projects.project_type = 'split'
    AND project_user_roles.role IN ('owner', 'editor')
    AND project_user_roles.revoked_at IS NULL
    AND users.deleted_at IS NULL
    AND users.deletion_started_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'household_sync_access_denied');
END;

CREATE TABLE IF NOT EXISTS household_sync_jobs (
  id TEXT PRIMARY KEY,
  source_project_id TEXT NOT NULL,
  source_transaction_id TEXT NOT NULL DEFAULT '',
  requested_by_user_id TEXT NOT NULL,
  sync_scope TEXT NOT NULL CHECK (sync_scope IN ('project', 'transaction', 'cancel_project')),
  reason TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 1 CHECK (attempt_count >= 1),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'blocked', 'rejected')),
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_attempted_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (source_project_id, source_transaction_id, sync_scope)
);

CREATE INDEX IF NOT EXISTS idx_household_sync_jobs_status
ON household_sync_jobs(status, updated_at);

CREATE INDEX IF NOT EXISTS idx_household_sync_jobs_source
ON household_sync_jobs(source_project_id, source_transaction_id);

CREATE TABLE IF NOT EXISTS gmail_connections (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, household_project_id TEXT NOT NULL, gmail_email TEXT NOT NULL,
  refresh_token_ciphertext TEXT NOT NULL, refresh_token_iv TEXT NOT NULL,
  key_generation INTEGER NOT NULL CHECK (key_generation > 0), aad_version INTEGER NOT NULL DEFAULT 1 CHECK (aad_version = 1),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'reauthorization_required', 'disconnecting', 'disconnected')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_synced_at TEXT,
  UNIQUE (user_id, gmail_email),
  FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (household_project_id) REFERENCES projects(id) ON UPDATE CASCADE ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS gmail_oauth_states (
  state_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, project_id TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON UPDATE CASCADE ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS gmail_sync_runs (
  id TEXT PRIMARY KEY, connection_id TEXT NOT NULL, user_id TEXT NOT NULL,
  days INTEGER NOT NULL CHECK (days IN (7, 30, 90)), message_limit INTEGER NOT NULL CHECK (message_limit BETWEEN 1 AND 500),
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'partial', 'rate_limited', 'reauthorization_required', 'failed')),
  listed_count INTEGER NOT NULL DEFAULT 0, processed_count INTEGER NOT NULL DEFAULT 0, candidate_count INTEGER NOT NULL DEFAULT 0,
  duplicate_count INTEGER NOT NULL DEFAULT 0, error_count INTEGER NOT NULL DEFAULT 0, error_code TEXT, started_at TEXT NOT NULL, finished_at TEXT,
  FOREIGN KEY (connection_id) REFERENCES gmail_connections(id) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS gmail_messages (
  id TEXT PRIMARY KEY, connection_id TEXT NOT NULL, gmail_message_id TEXT NOT NULL, sync_run_id TEXT NOT NULL,
  parse_status TEXT NOT NULL CHECK (parse_status IN ('parsed', 'needs_review', 'parse_error')), provider TEXT, received_at TEXT, created_at TEXT NOT NULL,
  UNIQUE (connection_id, gmail_message_id),
  FOREIGN KEY (connection_id) REFERENCES gmail_connections(id) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (sync_run_id) REFERENCES gmail_sync_runs(id) ON UPDATE CASCADE ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS gmail_import_candidates (
  id TEXT PRIMARY KEY, connection_id TEXT NOT NULL, gmail_message_row_id TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'needs_review' CHECK (status IN ('needs_review', 'ready', 'ignored', 'imported', 'parse_error')),
  provider TEXT, merchant_name TEXT, amount INTEGER CHECK (amount IS NULL OR typeof(amount) = 'integer'), occurred_at TEXT,
  payment_method TEXT, external_transaction_id TEXT, duplicate_warning INTEGER NOT NULL DEFAULT 0 CHECK (duplicate_warning IN (0, 1)),
  imported_project_id TEXT, import_record_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  FOREIGN KEY (connection_id) REFERENCES gmail_connections(id) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (gmail_message_row_id) REFERENCES gmail_messages(id) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (imported_project_id) REFERENCES projects(id) ON UPDATE CASCADE ON DELETE SET NULL,
  FOREIGN KEY (import_record_id) REFERENCES import_records(id) ON UPDATE CASCADE ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_gmail_connections_user ON gmail_connections(user_id, status);
CREATE INDEX IF NOT EXISTS idx_gmail_oauth_states_expiry ON gmail_oauth_states(expires_at);
CREATE INDEX IF NOT EXISTS idx_gmail_sync_runs_connection ON gmail_sync_runs(connection_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_gmail_messages_run ON gmail_messages(sync_run_id);
CREATE INDEX IF NOT EXISTS idx_gmail_candidates_user_status ON gmail_import_candidates(user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_gmail_candidates_amount_date ON gmail_import_candidates(user_id, amount, occurred_at);
CREATE TABLE IF NOT EXISTS gmail_revocation_retries (
  id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('oauth_storage_rejected')),
  token_ciphertext TEXT NOT NULL, token_iv TEXT NOT NULL,
  key_generation INTEGER NOT NULL CHECK (key_generation > 0), aad_version INTEGER NOT NULL DEFAULT 1 CHECK (aad_version = 1),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed')),
  attempt_count INTEGER NOT NULL DEFAULT 1 CHECK (attempt_count >= 1), last_error_code TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_attempted_at TEXT NOT NULL, completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_gmail_revocation_retries_status ON gmail_revocation_retries(status, updated_at);

CREATE TRIGGER IF NOT EXISTS trg_projects_household_owner_guard
BEFORE INSERT ON projects
WHEN NEW.project_type = 'household'
 AND NOT EXISTS (
  SELECT 1 FROM users
  WHERE id = NEW.owner_user_id
    AND deleted_at IS NULL
    AND deletion_started_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'household_owner_invalid');
END;

CREATE TRIGGER IF NOT EXISTS trg_projects_household_update_guard
BEFORE UPDATE OF project_type, owner_user_id ON projects
WHEN NEW.project_type = 'household'
 AND NOT EXISTS (
  SELECT 1 FROM users
  WHERE id = NEW.owner_user_id
    AND deleted_at IS NULL
    AND deletion_started_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'household_owner_invalid');
END;

CREATE TRIGGER IF NOT EXISTS trg_projects_household_sharing_guard
BEFORE UPDATE OF project_type, owner_user_id, share_token, share_role, share_expires_at ON projects
WHEN NEW.project_type = 'household' AND (
  NEW.share_token IS NOT NULL
  OR EXISTS (SELECT 1 FROM project_user_roles WHERE project_id = NEW.id)
  OR EXISTS (SELECT 1 FROM project_shares WHERE project_id = NEW.id)
)
BEGIN
  SELECT RAISE(ABORT, 'household_sharing_forbidden');
END;

CREATE TRIGGER IF NOT EXISTS trg_project_user_roles_household_insert
BEFORE INSERT ON project_user_roles
WHEN EXISTS (SELECT 1 FROM projects WHERE id = NEW.project_id AND project_type = 'household')
BEGIN
  SELECT RAISE(ABORT, 'household_roles_forbidden');
END;

CREATE TRIGGER IF NOT EXISTS trg_project_user_roles_household_update
BEFORE UPDATE ON project_user_roles
WHEN EXISTS (SELECT 1 FROM projects WHERE id = NEW.project_id AND project_type = 'household')
BEGIN
  SELECT RAISE(ABORT, 'household_roles_forbidden');
END;

CREATE TRIGGER IF NOT EXISTS trg_project_shares_household_insert
BEFORE INSERT ON project_shares
WHEN EXISTS (SELECT 1 FROM projects WHERE id = NEW.project_id AND project_type = 'household')
BEGIN
  SELECT RAISE(ABORT, 'household_shares_forbidden');
END;

CREATE TRIGGER IF NOT EXISTS trg_project_shares_household_update
BEFORE UPDATE ON project_shares
WHEN EXISTS (SELECT 1 FROM projects WHERE id = NEW.project_id AND project_type = 'household')
BEGIN
  SELECT RAISE(ABORT, 'household_shares_forbidden');
END;

CREATE TRIGGER IF NOT EXISTS trg_gmail_connections_household_guard
BEFORE INSERT ON gmail_connections
WHEN NOT EXISTS (
  SELECT 1
  FROM projects p
  JOIN users u ON u.id = p.owner_user_id
  WHERE p.id = NEW.household_project_id
    AND p.project_type = 'household'
    AND p.owner_user_id = NEW.user_id
    AND u.deleted_at IS NULL
    AND u.deletion_started_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'gmail_household_owner_mismatch');
END;

CREATE TRIGGER IF NOT EXISTS trg_gmail_connections_household_update_guard
BEFORE UPDATE OF user_id, household_project_id ON gmail_connections
WHEN NOT EXISTS (
  SELECT 1
  FROM projects p
  JOIN users u ON u.id = p.owner_user_id
  WHERE p.id = NEW.household_project_id
    AND p.project_type = 'household'
    AND p.owner_user_id = NEW.user_id
    AND u.deleted_at IS NULL
    AND u.deletion_started_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'gmail_household_owner_mismatch');
END;
