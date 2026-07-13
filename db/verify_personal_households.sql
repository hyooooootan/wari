SELECT COUNT(*) AS applied_migrations
FROM d1_migrations;

SELECT CASE
  WHEN EXISTS (
    SELECT 1 FROM sqlite_master
    WHERE type = 'table' AND name = 'shared_household'
  ) THEN 1 ELSE 0
END AS shared_household_table_exists;

SELECT id, project_type, owner_user_id
FROM projects
WHERE project_type NOT IN ('split', 'household')
   OR (project_type = 'household' AND (owner_user_id IS NULL OR owner_user_id = ''))
ORDER BY id;

SELECT owner_user_id, COUNT(*) AS household_count
FROM projects
WHERE project_type = 'household'
GROUP BY owner_user_id
HAVING COUNT(*) > 1
ORDER BY owner_user_id;

SELECT roles.project_id, roles.user_id, roles.role, roles.revoked_at
FROM project_user_roles roles
JOIN projects ON projects.id = roles.project_id
WHERE projects.project_type = 'household'
ORDER BY roles.project_id, roles.user_id;

SELECT shares.project_id, shares.id, shares.role, shares.expires_at, shares.revoked_at
FROM project_shares shares
JOIN projects ON projects.id = shares.project_id
WHERE projects.project_type = 'household'
ORDER BY shares.project_id, shares.id;

SELECT connections.id, connections.user_id, connections.household_project_id
FROM gmail_connections connections
LEFT JOIN projects
  ON projects.id = connections.household_project_id
WHERE projects.id IS NULL
   OR projects.project_type <> 'household'
   OR projects.owner_user_id <> connections.user_id
ORDER BY connections.id;

PRAGMA foreign_key_check;
