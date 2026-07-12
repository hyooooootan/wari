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

Local tests use `OAUTH_MOCK_USER_JSON` for provider callback tests when needed. Do not set this in production.
