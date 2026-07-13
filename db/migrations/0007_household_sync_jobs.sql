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
  FROM project_user_roles
  WHERE project_id = NEW.project_id
    AND user_id = NEW.user_id
    AND role IN ('owner', 'editor')
    AND revoked_at IS NULL
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
