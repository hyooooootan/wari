CREATE TABLE IF NOT EXISTS gmail_connections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  gmail_email TEXT NOT NULL,
  refresh_token_ciphertext TEXT NOT NULL,
  refresh_token_iv TEXT NOT NULL,
  key_generation INTEGER NOT NULL CHECK (key_generation > 0),
  aad_version INTEGER NOT NULL DEFAULT 1 CHECK (aad_version = 1),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'reauthorization_required', 'disconnected')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_synced_at TEXT,
  UNIQUE (user_id, gmail_email),
  FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS gmail_oauth_states (
  state_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS gmail_sync_runs (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  days INTEGER NOT NULL CHECK (days IN (7, 30, 90)),
  message_limit INTEGER NOT NULL CHECK (message_limit BETWEEN 1 AND 500),
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'partial', 'rate_limited', 'reauthorization_required', 'failed')),
  listed_count INTEGER NOT NULL DEFAULT 0,
  processed_count INTEGER NOT NULL DEFAULT 0,
  candidate_count INTEGER NOT NULL DEFAULT 0,
  duplicate_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  FOREIGN KEY (connection_id) REFERENCES gmail_connections(id) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS gmail_messages (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  gmail_message_id TEXT NOT NULL,
  sync_run_id TEXT NOT NULL,
  parse_status TEXT NOT NULL CHECK (parse_status IN ('parsed', 'needs_review', 'parse_error')),
  provider TEXT,
  received_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (connection_id, gmail_message_id),
  FOREIGN KEY (connection_id) REFERENCES gmail_connections(id) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (sync_run_id) REFERENCES gmail_sync_runs(id) ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS gmail_import_candidates (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  gmail_message_row_id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'needs_review' CHECK (status IN ('needs_review', 'ready', 'ignored', 'imported', 'parse_error')),
  provider TEXT,
  merchant_name TEXT,
  amount INTEGER CHECK (amount IS NULL OR typeof(amount) = 'integer'),
  occurred_at TEXT,
  payment_method TEXT,
  external_transaction_id TEXT,
  duplicate_warning INTEGER NOT NULL DEFAULT 0 CHECK (duplicate_warning IN (0, 1)),
  imported_project_id TEXT,
  import_record_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
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
