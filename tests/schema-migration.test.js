const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const repositoryRoot = path.resolve(__dirname, '..');
const schemaSql = readFileSync(path.join(repositoryRoot, 'db', 'schema.sql'), 'utf8');
const baselineSql = readFileSync(path.join(repositoryRoot, 'db', 'migrations', '0001_initial.sql'), 'utf8');
const migrationSql = readFileSync(path.join(repositoryRoot, 'db', 'migrations', '0002_household_ledger.sql'), 'utf8');
const authMigrationSql = readFileSync(path.join(repositoryRoot, 'db', 'migrations', '0003_auth_ownership_shares.sql'), 'utf8');
const gmailMigrationSql = readFileSync(path.join(repositoryRoot, 'db', 'migrations', '0004_gmail_payment_import.sql'), 'utf8');
const gmailOauthProjectMigrationSql = readFileSync(path.join(repositoryRoot, 'db', 'migrations', '0005_gmail_oauth_project.sql'), 'utf8');
const verificationSql = readFileSync(path.join(repositoryRoot, 'db', 'verify_household_ledger.sql'), 'utf8');

const runtimeTables = [
  'gmail_connections',
  'gmail_import_candidates',
  'gmail_messages',
  'gmail_oauth_states',
  'gmail_sync_runs',
  'import_records',
  'item_allocations',
  'oauth_states',
  'project_members',
  'project_shares',
  'project_user_roles',
  'projects',
  'sessions',
  'transaction_items',
  'transaction_payments',
  'transactions',
  'users',
];

const requestedIndexes = [
  'idx_generated_household_transaction',
  'idx_gmail_candidates_amount_date',
  'idx_gmail_candidates_user_status',
  'idx_gmail_connections_user',
  'idx_gmail_messages_run',
  'idx_gmail_oauth_states_expiry',
  'idx_gmail_sync_runs_connection',
  'idx_import_records_project_amount_date',
  'idx_import_records_project_status',
  'idx_import_records_source_record',
  'idx_import_records_transaction',
  'idx_item_allocations_item',
  'idx_oauth_states_expiry',
  'idx_project_members_project',
  'idx_project_shares_project',
  'idx_project_user_roles_user',
  'idx_projects_share_token',
  'idx_sessions_user',
  'idx_transaction_items_transaction',
  'idx_transaction_payments_external_payment',
  'idx_transaction_payments_transaction',
  'idx_transactions_project_amount_date',
  'idx_transactions_project_date',
  'idx_transactions_project_status',
];

const legacySchemaSql = `
PRAGMA foreign_keys = ON;

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE members (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX idx_members_project_id ON members(project_id);

CREATE TABLE expenses (
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

CREATE INDEX idx_expenses_project_id ON expenses(project_id);

CREATE TABLE expense_payments (
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

CREATE INDEX idx_expense_payments_project_id ON expense_payments(project_id);
CREATE INDEX idx_expense_payments_expense_id ON expense_payments(expense_id);

CREATE TABLE items (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  expense_id TEXT NOT NULL,
  name TEXT NOT NULL,
  amount INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (expense_id) REFERENCES expenses(id) ON DELETE CASCADE
);

CREATE INDEX idx_items_project_id ON items(project_id);
CREATE INDEX idx_items_expense_id ON items(expense_id);

CREATE TABLE item_members (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE,
  FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE
);

CREATE INDEX idx_item_members_project_id ON item_members(project_id);
CREATE INDEX idx_item_members_item_id ON item_members(item_id);

CREATE TABLE project_shares (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL DEFAULT 'editor',
  expires_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX idx_project_shares_project_id ON project_shares(project_id);
CREATE INDEX idx_project_shares_token ON project_shares(token);
`;

function openDatabase(sql) {
  const database = new DatabaseSync(':memory:');
  database.exec(sql);
  return database;
}

function tableNames(database) {
  return database
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => row.name);
}

function indexNames(database) {
  return database
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => row.name);
}

