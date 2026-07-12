CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_members_project_id ON members(project_id);

CREATE TABLE IF NOT EXISTS expenses (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  payer_member_id TEXT,
  store_name TEXT NOT NULL,
  total_amount INTEGER NOT NULL,
  paid_at TEXT NOT NULL,
  receipt_image_url TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_expenses_project_id ON expenses(project_id);

CREATE TABLE IF NOT EXISTS expense_payments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  expense_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (expense_id) REFERENCES expenses(id) ON DELETE CASCADE,
  FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_expense_payments_project_id ON expense_payments(project_id);
CREATE INDEX IF NOT EXISTS idx_expense_payments_expense_id ON expense_payments(expense_id);

CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  expense_id TEXT NOT NULL,
  name TEXT NOT NULL,
  amount INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (expense_id) REFERENCES expenses(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_items_project_id ON items(project_id);
CREATE INDEX IF NOT EXISTS idx_items_expense_id ON items(expense_id);

CREATE TABLE IF NOT EXISTS item_members (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE,
  FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_item_members_project_id ON item_members(project_id);
CREATE INDEX IF NOT EXISTS idx_item_members_item_id ON item_members(item_id);

CREATE TABLE IF NOT EXISTS project_shares (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL DEFAULT 'editor',
  expires_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_project_shares_project_id ON project_shares(project_id);
CREATE INDEX IF NOT EXISTS idx_project_shares_token ON project_shares(token);

CREATE TABLE IF NOT EXISTS gmail_oauth_states (
  state TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_gmail_oauth_states_expires_at ON gmail_oauth_states(expires_at);

CREATE TABLE IF NOT EXISTS gmail_connections (
  id TEXT PRIMARY KEY,
  email TEXT,
  refresh_token_ciphertext TEXT NOT NULL,
  scope TEXT NOT NULL,
  last_sync_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS gmail_payment_candidates (
  id TEXT PRIMARY KEY,
  gmail_message_id TEXT NOT NULL UNIQUE,
  thread_id TEXT,
  subject TEXT,
  sender TEXT,
  received_at TEXT,
  merchant TEXT,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'JPY',
  paid_at TEXT,
  payment_method TEXT,
  confidence REAL NOT NULL DEFAULT 0,
  body_excerpt TEXT,
  parser TEXT NOT NULL DEFAULT 'heuristic',
  status TEXT NOT NULL DEFAULT 'pending',
  imported_project_id TEXT,
  imported_expense_id TEXT,
  imported_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (imported_project_id) REFERENCES projects(id) ON DELETE SET NULL,
  FOREIGN KEY (imported_expense_id) REFERENCES expenses(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_gmail_payment_candidates_status ON gmail_payment_candidates(status);
CREATE INDEX IF NOT EXISTS idx_gmail_payment_candidates_paid_at ON gmail_payment_candidates(paid_at);
