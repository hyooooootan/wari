PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  project_type TEXT NOT NULL DEFAULT 'split' CHECK (project_type IN ('split', 'household', 'shared_household')),
  currency TEXT NOT NULL DEFAULT 'JPY' CHECK (length(currency) = 3),
  share_token TEXT,
  share_role TEXT NOT NULL DEFAULT 'editor' CHECK (share_role IN ('editor', 'viewer')),
  share_expires_at TEXT,
  finalized_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  google_sub TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

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

CREATE TABLE IF NOT EXISTS gmail_connections (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, gmail_email TEXT NOT NULL,
  refresh_token_ciphertext TEXT NOT NULL, refresh_token_iv TEXT NOT NULL,
  key_generation INTEGER NOT NULL CHECK (key_generation > 0), aad_version INTEGER NOT NULL DEFAULT 1 CHECK (aad_version = 1),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'reauthorization_required', 'disconnected')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_synced_at TEXT,
  UNIQUE (user_id, gmail_email), FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE
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
