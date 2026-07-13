ALTER TABLE gmail_import_candidates RENAME TO gmail_import_candidates_legacy;
ALTER TABLE gmail_messages RENAME TO gmail_messages_legacy;
ALTER TABLE gmail_sync_runs RENAME TO gmail_sync_runs_legacy;
ALTER TABLE gmail_connections RENAME TO gmail_connections_legacy;

CREATE TABLE gmail_connections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  gmail_email TEXT NOT NULL,
  refresh_token_ciphertext TEXT NOT NULL,
  refresh_token_iv TEXT NOT NULL,
  key_generation INTEGER NOT NULL CHECK (key_generation > 0),
  aad_version INTEGER NOT NULL DEFAULT 1 CHECK (aad_version = 1),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'reauthorization_required', 'disconnecting', 'disconnected')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_synced_at TEXT,
  UNIQUE (user_id, gmail_email),
  FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE TABLE gmail_sync_runs (
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

CREATE TABLE gmail_messages (
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

CREATE TABLE gmail_import_candidates (
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

INSERT INTO gmail_connections SELECT * FROM gmail_connections_legacy;
INSERT INTO gmail_sync_runs SELECT * FROM gmail_sync_runs_legacy;
INSERT INTO gmail_messages SELECT * FROM gmail_messages_legacy;
INSERT INTO gmail_import_candidates SELECT * FROM gmail_import_candidates_legacy;

DROP TABLE gmail_import_candidates_legacy;
DROP TABLE gmail_messages_legacy;
DROP TABLE gmail_sync_runs_legacy;
DROP TABLE gmail_connections_legacy;

CREATE INDEX idx_gmail_connections_user ON gmail_connections(user_id, status);
CREATE INDEX idx_gmail_sync_runs_connection ON gmail_sync_runs(connection_id, started_at DESC);
CREATE INDEX idx_gmail_messages_run ON gmail_messages(sync_run_id);
CREATE INDEX idx_gmail_candidates_user_status ON gmail_import_candidates(user_id, status, created_at DESC);
CREATE INDEX idx_gmail_candidates_amount_date ON gmail_import_candidates(user_id, amount, occurred_at);

CREATE TABLE gmail_revocation_retries (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('oauth_storage_rejected')),
  token_ciphertext TEXT NOT NULL,
  token_iv TEXT NOT NULL,
  key_generation INTEGER NOT NULL CHECK (key_generation > 0),
  aad_version INTEGER NOT NULL DEFAULT 1 CHECK (aad_version = 1),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed')),
  attempt_count INTEGER NOT NULL DEFAULT 1 CHECK (attempt_count >= 1),
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_attempted_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX idx_gmail_revocation_retries_status
ON gmail_revocation_retries(status, updated_at);

DROP TRIGGER trg_household_sync_guard_insert;

CREATE TRIGGER trg_household_sync_guard_insert
BEFORE INSERT ON household_sync_guards
WHEN NOT EXISTS (
  SELECT 1
  FROM project_user_roles
  JOIN users ON users.id = project_user_roles.user_id
  WHERE project_user_roles.project_id = NEW.project_id
    AND project_user_roles.user_id = NEW.user_id
    AND project_user_roles.role IN ('owner', 'editor')
    AND project_user_roles.revoked_at IS NULL
    AND users.deleted_at IS NULL
    AND users.deletion_started_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'household_sync_access_denied');
END;
