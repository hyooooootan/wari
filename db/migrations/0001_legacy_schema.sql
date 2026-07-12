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

CREATE TABLE IF NOT EXISTS project_shares (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL DEFAULT 'editor',
  expires_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
