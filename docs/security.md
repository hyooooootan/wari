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

## Gmail token and message handling

Gmail refresh tokens are encrypted with AES-256-GCM. D1 stores a 12-byte IV, key generation, and AAD version. AAD v1 binds the connection ID, user ID, and key generation. Decryption keys are read from `GMAIL_TOKEN_KEY_V<generation>` and the current generation from `GMAIL_TOKEN_KEY_CURRENT_GENERATION`. Keep prior generation secrets until stored ciphertext has been re-encrypted.

If an OAuth callback obtains a refresh token but cannot persist the connection, the token is sent to Google's revocation endpoint. A failed revocation creates a `gmail_revocation_retries` row whose AES-256-GCM AAD binds the retry ID, recorded owner user ID, and key generation. The owner identifier has no user foreign key so an administrative retry remains attributable after user deletion. The table is not exposed by application API routes. `retryGmailRevocations` retries these rows and connections in `disconnecting` state; successful processing erases ciphertext and IV while retaining non-secret completion metadata.

Gmail disconnection records `disconnecting` before contacting Google. Synchronization accepts `active` connections and active users, and its message/candidate write batch repeats both checks. A failed revocation leaves the encrypted token available for a later privileged retry. A successful revocation erases ciphertext and IV and records `disconnected`.

Gmail body text, HTML, attachments, authorization codes, access tokens, refresh tokens, cookies, OAuth state, PKCE verifiers, and encryption keys are not persisted in D1, returned in responses, or written to application logs. Access tokens exist in memory during synchronization. Message bodies and attachments are not sent to external generative AI or OCR services. Candidate rows contain structured fields such as merchant, amount, time, payment method, provider, and external transaction identifier.

Import targets are restricted to `project_type='household'` projects where the connection owner has an active direct `owner` role. Split projects, shared households, share links, candidates owned by another user, and projects owned by another user are rejected. Synchronization creates review candidates and never creates expenses automatically.

Candidate import and household-derived write batches reject users whose account deletion has started. Candidate edits use the previously read update timestamp and import state as conditional-write fields so a concurrent import remains imported and the edit receives a conflict response.
