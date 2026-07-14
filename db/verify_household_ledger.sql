SELECT 'count' AS report_type, 'projects' AS metric, COUNT(*) AS value FROM projects
UNION ALL
SELECT 'count', 'project_members', COUNT(*) FROM project_members
UNION ALL
SELECT 'count', 'transactions', COUNT(*) FROM transactions
UNION ALL
SELECT 'count', 'transaction_payments', COUNT(*) FROM transaction_payments
UNION ALL
SELECT 'count', 'transaction_items', COUNT(*) FROM transaction_items;

SELECT 'count' AS report_type, 'item_allocations' AS metric, COUNT(*) AS value FROM item_allocations
UNION ALL
SELECT 'count', 'import_records', COUNT(*) FROM import_records
UNION ALL
SELECT 'total', 'transaction_paid_amount', COALESCE(SUM(paid_amount), 0) FROM transactions
UNION ALL
SELECT 'total', 'payment_amount', COALESCE(SUM(amount), 0) FROM transaction_payments
UNION ALL
SELECT 'total', 'item_amount', COALESCE(SUM(amount), 0) FROM transaction_items;

SELECT 'total' AS report_type, 'allocated_amount' AS metric, COALESCE(SUM(allocated_amount), 0) AS value FROM item_allocations;

SELECT 'failure' AS report_type, 'foreign_keys' AS metric, COUNT(*) AS value
FROM pragma_foreign_key_check
UNION ALL
SELECT 'failure', 'transactions_without_items', COUNT(*)
FROM transactions transactions
WHERE NOT EXISTS (
  SELECT 1
  FROM transaction_items items
  WHERE items.transaction_id = transactions.id
)
UNION ALL
SELECT 'failure', 'payment_total_mismatches', COUNT(*)
FROM transactions transactions
WHERE transactions.paid_amount <> COALESCE((
  SELECT SUM(payments.amount)
  FROM transaction_payments payments
  WHERE payments.transaction_id = transactions.id
    AND payments.payment_status NOT IN ('cancelled', 'refunded')
), 0)
UNION ALL
SELECT 'failure', 'item_total_mismatches', COUNT(*)
FROM transactions transactions
WHERE transactions.paid_amount <> COALESCE((
  SELECT SUM(items.amount)
  FROM transaction_items items
  WHERE items.transaction_id = transactions.id
), 0)
UNION ALL
SELECT 'failure', 'items_without_allocations', COUNT(*)
FROM transaction_items items
WHERE NOT EXISTS (
  SELECT 1
  FROM item_allocations allocations
  WHERE allocations.transaction_item_id = items.id
);

SELECT 'failure' AS report_type, 'allocation_total_mismatches' AS metric, COUNT(*) AS value
FROM transaction_items items
WHERE items.amount <> COALESCE((
  SELECT SUM(allocations.allocated_amount)
  FROM item_allocations allocations
  WHERE allocations.transaction_item_id = items.id
), 0)
UNION ALL
SELECT 'failure', 'cross_project_payments', COUNT(*)
FROM transaction_payments payments
JOIN transactions transactions
  ON transactions.id = payments.transaction_id
JOIN project_members members
  ON members.id = payments.payer_member_id
WHERE members.project_id <> transactions.project_id
UNION ALL
SELECT 'failure', 'cross_project_allocations', COUNT(*)
FROM item_allocations allocations
JOIN transaction_items items
  ON items.id = allocations.transaction_item_id
JOIN transactions transactions
  ON transactions.id = items.transaction_id
JOIN project_members members
  ON members.id = allocations.project_member_id
WHERE members.project_id <> transactions.project_id
UNION ALL
SELECT 'failure', 'cross_project_import_links', COUNT(*)
FROM import_records imports
JOIN transactions transactions
  ON transactions.id = imports.transaction_id
WHERE imports.project_id <> transactions.project_id
UNION ALL
SELECT 'failure', 'invalid_household_links', COUNT(*)
FROM project_members members
JOIN projects households
  ON households.id = members.linked_household_project_id
WHERE households.project_type <> 'household';

SELECT 'failure' AS report_type, 'incomplete_household_links' AS metric, COUNT(*) AS value
FROM project_members
WHERE linked_household_project_id IS NOT NULL
  AND linked_at IS NULL
UNION ALL
SELECT 'failure', 'generated_rows_without_origins', COUNT(*)
FROM transactions
WHERE generated_automatically = 1
  AND status <> 'cancelled'
  AND (
    origin_project_id IS NULL
    OR origin_transaction_id IS NULL
    OR origin_member_id IS NULL
  )
UNION ALL
SELECT 'failure', 'generated_origin_transaction_mismatches', COUNT(*)
FROM transactions generated
JOIN transactions origin
  ON origin.id = generated.origin_transaction_id
WHERE generated.generated_automatically = 1
  AND origin.project_id <> generated.origin_project_id
UNION ALL
SELECT 'failure', 'generated_origin_member_mismatches', COUNT(*)
FROM transactions generated
JOIN project_members origin_member
  ON origin_member.id = generated.origin_member_id
WHERE generated.generated_automatically = 1
  AND origin_member.project_id <> generated.origin_project_id
UNION ALL
SELECT 'failure', 'duplicate_generated_rows', COUNT(*)
FROM (
  SELECT 1
  FROM transactions
  WHERE generated_automatically = 1
  GROUP BY project_id, origin_project_id, origin_transaction_id, origin_member_id, entry_type
  HAVING COUNT(*) > 1
);

SELECT 'failure' AS report_type, 'duplicate_source_records' AS metric, COUNT(*) AS value
FROM (
  SELECT 1
  FROM import_records
  WHERE source_record_id IS NOT NULL
  GROUP BY project_id, source_type, source_record_id
  HAVING COUNT(*) > 1
);