function schemaObjects(database) {
  return database
    .prepare(`
      SELECT type, name, tbl_name, sql
      FROM sqlite_schema
      WHERE type IN ('table', 'index')
        AND name NOT LIKE 'sqlite_%'
        AND sql IS NOT NULL
      ORDER BY type, name
    `)
    .all()
    .map((row) => ({
      type: row.type,
      name: row.name,
      table: row.tbl_name,
      sql: row.sql.replace(/\bIF NOT EXISTS\b/gi, '').replace(/\s+/g, ' ').trim(),
    }));
}

function seedLegacyDatabase(database) {
  database.exec(`
    INSERT INTO projects (id, name, created_at) VALUES
      ('split-a', 'Trip', '2026-01-01T00:00:00.000Z'),
      ('split-b', 'Lunch', '2026-01-02T00:00:00.000Z');

    INSERT INTO members (id, project_id, name, created_at) VALUES
      ('member-a', 'split-a', 'A', '2026-01-01T00:00:00.000Z'),
      ('member-b', 'split-a', 'B', '2026-01-01T00:00:01.000Z'),
      ('member-c', 'split-a', 'C', '2026-01-01T00:00:02.000Z'),
      ('member-d', 'split-b', 'D', '2026-01-02T00:00:00.000Z');

    INSERT INTO expenses (id, project_id, payer_member_id, store_name, total_amount, paid_at, receipt_image_url, created_at) VALUES
      ('tx-items', 'split-a', 'member-a', 'Market', 1001, '2026-01-03T10:00:00.000Z', 'https://example.invalid/receipt.jpg', '2026-01-03T10:00:00.000Z'),
      ('tx-summary', 'split-a', 'member-c', 'Cafe', 10, '2026-01-04T10:00:00.000Z', NULL, '2026-01-04T10:00:00.000Z'),
      ('tx-fallback-item', 'split-b', 'member-d', 'Kiosk', 5, '2026-01-05T10:00:00.000Z', NULL, '2026-01-05T10:00:00.000Z');

    INSERT INTO expense_payments (id, project_id, expense_id, member_id, amount, created_at) VALUES
      ('payment-a', 'split-a', 'tx-items', 'member-a', 600, '2026-01-03T10:00:00.000Z'),
      ('payment-b', 'split-a', 'tx-items', 'member-b', 401, '2026-01-03T10:00:01.000Z');

    INSERT INTO items (id, project_id, expense_id, name, amount, created_at) VALUES
      ('item-linked', 'split-a', 'tx-items', 'Groceries', 998, '2026-01-03T10:00:00.000Z'),
      ('item-fallback', 'split-b', 'tx-fallback-item', 'Drink', 5, '2026-01-05T10:00:00.000Z');

    INSERT INTO item_members (id, project_id, item_id, member_id, created_at) VALUES
      ('item-link-c', 'split-a', 'item-linked', 'member-c', '2026-01-03T10:00:00.000Z'),
      ('item-link-a', 'split-a', 'item-linked', 'member-a', '2026-01-03T10:00:01.000Z'),
      ('item-link-b', 'split-a', 'item-linked', 'member-b', '2026-01-03T10:00:02.000Z');

    INSERT INTO project_shares (id, project_id, token, role, expires_at, created_at)
    VALUES ('share-a', 'split-a', 'share-token-a', 'viewer', '2027-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  `);
}

