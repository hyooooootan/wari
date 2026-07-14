WITH schema_flags AS (
  SELECT
    EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'd1_migrations') AS has_migrations,
    EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'projects') AS has_projects,
    EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'members') AS has_legacy_members,
    EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'expenses') AS has_legacy_expenses,
    EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'project_members') AS has_household_members,
    EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users') AS has_users,
    EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'gmail_connections') AS has_gmail,
    EXISTS(SELECT 1 FROM pragma_table_info('projects') WHERE name = 'owner_user_id') AS has_owner_column,
    EXISTS(SELECT 1 FROM pragma_table_info('gmail_connections') WHERE name = 'household_project_id') AS has_gmail_household_column
)
SELECT CASE
  WHEN has_projects = 1 AND has_legacy_members = 1 AND has_legacy_expenses = 1
       AND has_household_members = 0 AND has_users = 0 THEN 'legacy_initial'
  WHEN has_projects = 1 AND has_household_members = 1 AND has_users = 0 THEN 'household_ledger'
  WHEN has_projects = 1 AND has_users = 1 AND has_gmail = 0 THEN 'auth_without_gmail'
  WHEN has_projects = 1 AND has_users = 1 AND has_gmail = 1 AND has_owner_column = 0 THEN 'gmail_schema'
  WHEN has_projects = 1 AND has_owner_column = 1 AND has_gmail_household_column = 1 THEN 'personal_household_schema'
  ELSE 'unknown_schema'
END AS schema_stage,
has_migrations,
has_projects,
has_legacy_members,
has_legacy_expenses,
has_household_members,
has_users,
has_gmail,
has_owner_column,
has_gmail_household_column
FROM schema_flags;

SELECT name AS migration_table
FROM sqlite_master
WHERE type = 'table' AND name = 'd1_migrations';

SELECT name, type
FROM sqlite_master
WHERE type IN ('table', 'index', 'trigger', 'view')
ORDER BY type, name;

SELECT id
FROM projects
ORDER BY id;

SELECT COUNT(*) AS project_count
FROM projects;

SELECT COUNT(*) AS member_count
FROM members;

SELECT COUNT(*) AS expense_count,
       COALESCE(SUM(total_amount), 0) AS expense_total_amount
FROM expenses;

SELECT COUNT(*) AS expense_payment_count,
       COALESCE(SUM(amount), 0) AS expense_payment_total_amount
FROM expense_payments;

SELECT COUNT(*) AS item_count,
       COALESCE(SUM(amount), 0) AS item_total_amount
FROM items;

SELECT COUNT(*) AS item_member_count
FROM item_members;

SELECT COUNT(*) AS project_share_count
FROM project_shares;

SELECT projects.id AS project_id,
       (SELECT COUNT(*) FROM members WHERE members.project_id = projects.id) AS member_count,
       (SELECT COUNT(*) FROM expenses WHERE expenses.project_id = projects.id) AS expense_count,
       (SELECT COUNT(*) FROM expense_payments WHERE expense_payments.project_id = projects.id) AS expense_payment_count,
       (SELECT COUNT(*) FROM items WHERE items.project_id = projects.id) AS item_count,
       (SELECT COUNT(*) FROM item_members WHERE item_members.project_id = projects.id) AS item_member_count,
       COALESCE((SELECT SUM(total_amount) FROM expenses WHERE expenses.project_id = projects.id), 0) AS expense_total_amount,
       COALESCE((SELECT SUM(amount) FROM expense_payments WHERE expense_payments.project_id = projects.id), 0) AS expense_payment_total_amount,
       COALESCE((SELECT SUM(amount) FROM items WHERE items.project_id = projects.id), 0) AS item_total_amount
FROM projects
ORDER BY projects.id;

SELECT 'projects' AS table_name, group_concat(id, '|') AS primary_key_ids FROM projects;

SELECT 'members' AS table_name, group_concat(id, '|') AS primary_key_ids FROM members;

SELECT 'expenses' AS table_name, group_concat(id, '|') AS primary_key_ids FROM expenses;

SELECT 'expense_payments' AS table_name, group_concat(id, '|') AS primary_key_ids FROM expense_payments;

SELECT 'items' AS table_name, group_concat(id, '|') AS primary_key_ids FROM items;

SELECT 'item_members' AS table_name, group_concat(id, '|') AS primary_key_ids FROM item_members;

SELECT 'project_shares' AS table_name, group_concat(id, '|') AS primary_key_ids FROM project_shares;

PRAGMA foreign_key_check;
