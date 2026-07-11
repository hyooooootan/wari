PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  project_type TEXT NOT NULL DEFAULT 'split' CHECK (project_type IN ('split', 'household')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'confirmed', 'archived')),
  confirmed_at TEXT,
  share_token TEXT UNIQUE,
  share_role TEXT NOT NULL DEFAULT 'editor',
  share_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_projects_type_created ON projects(project_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_projects_share_token ON projects(share_token);

CREATE TABLE IF NOT EXISTS project_members (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  linked_household_project_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (linked_household_project_id) REFERENCES projects(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_project_members_project ON project_members(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_project_members_household ON project_members(linked_household_project_id);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  transaction_type TEXT NOT NULL DEFAULT 'purchase' CHECK (transaction_type IN ('purchase', 'refund', 'correction', 'adjustment', 'advance', 'settlement_sent', 'settlement_received', 'split_expense')),
  merchant_name TEXT NOT NULL,
  gross_amount INTEGER NOT NULL DEFAULT 0,
  paid_amount INTEGER NOT NULL DEFAULT 0,
  discount_amount INTEGER NOT NULL DEFAULT 0,
  point_amount INTEGER NOT NULL DEFAULT 0,
  category TEXT,
  status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('draft', 'confirmed', 'cancelled', 'refunded', 'corrected')),
  occurred_at TEXT NOT NULL,
  settled_at TEXT,
  note TEXT,
  receipt_image_url TEXT,
  origin_project_id TEXT,
  origin_transaction_id TEXT,
  origin_member_id TEXT,
  entry_type TEXT NOT NULL DEFAULT 'expense',
  generated_automatically INTEGER NOT NULL DEFAULT 0 CHECK (generated_automatically IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_transactions_project_date ON transactions(project_id, occurred_at DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_origin ON transactions(origin_project_id, origin_transaction_id, origin_member_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_generated_unique
  ON transactions(origin_project_id, origin_transaction_id, origin_member_id, transaction_type)
  WHERE generated_automatically = 1;

CREATE TABLE IF NOT EXISTS transaction_payments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  transaction_id TEXT NOT NULL,
  payer_member_id TEXT,
  amount INTEGER NOT NULL,
  payment_method TEXT,
  provider TEXT,
  account_label TEXT,
  external_payment_id TEXT,
  payment_status TEXT NOT NULL DEFAULT 'completed',
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE,
  FOREIGN KEY (payer_member_id) REFERENCES project_members(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_transaction_payments_transaction ON transaction_payments(transaction_id, created_at);
CREATE INDEX IF NOT EXISTS idx_transaction_payments_project ON transaction_payments(project_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS transaction_items (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  transaction_id TEXT NOT NULL,
  name TEXT NOT NULL,
  amount INTEGER NOT NULL,
  quantity REAL NOT NULL DEFAULT 1,
  item_type TEXT NOT NULL DEFAULT 'line_item',
  category TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_hidden INTEGER NOT NULL DEFAULT 0 CHECK (is_hidden IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_transaction_items_transaction ON transaction_items(transaction_id, sort_order, created_at);

CREATE TABLE IF NOT EXISTS item_allocations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  transaction_item_id TEXT NOT NULL,
  project_member_id TEXT NOT NULL,
  allocated_amount INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (transaction_item_id) REFERENCES transaction_items(id) ON DELETE CASCADE,
  FOREIGN KEY (project_member_id) REFERENCES project_members(id) ON DELETE CASCADE,
  UNIQUE (transaction_item_id, project_member_id)
);

CREATE INDEX IF NOT EXISTS idx_item_allocations_item ON item_allocations(transaction_item_id, project_member_id);
CREATE INDEX IF NOT EXISTS idx_item_allocations_project ON item_allocations(project_id);

CREATE TABLE IF NOT EXISTS import_records (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_record_id TEXT NOT NULL,
  source_status TEXT NOT NULL DEFAULT 'preview',
  imported_at TEXT,
  occurred_at TEXT,
  merchant_name TEXT,
  normalized_merchant_name TEXT,
  gross_amount INTEGER,
  category TEXT,
  payment_method TEXT,
  provider TEXT,
  account_label TEXT,
  raw_payload TEXT NOT NULL,
  matched_transaction_id TEXT,
  match_score INTEGER NOT NULL DEFAULT 0,
  match_reason_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (matched_transaction_id) REFERENCES transactions(id) ON DELETE SET NULL,
  UNIQUE (project_id, source_type, source_record_id)
);

CREATE INDEX IF NOT EXISTS idx_import_records_project ON import_records(project_id, occurred_at DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_import_records_match ON import_records(matched_transaction_id);