function insertProject(database, values) {
  database
    .prepare(`
      INSERT INTO projects (
        id, name, project_type, currency, share_token, share_role, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(...values);
}

test('fresh schema creates the seven runtime tables and requested indexes', (t) => {
  const database = openDatabase(schemaSql);
  t.after(() => database.close());

  assert.deepEqual(tableNames(database), runtimeTables);
  assert.deepEqual(indexNames(database), requestedIndexes);

  const projectColumns = database.prepare('PRAGMA table_info(projects)').all().map((row) => row.name);
  const memberColumns = database.prepare('PRAGMA table_info(project_members)').all().map((row) => row.name);
  const transactionColumns = database.prepare('PRAGMA table_info(transactions)').all().map((row) => row.name);

  assert.ok(projectColumns.includes('finalized_at'));
  assert.ok(memberColumns.includes('linked_household_project_id'));
  assert.ok(memberColumns.includes('linked_at'));
  assert.ok(transactionColumns.includes('entry_type'));
  assert.ok(transactionColumns.includes('origin_project_id'));
  assert.ok(transactionColumns.includes('origin_transaction_id'));
  assert.ok(transactionColumns.includes('origin_member_id'));
  assert.ok(transactionColumns.includes('generated_automatically'));

  const importTransactionKey = database
    .prepare('PRAGMA foreign_key_list(import_records)')
    .all()
    .find((row) => row.from === 'transaction_id');
  const allocationMemberKey = database
    .prepare('PRAGMA foreign_key_list(item_allocations)')
    .all()
    .find((row) => row.from === 'project_member_id');

  assert.equal(importTransactionKey.on_delete, 'SET NULL');
  assert.equal(allocationMemberKey.on_delete, 'RESTRICT');
});

test('numbered migrations create the runtime tables from an empty database', (t) => {
  const database = openDatabase(`${baselineSql}\n${migrationSql}\n${authMigrationSql}\n${gmailMigrationSql}\n${gmailOauthProjectMigrationSql}`);
  t.after(() => database.close());

  assert.deepEqual(tableNames(database), runtimeTables);
  assert.deepEqual(indexNames(database), requestedIndexes);
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
});

test('0005 invalidates OAuth states created before project selection was recorded', (t) => {
  const database=openDatabase(`${baselineSql}\n${migrationSql}\n${authMigrationSql}\n${gmailMigrationSql}`);
  t.after(()=>database.close());
  database.prepare("INSERT INTO users (id,google_sub,email,created_at,updated_at) VALUES (?,?,?,?,?)").run("state-user","state-sub","state@example.test","2026-01-01T00:00:00.000Z","2026-01-01T00:00:00.000Z");
  database.prepare("INSERT INTO gmail_oauth_states (state_hash,user_id,created_at,expires_at,used_at) VALUES (?,?,?,?,NULL)").run("legacy-state","state-user","2026-01-01T00:00:00.000Z","2099-01-01T00:00:00.000Z");
  database.exec(gmailOauthProjectMigrationSql);
  const state=database.prepare("SELECT project_id,used_at FROM gmail_oauth_states WHERE state_hash=?").get("legacy-state");
  assert.equal(state.project_id,null);
  assert.equal(state.used_at,"2026-01-01T00:00:00.000Z");
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('legacy migration preserves data and creates deterministic ledger rows', (t) => {
  const database = openDatabase(legacySchemaSql);
  t.after(() => database.close());
  seedLegacyDatabase(database);

  database.exec(`BEGIN IMMEDIATE;\n${migrationSql}\n${authMigrationSql}\n${gmailMigrationSql}\n${gmailOauthProjectMigrationSql}\nCOMMIT;`);

  const freshDatabase = openDatabase(schemaSql);
  t.after(() => freshDatabase.close());

  assert.deepEqual(tableNames(database), runtimeTables);
  assert.deepEqual(indexNames(database), requestedIndexes);
  assert.deepEqual(schemaObjects(database), schemaObjects(freshDatabase));
  assert.equal(database.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);

  const migratedProject = database
    .prepare(`
      SELECT project_type, currency, share_token, share_role, share_expires_at, finalized_at, created_at, updated_at
      FROM projects
      WHERE id = 'split-a'
    `)
    .get();

  assert.deepEqual({ ...migratedProject }, {
    project_type: 'split',
    currency: 'JPY',
    share_token: 'share-token-a',
    share_role: 'viewer',
    share_expires_at: '2027-01-01T00:00:00.000Z',
    finalized_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  });

  const ownerUnknown = database
    .prepare("SELECT id, deleted_at FROM users WHERE id = 'owner_unknown'")
    .get();
  assert.equal(ownerUnknown.id, 'owner_unknown');
  assert.equal(typeof ownerUnknown.deleted_at, 'string');
  assert.deepEqual(
    database.prepare("SELECT project_id, user_id, role FROM project_user_roles ORDER BY project_id").all().map((row) => ({ ...row })),
    [
      { project_id: 'split-a', user_id: 'owner_unknown', role: 'owner' },
      { project_id: 'split-b', user_id: 'owner_unknown', role: 'owner' },
    ],
  );

  const migratedMembers = database
    .prepare(`
      SELECT id, display_name, role, is_active, linked_household_project_id, linked_at
      FROM project_members
      ORDER BY id
    `)
    .all()
    .map((row) => ({ ...row }));

  assert.deepEqual(migratedMembers, [
    { id: 'member-a', display_name: 'A', role: 'member', is_active: 1, linked_household_project_id: null, linked_at: null },
    { id: 'member-b', display_name: 'B', role: 'member', is_active: 1, linked_household_project_id: null, linked_at: null },
    { id: 'member-c', display_name: 'C', role: 'member', is_active: 1, linked_household_project_id: null, linked_at: null },
    { id: 'member-d', display_name: 'D', role: 'member', is_active: 1, linked_household_project_id: null, linked_at: null },
  ]);

  const migratedTransactions = database
    .prepare(`
      SELECT id, merchant_name, merchant_normalized, gross_amount, paid_amount, status, occurred_at, entry_type,
             origin_project_id, origin_transaction_id, origin_member_id, generated_automatically
      FROM transactions
      ORDER BY id
    `)
    .all()
    .map((row) => ({ ...row }));

  assert.deepEqual(migratedTransactions, [
    {
      id: 'tx-fallback-item',
      merchant_name: 'Kiosk',
      merchant_normalized: 'kiosk',
      gross_amount: 5,
      paid_amount: 5,
      status: 'confirmed',
      occurred_at: '2026-01-05T10:00:00.000Z',
      entry_type: 'purchase',
      origin_project_id: null,
      origin_transaction_id: null,
      origin_member_id: null,
      generated_automatically: 0,
    },
    {
      id: 'tx-items',
      merchant_name: 'Market',
      merchant_normalized: 'market',
      gross_amount: 1001,
      paid_amount: 1001,
      status: 'confirmed',
      occurred_at: '2026-01-03T10:00:00.000Z',
      entry_type: 'purchase',
      origin_project_id: null,
      origin_transaction_id: null,
      origin_member_id: null,
      generated_automatically: 0,
    },
    {
      id: 'tx-summary',
      merchant_name: 'Cafe',
      merchant_normalized: 'cafe',
      gross_amount: 10,
      paid_amount: 10,
      status: 'confirmed',
      occurred_at: '2026-01-04T10:00:00.000Z',
      entry_type: 'purchase',
      origin_project_id: null,
      origin_transaction_id: null,
      origin_member_id: null,
      generated_automatically: 0,
    },
  ]);

  const itemTransactionPayments = database
    .prepare(`
      SELECT id, payer_member_id, amount
      FROM transaction_payments
      WHERE transaction_id = 'tx-items'
      ORDER BY id
    `)
    .all()
    .map((row) => ({ ...row }));

  assert.deepEqual(itemTransactionPayments, [
    { id: 'payment-a', payer_member_id: 'member-a', amount: 600 },
    { id: 'payment-b', payer_member_id: 'member-b', amount: 401 },
  ]);
  assert.equal(database.prepare("SELECT COUNT(*) AS value FROM transaction_payments WHERE transaction_id = 'tx-summary'").get().value, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS value FROM transaction_payments WHERE transaction_id = 'tx-fallback-item'").get().value, 1);

  const migratedItemRows = database
    .prepare(`
      SELECT item_type, amount, sort_order, is_hidden
      FROM transaction_items
      WHERE transaction_id = 'tx-items'
      ORDER BY sort_order
    `)
    .all()
    .map((row) => ({ ...row }));

  assert.deepEqual(migratedItemRows, [
    { item_type: 'product', amount: 998, sort_order: 0, is_hidden: 0 },
    { item_type: 'adjustment', amount: 3, sort_order: 1, is_hidden: 1 },
  ]);

  const summaryItem = database
    .prepare("SELECT id, amount, item_type FROM transaction_items WHERE transaction_id = 'tx-summary'")
    .get();
  assert.equal(summaryItem.item_type, 'summary');
  assert.equal(summaryItem.amount, 10);

  const productAllocations = database
    .prepare(`
      SELECT allocations.id, allocations.project_member_id, allocations.allocated_amount
      FROM item_allocations allocations
      JOIN project_members members ON members.id = allocations.project_member_id
      WHERE allocations.transaction_item_id = 'item-linked'
      ORDER BY allocations.created_at, allocations.id
    `)
    .all()
    .map((row) => ({ ...row }));

  assert.deepEqual(productAllocations, [
    { id: 'item-link-c', project_member_id: 'member-c', allocated_amount: 333 },
    { id: 'item-link-a', project_member_id: 'member-a', allocated_amount: 333 },
    { id: 'item-link-b', project_member_id: 'member-b', allocated_amount: 332 },
  ]);

  const summaryAllocations = database
    .prepare(`
      SELECT allocations.project_member_id, allocations.allocated_amount
      FROM item_allocations allocations
      JOIN project_members members ON members.id = allocations.project_member_id
      WHERE allocations.transaction_item_id = ?
      ORDER BY members.created_at, members.id
    `)
    .all(summaryItem.id)
    .map((row) => ({ ...row }));

  assert.deepEqual(summaryAllocations, [
    { project_member_id: 'member-a', allocated_amount: 4 },
    { project_member_id: 'member-b', allocated_amount: 3 },
    { project_member_id: 'member-c', allocated_amount: 3 },
  ]);

  const adjustmentId = database
    .prepare("SELECT id FROM transaction_items WHERE transaction_id = 'tx-items' AND item_type = 'adjustment'")
    .get().id;
  const adjustmentAllocations = database
    .prepare(`
      SELECT allocated_amount
      FROM item_allocations allocations
      JOIN project_members members ON members.id = allocations.project_member_id
      WHERE transaction_item_id = ?
      ORDER BY members.created_at, members.id
    `)
    .all(adjustmentId)
    .map((row) => row.allocated_amount);

  assert.deepEqual(adjustmentAllocations, [1, 1, 1]);
  assert.equal(database.prepare("SELECT allocated_amount FROM item_allocations WHERE transaction_item_id = 'item-fallback'").get().allocated_amount, 5);

  const migratedReceipt = database
    .prepare(`
      SELECT project_id, transaction_id, source_type, source_status, image_url, parser_version
      FROM import_records
    `)
    .get();

  assert.deepEqual({ ...migratedReceipt }, {
    project_id: 'split-a',
    transaction_id: 'tx-items',
    source_type: 'receipt',
    source_status: 'linked',
    image_url: 'https://example.invalid/receipt.jpg',
    parser_version: 'legacy-migration',
  });

  const reports = verificationSql
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean)
    .flatMap((statement) => database.prepare(statement).all())
    .map((row) => ({ ...row }));
  const reportValues = Object.fromEntries(reports.map((row) => [`${row.report_type}:${row.metric}`, row.value]));

  assert.equal(reportValues['count:projects'], 2);
  assert.equal(reportValues['count:project_members'], 4);
  assert.equal(reportValues['count:transactions'], 3);
  assert.equal(reportValues['count:transaction_payments'], 4);
  assert.equal(reportValues['count:transaction_items'], 4);
  assert.equal(reportValues['count:item_allocations'], 10);
  assert.equal(reportValues['count:import_records'], 1);
  assert.equal(reportValues['total:transaction_paid_amount'], 1016);
  assert.equal(reportValues['total:payment_amount'], 1016);
  assert.equal(reportValues['total:item_amount'], 1016);
  assert.equal(reportValues['total:allocated_amount'], 1016);
  for (const report of reports.filter((row) => row.report_type === 'failure')) {
    assert.equal(report.value, 0, report.metric);
  }

  assert.throws(() => database.exec(migrationSql), /no such table: item_members/);
});

test('checks and partial unique indexes enforce ledger identities', (t) => {
  const database = openDatabase(schemaSql);
  t.after(() => database.close());
  const now = '2026-02-01T00:00:00.000Z';

  insertProject(database, ['split', 'Split', 'split', 'JPY', null, 'editor', now, now]);
  insertProject(database, ['house-a', 'House A', 'household', 'JPY', 'shared-token', 'editor', now, now]);
  insertProject(database, ['house-b', 'House B', 'household', 'JPY', null, 'editor', now, now]);
  insertProject(database, ['house-c', 'House C', 'household', 'JPY', null, 'editor', now, now]);

  assert.throws(
    () => insertProject(database, ['house-d', 'House D', 'household', 'JPY', 'shared-token', 'editor', now, now]),
    /UNIQUE constraint failed/
  );
  assert.throws(
    () => insertProject(database, ['invalid', 'Invalid', 'other', 'JPY', null, 'editor', now, now]),
    /CHECK constraint failed/
  );

  database.prepare(`
    INSERT INTO project_members (
      id, project_id, display_name, role, is_active, linked_household_project_id, linked_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('split-member', 'split', 'A', 'member', 1, 'house-a', now, now, now);

  database.prepare(`
    INSERT INTO transactions (
      id, project_id, merchant_name, gross_amount, paid_amount, occurred_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run('source', 'split', 'Market', 100, 100, now, now, now);

  const insertGenerated = database.prepare(`
    INSERT INTO transactions (
      id, project_id, merchant_name, gross_amount, paid_amount, occurred_at, entry_type,
      origin_project_id, origin_transaction_id, origin_member_id, generated_automatically, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertGenerated.run('generated', 'house-a', 'Market', 50, 50, now, 'split_expense', 'split', 'source', 'split-member', 1, now, now);
  assert.throws(
    () => insertGenerated.run('generated-duplicate', 'house-a', 'Market', 50, 50, now, 'split_expense', 'split', 'source', 'split-member', 1, now, now),
    /UNIQUE constraint failed/
  );
  insertGenerated.run('manual-origin', 'house-a', 'Market', 50, 50, now, 'split_expense', 'split', 'source', 'split-member', 0, now, now);

  assert.throws(
    () => database.prepare(`
      INSERT INTO transactions (
        id, project_id, merchant_name, gross_amount, paid_amount, occurred_at, entry_type, created_at, updated_at
      ) VALUES ('invalid-entry', 'split', 'Market', 1, 1, ?, 'invalid', ?, ?)
    `).run(now, now, now),
    /CHECK constraint failed/
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO transactions (
        id, project_id, merchant_name, gross_amount, paid_amount, occurred_at, generated_automatically, created_at, updated_at
      ) VALUES ('invalid-generated', 'split', 'Market', 1, 1, ?, 2, ?, ?)
    `).run(now, now, now),
    /CHECK constraint failed/
  );

  const insertImport = database.prepare(`
    INSERT INTO import_records (
      id, project_id, source_type, source_record_id, source_status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  insertImport.run('import-null-a', 'split', 'manual', null, 'received', now, now);
  insertImport.run('import-null-b', 'split', 'manual', null, 'received', now, now);
  insertImport.run('import-source', 'split', 'card_csv', 'source-row', 'received', now, now);
  assert.throws(
    () => insertImport.run('import-source-duplicate', 'split', 'card_csv', 'source-row', 'received', now, now),
    /UNIQUE constraint failed/
  );

  const insertPayment = database.prepare(`
    INSERT INTO transaction_payments (
      id, transaction_id, amount, payment_method, external_payment_id, payment_status, occurred_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertPayment.run('payment-null-a', 'source', 25, 'other', null, 'confirmed', now, now, now);
  insertPayment.run('payment-null-b', 'source', 25, 'other', null, 'confirmed', now, now, now);
  insertPayment.run('payment-external', 'source', 25, 'other', 'external-payment', 'confirmed', now, now, now);
  assert.throws(
    () => insertPayment.run('payment-external-duplicate', 'source', 25, 'other', 'external-payment', 'confirmed', now, now, now),
    /UNIQUE constraint failed/
  );

  database.prepare("UPDATE transactions SET status = 'cancelled' WHERE id = 'generated'").run();
  database.prepare("DELETE FROM transactions WHERE id = 'source'").run();
  assert.equal(database.prepare("SELECT origin_transaction_id FROM transactions WHERE id = 'generated'").get().origin_transaction_id, null);

  database.prepare("DELETE FROM projects WHERE id = 'house-a'").run();
  const unlinkedMember = database.prepare("SELECT linked_household_project_id, linked_at FROM project_members WHERE id = 'split-member'").get();
  assert.equal(unlinkedMember.linked_household_project_id, null);
  assert.equal(unlinkedMember.linked_at, now);
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
});

test('foreign-key actions preserve audit rows and restrict allocated member deletion', (t) => {
  const database = openDatabase(schemaSql);
  t.after(() => database.close());
  const now = '2026-03-01T00:00:00.000Z';

  insertProject(database, ['project', 'Project', 'split', 'JPY', null, 'editor', now, now]);
  database.prepare(`
    INSERT INTO project_members (id, project_id, display_name, role, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('allocated-member', 'project', 'Allocated', 'member', 1, now, now);
  database.prepare(`
    INSERT INTO project_members (id, project_id, display_name, role, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('payer-member', 'project', 'Payer', 'member', 1, now, now);
  database.prepare(`
    INSERT INTO transactions (id, project_id, merchant_name, gross_amount, paid_amount, occurred_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run('transaction', 'project', 'Store', 20, 20, now, now, now);
  database.prepare(`
    INSERT INTO transaction_payments (
      id, transaction_id, payer_member_id, amount, payment_method, payment_status, occurred_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('payment', 'transaction', 'payer-member', 20, 'cash', 'confirmed', now, now, now);
  database.prepare(`
    INSERT INTO transaction_items (
      id, transaction_id, name, amount, quantity, item_type, sort_order, is_hidden, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('item', 'transaction', 'Total', 20, 1, 'summary', 0, 0, now, now);
  database.prepare(`
    INSERT INTO item_allocations (
      id, transaction_item_id, project_member_id, allocated_amount, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run('allocation', 'item', 'allocated-member', 20, now, now);
  database.prepare(`
    INSERT INTO import_records (
      id, project_id, transaction_id, source_type, source_status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('import', 'project', 'transaction', 'receipt', 'linked', now, now);

  assert.throws(
    () => database.prepare("DELETE FROM project_members WHERE id = 'allocated-member'").run(),
    /FOREIGN KEY constraint failed/
  );

  database.prepare("DELETE FROM project_members WHERE id = 'payer-member'").run();
  assert.equal(database.prepare("SELECT payer_member_id FROM transaction_payments WHERE id = 'payment'").get().payer_member_id, null);

  database.prepare("DELETE FROM transactions WHERE id = 'transaction'").run();
  assert.equal(database.prepare('SELECT COUNT(*) AS value FROM transaction_payments').get().value, 0);
  assert.equal(database.prepare('SELECT COUNT(*) AS value FROM transaction_items').get().value, 0);
  assert.equal(database.prepare('SELECT COUNT(*) AS value FROM item_allocations').get().value, 0);
  assert.equal(database.prepare("SELECT transaction_id FROM import_records WHERE id = 'import'").get().transaction_id, null);

  database.prepare("DELETE FROM project_members WHERE id = 'allocated-member'").run();
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
});
