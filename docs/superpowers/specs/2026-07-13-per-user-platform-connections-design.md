# Per-user Meta and LINE platform connections

## Goal

Every Google SSO user connects and publishes to their own Meta Page and LINE Official Account. Platform credentials are encrypted per user, never returned by the API, and platform checkboxes are only available after a valid connection exists. No administrator manages another user's Page or Channel token. A scheduled target is permanently bound to the connection selected when it is created; changing a default connection never redirects an existing scheduled post.

## Scope and constraints

- Existing user-scoped encrypted settings remain the credential store for AI settings and selected default connection IDs. A dedicated, encrypted per-user connection record stores each platform credential set so a scheduled post can retain its selected account after the user changes their default.
- The service needs one Meta OAuth App (`META_APP_ID`, `META_APP_SECRET`, and a callback URL). These are service integration credentials, not a user's Page credentials.
- Meta users authorize their own account, choose exactly one Page, and the application stores that Page's ID and access token for that user.
- A normal LINE Login cannot grant control of a Messaging API Channel. Each user must make a one-time connection by supplying the Channel ID and Channel Secret for their own existing Messaging API Channel. The application, not the user, issues and rotates its Channel Access Token.
- LINE uses the documented client-credentials short-lived-token endpoint. The application automatically reissues a token before it expires; it never displays or asks users to paste a token.
- Meta refresh is best effort, not a promise of permanent silent renewal. A revoked Page permission or a User Token that Meta will no longer extend requires the user to reconnect through OAuth.
- Actual OAuth, token issuance, and publishing remain user-initiated or server-side operations only. No external Page, Channel, or production configuration is changed during development.

## User experience

### Settings > Publishing platforms

1. The page loads connection cards for Meta and LINE, with a concise status: not connected, connected, auto-renewing, needs reconnection, or connecting. Every signed-in account—not only admins—can connect, change, or disconnect its own platforms.
2. Selecting **Connect Meta** opens the Meta OAuth flow. On return, the user sees a picker containing only Pages they can manage and selects one.
3. Completing the choice returns to settings with the selected Page name and a connected status. Raw Page tokens are never displayed.
4. Selecting **Connect LINE Official Account** opens a short explanation and a two-field form for Channel ID and Channel Secret. This is the only manual LINE credential step; users do not create, copy, or rotate Channel Access Tokens.
5. The server verifies the supplied LINE Channel credentials by issuing a token and reading the Official Account identity, stores it encrypted, and presents the verified account name plus a non-secret expiry/auto-renewal status.
6. A **Change account** action validates a new Page or Channel before making it the default for future posts. It archives the prior connection instead of overwriting it.
7. A **Disconnect** action affects only the current signed-in user. If pending scheduled posts reference the connection, the user must either keep the connection until they complete or cancel those posts; the application must not silently redirect them. Once no pending targets reference it, the application revokes a LINE token when practical and removes local credentials. Meta disconnect removes local credentials and asks the user to revoke app access in Meta if desired.

### Create post > Step 1

1. On opening the wizard, the client requests the signed-in user's connection availability.
2. Meta and LINE checkboxes are rendered only for valid connected platforms.
3. No connection shows an inline call to action that routes to Publishing platforms, rather than an empty or broken checkbox group.
4. The initial selected platforms are the connected default platforms, avoiding draft or publish requests for disconnected channels.
5. At submission, every selected target is bound server-side to the user's current connection for that platform. The user does not need to choose an account in the wizard unless multiple active connections are supported in a later iteration.

## Backend design

### Connection record

Add an encrypted `platform_connections` store, with one record per owner, platform, and connected account:

- non-secret fields: connection ID, owner email, platform, display name, state (`active`, `legacy`, `archived`, `needs_reconnect`), created and updated times
- encrypted Meta fields: Page ID, Page name, Page Access Token, long-lived User Access Token, User Token expiry, and connection time
- encrypted LINE fields: Channel ID, Channel Secret, Channel Access Token, Token expiry, and connection time

User settings retain only `metaDefaultConnectionId` and `lineDefaultConnectionId`. Add `platform_connection_id` to `post_targets`, referencing the immutable connection chosen at post creation. `metaPageId` and `metaPageName` are safe to return in connection status. Token values and secret values are never returned. A derived connection-status endpoint returns only platform, state, display name, optional expiry status, and reconnection guidance.

The database design is explicit:

- `platform_connections`: random opaque ID; owner email; platform; display name; state; encrypted credentials; credential-expiry time; created and updated timestamps. Index owner/platform/state and enforce that a default connection belongs to the same owner and platform.
- `post_targets.platform_connection_id`: nullable during the migration only, then a foreign key to `platform_connections`. Reads and writes must join on both target owner and connection owner; possession of a connection ID alone never authorizes access.
- `oauth_transactions`: opaque ID; owner email; provider; encrypted pending Meta Page list and tokens; safe return path; expiry; consumed timestamp. Transactions expire after ten minutes and are single use.

Connection-status responses may include the non-secret `expiresAt` timestamp so the UI can say that renewal is automatic. They never include any token, client secret, channel secret, or OAuth pending data. This release keeps normalized, verified Google email as the ownership key to match the existing posts and settings schema; a future migration to Google subject (`sub`) is explicitly out of scope.

### Meta OAuth

