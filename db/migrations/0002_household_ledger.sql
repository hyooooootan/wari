PRAGMA defer_foreign_keys = ON;

ALTER TABLE item_members RENAME TO _legacy_item_members;
ALTER TABLE items RENAME TO _legacy_items;
ALTER TABLE expense_payments RENAME TO _legacy_expense_payments;
ALTER TABLE expenses RENAME TO _legacy_expenses;
ALTER TABLE members RENAME TO _legacy_members;
ALTER TABLE project_shares RENAME TO _legacy_project_shares;
ALTER TABLE projects RENAME TO _legacy_projects;

CREATE TABLE projects (
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

CREATE TABLE project_members (
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

CREATE TABLE transactions (
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

CREATE TABLE transaction_payments (
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

CREATE TABLE transaction_items (
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

CREATE TABLE item_allocations (
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

CREATE TABLE import_records (
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

WITH ranked_shares AS (
  SELECT
    project_id,
    token,
    role,
    expires_at,
    ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY created_at, id) AS share_order
  FROM _legacy_project_shares
)
INSERT INTO projects (
  id,
  name,
  project_type,
  currency,
  share_token,
  share_role,
  share_expires_at,
  finalized_at,
  created_at,
  updated_at
)
SELECT
  p.id,
  p.name,
  'split',
  'JPY',
  s.token,
  CASE WHEN s.role IN ('editor', 'viewer') THEN s.role ELSE 'editor' END,
  s.expires_at,
  NULL,
  p.created_at,
  p.created_at
FROM _legacy_projects p
LEFT JOIN ranked_shares s
  ON s.project_id = p.id
 AND s.share_order = 1;

INSERT INTO project_members (
  id,
  project_id,
  display_name,
  role,
  is_active,
  linked_household_project_id,
  linked_at,
  created_at,
  updated_at
)
SELECT
  id,
  project_id,
  name,
  'member',
  1,
  NULL,
  NULL,
  created_at,
  created_at
FROM _legacy_members;

INSERT INTO transactions (
  id,
  project_id,
  merchant_name,
  merchant_normalized,
  gross_amount,
  paid_amount,
  discount_amount,
  point_amount,
  category,
  status,
  occurred_at,
  settled_at,
  note,
  entry_type,
  origin_project_id,
  origin_transaction_id,
  origin_member_id,
  generated_automatically,
  created_at,
  updated_at
)
SELECT
  id,
  project_id,
  store_name,
  lower(trim(store_name)),
  total_amount,
  total_amount,
  0,
  0,
  NULL,
  'confirmed',
  paid_at,
  NULL,
  NULL,
  'purchase',
  NULL,
  NULL,
  NULL,
  0,
  created_at,
  created_at
FROM _legacy_expenses;

INSERT INTO transaction_payments (
  id,
  transaction_id,
  payer_member_id,
  amount,
  payment_method,
  provider,
  account_label,
  external_payment_id,
  payment_status,
  occurred_at,
  created_at,
  updated_at
)
SELECT
  p.id,
  p.expense_id,
  p.member_id,
  p.amount,
  'other',
  NULL,
  NULL,
  NULL,
  'confirmed',
  e.paid_at,
  p.created_at,
  p.created_at
FROM _legacy_expense_payments p
JOIN _legacy_expenses e
  ON e.id = p.expense_id;

INSERT INTO transaction_payments (
  id,
  transaction_id,
  payer_member_id,
  amount,
  payment_method,
  provider,
  account_label,
  external_payment_id,
  payment_status,
  occurred_at,
  created_at,
  updated_at
)
SELECT
  'migration:payer:' || lower(hex(CAST(e.id AS BLOB))),
  e.id,
  e.payer_member_id,
  e.total_amount,
  'other',
  NULL,
  NULL,
  NULL,
  'confirmed',
  e.paid_at,
  e.created_at,
  e.created_at
FROM _legacy_expenses e
JOIN _legacy_members m
  ON m.id = e.payer_member_id
 AND m.project_id = e.project_id
WHERE e.payer_member_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM _legacy_expense_payments p
    WHERE p.expense_id = e.id
  );

INSERT INTO transaction_items (
  id,
  transaction_id,
  name,
  amount,
  quantity,
  item_type,
  category,
  sort_order,
  is_hidden,
  created_at,
  updated_at
)
SELECT
  id,
  expense_id,
  name,
  amount,
  1,
  'product',
  NULL,
  ROW_NUMBER() OVER (PARTITION BY expense_id ORDER BY created_at, id) - 1,
  0,
  created_at,
  created_at
FROM _legacy_items;

INSERT INTO transaction_items (
  id,
  transaction_id,
  name,
  amount,
  quantity,
  item_type,
  category,
  sort_order,
  is_hidden,
  created_at,
  updated_at
)
SELECT
  'migration:summary:' || lower(hex(CAST(e.id AS BLOB))),
  e.id,
  '会計全体',
  e.total_amount,
  1,
  'summary',
  NULL,
  0,
  0,
  e.created_at,
  e.created_at
FROM _legacy_expenses e
WHERE NOT EXISTS (
  SELECT 1
  FROM _legacy_items i
  WHERE i.expense_id = e.id
);

WITH item_totals AS (
  SELECT
    expense_id,
    COUNT(*) AS item_count,
    SUM(amount) AS item_total
  FROM _legacy_items
  GROUP BY expense_id
)
INSERT INTO transaction_items (
  id,
  transaction_id,
  name,
  amount,
  quantity,
  item_type,
  category,
  sort_order,
  is_hidden,
  created_at,
  updated_at
)
SELECT
  'migration:adjustment:' || lower(hex(CAST(e.id AS BLOB))),
  e.id,
  '差額調整',
  e.total_amount - totals.item_total,
  1,
  'adjustment',
  NULL,
  totals.item_count,
  1,
  e.created_at,
  e.created_at
FROM _legacy_expenses e
JOIN item_totals totals
  ON totals.expense_id = e.id
WHERE totals.item_total <> e.total_amount;

WITH ranked_legacy_links AS (
  SELECT
    links.item_id AS transaction_item_id,
    links.member_id AS project_member_id,
    links.id AS allocation_id,
    links.created_at AS allocation_created_at,
    ROW_NUMBER() OVER (
      PARTITION BY links.item_id, links.member_id
      ORDER BY links.created_at, links.id
    ) AS duplicate_order
  FROM _legacy_item_members links
  JOIN _legacy_items items
    ON items.id = links.item_id
   AND items.project_id = links.project_id
  JOIN _legacy_members members
    ON members.id = links.member_id
   AND members.project_id = items.project_id
),
valid_legacy_links AS (
  SELECT
    transaction_item_id,
    project_member_id,
    allocation_id,
    allocation_created_at
  FROM ranked_legacy_links
  WHERE duplicate_order = 1
),
candidate_links AS (
  SELECT
    links.transaction_item_id,
    links.project_member_id,
    links.allocation_id,
    links.allocation_created_at,
    links.allocation_created_at AS allocation_sort_at,
    links.allocation_id AS allocation_sort_id
  FROM valid_legacy_links links
  JOIN project_members members
    ON members.id = links.project_member_id

  UNION ALL

  SELECT
    items.id,
    members.id,
    'migration:allocation:' || lower(hex(CAST(items.id AS BLOB))) || ':' || lower(hex(CAST(members.id AS BLOB))),
    items.created_at,
    members.created_at,
    members.id
  FROM transaction_items items
  JOIN transactions transactions
    ON transactions.id = items.transaction_id
  JOIN project_members members
    ON members.project_id = transactions.project_id
   AND members.is_active = 1
  WHERE NOT EXISTS (
    SELECT 1
    FROM valid_legacy_links links
    WHERE links.transaction_item_id = items.id
  )
),
ordered_links AS (
  SELECT
    candidates.transaction_item_id,
    candidates.project_member_id,
    candidates.allocation_id,
    candidates.allocation_created_at,
    items.amount,
    ROW_NUMBER() OVER (
      PARTITION BY candidates.transaction_item_id
      ORDER BY candidates.allocation_sort_at, candidates.allocation_sort_id
    ) AS allocation_order,
    COUNT(*) OVER (
      PARTITION BY candidates.transaction_item_id
    ) AS recipient_count
  FROM candidate_links candidates
  JOIN transaction_items items
    ON items.id = candidates.transaction_item_id
),
allocation_parts AS (
  SELECT
    *,
    CAST(amount / recipient_count AS INTEGER) AS base_amount,
    amount - CAST(amount / recipient_count AS INTEGER) * recipient_count AS remainder_amount
  FROM ordered_links
)
INSERT INTO item_allocations (
  id,
  transaction_item_id,
  project_member_id,
  allocated_amount,
  created_at,
  updated_at
)
SELECT
  allocation_id,
  transaction_item_id,
  project_member_id,
  base_amount + CASE
    WHEN remainder_amount > 0 AND allocation_order <= remainder_amount THEN 1
    WHEN remainder_amount < 0 AND allocation_order <= -remainder_amount THEN -1
    ELSE 0
  END,
  allocation_created_at,
  allocation_created_at
FROM allocation_parts;

INSERT INTO import_records (
  id,
  project_id,
  transaction_id,
  source_type,
  source_record_id,
  source_status,
  merchant_raw,
  merchant_normalized,
  gross_amount_raw,
  paid_amount_raw,
  occurred_at_raw,
  settled_at_raw,
  payment_method_raw,
  external_transaction_id,
  image_url,
  raw_text,
  raw_payload,
  parse_confidence,
  parser_version,
  match_score,
  match_reason_json,
  created_at,
  updated_at
)
SELECT
  'migration:receipt:' || lower(hex(CAST(id AS BLOB))),
  project_id,
  id,
  'receipt',
  'legacy-expense:' || lower(hex(CAST(id AS BLOB))),
  'linked',
  store_name,
  lower(trim(store_name)),
  total_amount,
  total_amount,
  paid_at,
  NULL,
  NULL,
  NULL,
  receipt_image_url,
  NULL,
  NULL,
  NULL,
  'legacy-migration',
  NULL,
  NULL,
  created_at,
  created_at
FROM _legacy_expenses
WHERE receipt_image_url IS NOT NULL
  AND trim(receipt_image_url) <> '';

DROP TABLE _legacy_item_members;
DROP TABLE _legacy_items;
DROP TABLE _legacy_expense_payments;
DROP TABLE _legacy_expenses;
DROP TABLE _legacy_members;
DROP TABLE _legacy_project_shares;
DROP TABLE _legacy_projects;

CREATE UNIQUE INDEX idx_projects_share_token
ON projects(share_token)
WHERE share_token IS NOT NULL;

CREATE UNIQUE INDEX idx_transaction_payments_external_payment
ON transaction_payments(external_payment_id)
WHERE external_payment_id IS NOT NULL;

CREATE UNIQUE INDEX idx_import_records_source_record
ON import_records(project_id, source_type, source_record_id)
WHERE source_record_id IS NOT NULL;

CREATE UNIQUE INDEX idx_generated_household_transaction
ON transactions(project_id, origin_project_id, origin_transaction_id, origin_member_id, entry_type)
WHERE generated_automatically = 1;

CREATE INDEX idx_project_members_project
ON project_members(project_id, is_active);

CREATE INDEX idx_transactions_project_date
ON transactions(project_id, occurred_at DESC);

CREATE INDEX idx_transactions_project_amount_date
ON transactions(project_id, paid_amount, occurred_at);

CREATE INDEX idx_transactions_project_status
ON transactions(project_id, status, occurred_at DESC);

CREATE INDEX idx_transaction_payments_transaction
ON transaction_payments(transaction_id);

CREATE INDEX idx_transaction_items_transaction
ON transaction_items(transaction_id, sort_order);

CREATE INDEX idx_item_allocations_item
ON item_allocations(transaction_item_id);

CREATE INDEX idx_import_records_project_status
ON import_records(project_id, source_status, created_at DESC);

CREATE INDEX idx_import_records_project_amount_date
ON import_records(project_id, paid_amount_raw, occurred_at_raw);

CREATE INDEX idx_import_records_transaction
ON import_records(transaction_id);
