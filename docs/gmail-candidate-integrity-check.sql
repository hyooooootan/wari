-- Read-only inspection for legacy Gmail candidates that need manual review.
SELECT
  c.id AS candidate_id,
  c.connection_id,
  c.user_id,
  c.status,
  c.merchant_name,
  c.amount,
  c.occurred_at,
  c.created_at,
  c.updated_at
FROM gmail_import_candidates AS c
WHERE c.imported_project_id IS NULL
  AND c.import_record_id IS NULL
  AND (
    c.amount IS NULL
    OR c.amount = 0
    OR trim(COALESCE(c.merchant_name, '')) = ''
  )
ORDER BY c.created_at, c.id;
