# Authentication

This application uses Google OAuth with `openid email profile`. Gmail scopes are not requested.

Cloudflare secrets and environment variables:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `APP_ORIGIN`
- `OAUTH_REDIRECT_URI`

Google identity is stored by `sub` in `users.google_sub`. Sessions use a random browser cookie value, while D1 stores `sessions.id_hash` instead of the raw session id. The session cookie is `Secure`, `HttpOnly`, `SameSite=Lax`, and `Path=/`. A separate `wari_csrf` cookie mirrors the session CSRF token so same-origin browser code can send `x-csrf-token` on unsafe methods.

OAuth state is stored as `oauth_states.state_hash`, and PKCE verifier storage is split between the HttpOnly OAuth cookie and `oauth_states.code_verifier_hash`. Callback codes and provider tokens are not stored in D1.

Routes:

- `GET /api/auth/session` returns the current user and CSRF token.
- `POST /api/auth/google/start` creates OAuth state and returns the Google authorization URL.
- `GET /api/auth/google/callback` exchanges the OAuth code, verifies the ID token, creates or updates the user, and creates a session.
- `POST /api/auth/logout` revokes the current session.
- `DELETE /api/account` marks the user deleted, revokes sessions, and revokes direct project roles.

Account deletion retains project data. A solely owned project remains stored after the owner's role is revoked, and an administrative recovery path for that project is not implemented. The deletion behavior does not transfer ownership or remove the retained project.

Local tests use `OAUTH_MOCK_USER_JSON` for provider callback tests when needed. Do not set this in production.

## Gmail payment notification connection

The Gmail connection is separate from login OAuth. It uses authorization code flow, S256 PKCE, a single-use state expiring after ten minutes, and `https://www.googleapis.com/auth/gmail.readonly`. Authorization requests use `access_type=offline` and `prompt=consent`.

Gmail connections and imports are available for an owner's personal household. A household with another active user role or an active, unexpired share cannot receive Gmail candidates. Synchronization selects one eligible household at the start in creation order and retains its project ID for the run. After Gmail retrieval, the selected household is revalidated with the same personal-household predicate inside the D1 batch that creates all message metadata and candidates for the run. If the predicate is no longer satisfied, the batch leaves no message or candidate from that run and records `gmail_personal_household_lost` as the run error. Retrieval or parsing failures before the batch can produce a partial run; a database failure rolls back every message and candidate prepared by that run. Candidate import uses the shared import path with a stable transaction identity so interrupted work can be retried. Message bodies, HTML, attachments, access tokens, refresh tokens, and encryption keys are not stored in import data or synchronization records.

Disconnect and account deletion revoke each Google grant before removing its encrypted refresh token. A provider failure leaves the ciphertext available for a later retry; an already-invalid grant is treated as revoked. OAuth errors consume a valid state and clear the OAuth cookie. `invalid_grant` and Gmail 401/403 responses mark the connection for reauthorization, while Gmail 429 responses stop the run as rate limited.

Create a separate OAuth client in Google Cloud and register `https://<application-host>/api/gmail/oauth/callback` as an authorized redirect URI. Configure Cloudflare Secrets `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_TOKEN_KEY_V1` (a Base64-encoded 32-byte key), and `GMAIL_TOKEN_KEY_CURRENT_GENERATION=1`. Set `GMAIL_REDIRECT_URI` where an explicit callback URI is required. Do not commit these values.

The implemented operation is user-initiated synchronization for 7, 30, or 90 days. Scheduled synchronization, notifications, tracking later email edits or deletion, and Google production verification are not implemented.
