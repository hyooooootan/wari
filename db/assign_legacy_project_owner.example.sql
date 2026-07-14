BEGIN;

CREATE TEMP TABLE _legacy_owner_handoff_guard (
  check_name TEXT PRIMARY KEY,
  ok INTEGER NOT NULL CHECK (ok = 1)
);

INSERT INTO _legacy_owner_handoff_guard (check_name, ok)
SELECT 'new_user_exists_and_active',
       CASE WHEN EXISTS (
         SELECT 1 FROM users
         WHERE id = '__NEW_USER_ID__'
           AND id <> 'owner_unknown'
           AND deleted_at IS NULL
           AND deletion_started_at IS NULL
       ) THEN 1 ELSE 0 END;

INSERT INTO _legacy_owner_handoff_guard (check_name, ok)
SELECT 'target_project_exists',
       CASE WHEN EXISTS (
         SELECT 1 FROM projects WHERE id = 'prj_mrbhik3r_b9ku'
       ) THEN 1 ELSE 0 END;

INSERT INTO _legacy_owner_handoff_guard (check_name, ok)
SELECT 'current_owner_is_owner_unknown',
       CASE WHEN (
         (
           SELECT COUNT(*) FROM project_user_roles
           WHERE project_id = 'prj_mrbhik3r_b9ku'
             AND user_id = 'owner_unknown'
             AND role = 'owner'
             AND revoked_at IS NULL
         ) = 1
         AND
         (
           SELECT COUNT(*) FROM project_user_roles
           WHERE project_id = 'prj_mrbhik3r_b9ku'
             AND user_id = '__NEW_USER_ID__'
             AND role = 'owner'
             AND revoked_at IS NULL
         ) = 0
       ) OR (
         (
           SELECT COUNT(*) FROM project_user_roles
           WHERE project_id = 'prj_mrbhik3r_b9ku'
             AND user_id = 'owner_unknown'
             AND role = 'owner'
             AND revoked_at IS NULL
         ) = 0
         AND
         (
           SELECT COUNT(*) FROM project_user_roles
           WHERE project_id = 'prj_mrbhik3r_b9ku'
             AND user_id = '__NEW_USER_ID__'
             AND role = 'owner'
             AND revoked_at IS NULL
         ) = 1
       ) THEN 1 ELSE 0 END;

INSERT INTO _legacy_owner_handoff_guard (check_name, ok)
SELECT 'new_user_has_no_conflicting_role',
       CASE WHEN NOT EXISTS (
         SELECT 1 FROM project_user_roles
         WHERE project_id = 'prj_mrbhik3r_b9ku'
           AND user_id = '__NEW_USER_ID__'
           AND NOT (role = 'owner' AND revoked_at IS NULL)
       ) THEN 1 ELSE 0 END;

INSERT INTO project_user_roles (
  project_id, user_id, role, created_at, updated_at, revoked_at
)
SELECT 'prj_mrbhik3r_b9ku', '__NEW_USER_ID__', 'owner',
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL
WHERE NOT EXISTS (
  SELECT 1 FROM project_user_roles
  WHERE project_id = 'prj_mrbhik3r_b9ku'
    AND user_id = '__NEW_USER_ID__'
);

UPDATE project_user_roles
SET role = 'owner', revoked_at = NULL,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE project_id = 'prj_mrbhik3r_b9ku'
  AND user_id = '__NEW_USER_ID__';

UPDATE project_user_roles
SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE project_id = 'prj_mrbhik3r_b9ku'
  AND user_id = 'owner_unknown'
  AND role = 'owner'
  AND revoked_at IS NULL;

INSERT INTO _legacy_owner_handoff_guard (check_name, ok)
SELECT 'exactly_one_active_owner',
       CASE WHEN (
         SELECT COUNT(*) FROM project_user_roles
         WHERE project_id = 'prj_mrbhik3r_b9ku'
           AND role = 'owner'
           AND revoked_at IS NULL
       ) = 1 THEN 1 ELSE 0 END;

INSERT INTO _legacy_owner_handoff_guard (check_name, ok)
SELECT 'new_user_is_active_owner',
       CASE WHEN EXISTS (
         SELECT 1 FROM project_user_roles
         WHERE project_id = 'prj_mrbhik3r_b9ku'
           AND user_id = '__NEW_USER_ID__'
           AND role = 'owner'
           AND revoked_at IS NULL
       ) THEN 1 ELSE 0 END;

DROP TABLE _legacy_owner_handoff_guard;
COMMIT;
