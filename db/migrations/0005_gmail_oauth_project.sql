ALTER TABLE gmail_oauth_states RENAME TO gmail_oauth_states_legacy;

CREATE TABLE IF NOT EXISTS gmail_oauth_states (
  state_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  project_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON UPDATE CASCADE ON DELETE CASCADE
);

INSERT INTO gmail_oauth_states (state_hash, user_id, project_id, created_at, expires_at, used_at)
SELECT state_hash, user_id, NULL, created_at, expires_at, used_at
FROM gmail_oauth_states_legacy;

DROP TABLE gmail_oauth_states_legacy;

CREATE INDEX IF NOT EXISTS idx_gmail_oauth_states_expiry ON gmail_oauth_states(expires_at);
