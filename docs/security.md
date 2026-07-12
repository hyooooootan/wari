# Security Notes

Authorization uses `project_user_roles`, separate from `project_members`. `project_members` remains the ledger participant table.

Project roles:

- `owner`: may manage shares and delete the project.
- `editor`: may create and change ledger records.
- `viewer`: may read project data.

Migration `0003_auth_ownership_shares.sql` assigns existing projects to `owner_unknown`. Because that user is marked deleted and no normal login can become it, migrated projects are hidden from normal project list APIs until an administrator assigns real ownership.

Share tokens are created as random bearer tokens and stored hashed in `project_shares.token_hash`. New raw tokens are returned once by share creation and are not written to `projects.share_token` or included in normal project list and graph responses. The legacy `projects.share_token` fields remain for migration compatibility when reading old share links. New share reads prefer the hashed table. Shares include role, expiry, and revocation fields. Rotating a share revokes active hashed shares for the project before creating the replacement and clears the legacy plaintext token for that project.

API protections:

- Authenticated API routes require a valid session.
- `POST /api/ocr-receipt` requires `project_id` and either a session with `editor` or `owner` project access, or an editor share bearer token for that project.
- Unsafe methods require `x-csrf-token` matching the session CSRF token and `wari_csrf` cookie.
- Unsafe cross-origin requests are rejected when the `Origin` header does not match `APP_ORIGIN`.
- JSON endpoints reject unsupported content types when a content type is present.
- Responses include `no-store` JSON caching and security headers.

Manual setup check:

1. Configure the Google OAuth client redirect URI to match `OAUTH_REDIRECT_URI`.
2. Store the Cloudflare secrets listed in `docs/auth.md`.
3. Apply D1 migrations locally before remote use.
4. Do not run remote D1 migrations from local development without an explicit release step.