1. An authenticated user calls the start endpoint.
2. The server creates a short-lived, single-use state bound to that user and a safe local return path, then redirects to Meta OAuth (Graph API `v25.0`) with `pages_show_list`, `pages_read_engagement`, and `pages_manage_posts`.
3. The callback handles provider cancellation and errors with a settings-page explanation. On success it validates and consumes state, exchanges the authorization code for a User Token, exchanges it for a long-lived User Token, and retrieves manageable Pages.
4. The callback stores the pending Page list and tokens only in the encrypted, ten-minute `oauth_transactions` record, then routes the user to a safe in-app Page selection screen.
5. The selection endpoint confirms that the Page belongs to the pending list, creates a new encrypted connection record, and makes it the current user's default Meta connection. A previous default becomes archived rather than being overwritten.
6. Before publish and during a background renewal pass, the service validates credentials. It exchanges retained User authorization only while Meta permits it; a Page Token may also be invalidated by revoked access or changed permissions. If the token cannot be renewed or Meta rejects it, the connection becomes `needs_reconnect` and the user receives a clear reconnect action rather than a false promise of silent recovery.

### LINE token lifecycle

1. The authenticated user submits their Channel ID and Secret only over the connection endpoint.
2. The server sends `application/x-www-form-urlencoded` credentials to `POST https://api.line.me/v2/oauth/accessToken` with `grant_type=client_credentials`, `client_id`, and `client_secret`. It records the returned short-lived Token and `expires_in` (30 days), then calls `GET /v2/bot/info` to confirm the Official Account identity before creating the encrypted connection record and making it the user's default.
3. Before publish and in a scheduled renewal pass, the service reissues a Token when it has 72 hours or less remaining. Rotation is compare-and-swap/transaction protected: a concurrent cron or publish worker reuses the winning refreshed record rather than issuing duplicate Tokens.
4. If renewal fails while the existing Token remains valid, publishing may use that still-valid Token and report a recoverable renewal warning. If the Token is expired or LINE rejects a send, the connection becomes `needs_reconnect`; the target fails safely until the user reconnects that account.

### Publishing and scheduling

- Create-post validation accepts only platforms with an active default connection for the caller. Server-side validation prevents forged API requests from targeting disconnected platforms.
- At creation, each selected target stores the current connection ID. Immediate publishing and scheduled publishing load credentials by that immutable target connection ID, not by the user's current default.
- Changing a Page or LINE Channel affects only posts created after the change. An archived connection remains encrypted and eligible for renewal until every target that references it reaches a terminal status or is cancelled.
- Target connection binding and creation occur in the same database transaction. The publish path refuses a stale or disconnected client request even if the browser still showed the checkbox.
- A renewal failure is represented as a safe, generic publish failure and never exposes credentials or provider response bodies.

## Security and error handling

- All OAuth state is single-use, time-limited, user-bound, and checked before token exchange.
- Connection and LINE credential endpoints require an authenticated owner session, same-origin request protection, and must never log submitted secrets or provider token responses.
- Server-only environment variables hold Meta OAuth App credentials. No `NEXT_PUBLIC_` credential is added.
- Per-user tokens and LINE Channel secrets use the existing AES-GCM settings encryption.
- APIs return masked connection status only; errors are generic and redact secrets.
- Reconnection never overwrites another user's settings.

## Legacy migration and credential precedence

1. There is no shared environment-variable fallback for publishing after this feature ships. `META_PAGE_ID`, `META_PAGE_ACCESS_TOKEN`, and `LINE_CHANNEL_ACCESS_TOKEN` are removed from the application runtime contract and `.env.example`.
2. An idempotent migration converts a user's existing encrypted `metaPageId` plus `metaPageAccessToken` into that user's Meta connection and marks it `legacy` until they complete OAuth. It remains usable only while provider validation succeeds; reconnecting upgrades it to managed automatic renewal.
3. An existing `lineChannelAccessToken` is verified with `GET /v2/bot/info`. If valid, it becomes a `legacy` LINE connection and remains usable until expiry; because it lacks Channel ID and Secret, the UI asks the user to reconnect to enable automatic renewal. If validation fails, it becomes `needs_reconnect` and is not offered in Step 1.
4. Migration never copies credentials between owners. Legacy fields remain encrypted for one release only, then are purged after the migrated connection is confirmed; all new publishing reads connection IDs exclusively.

## Testing

- Unit tests cover OAuth state validation, cancellation, expiry and owner isolation; Meta code/token/Page selection and reconnect behavior; LINE issuance at the pinned endpoint, Official Account identity verification, 72-hour renewal, concurrent rotation, and invalid credential handling; and no-secret API responses.
- UI tests cover connection-state cards and visibility/default selection of Step 1 platform checkboxes.
- Publishing tests verify that disconnected or stale UI platforms are rejected, targets receive an immutable connection ID in the create transaction, scheduled jobs renew and publish through that target's connection rather than the owner's current default, and legacy credentials cannot fall back to a shared environment value.
- Authorization and regression tests verify that any signed-in user can manage only their own platform connections and that no UI text or API guard retains the former admin-only token-management policy.
- Run the existing test suite and production build; no live provider call is part of automated verification.

## External setup required before real use

- Configure the service's Meta OAuth App ID, App Secret, and registered callback URL; Meta permissions and App Review requirements apply outside development mode.
- Every user connects a Page they manage through Meta OAuth.
- Every LINE user must already own or have access to a Messaging API Channel and enter its Channel ID and Secret once. LINE Login alone is not sufficient for Messaging API broadcasting.
