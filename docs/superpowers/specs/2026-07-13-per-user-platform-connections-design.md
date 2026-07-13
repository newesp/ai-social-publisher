# Per-user Meta and LINE platform connections

## Goal

Every Google SSO user connects and publishes to their own Meta Page and LINE Official Account. Platform credentials are encrypted per user, never returned by the API, and platform checkboxes are only available after a valid connection exists. No administrator manages another user's Page or Channel token. A scheduled target is permanently bound to the connection selected when it is created; changing a default connection never redirects an existing scheduled post.

## Scope and constraints

- Existing user-scoped encrypted settings remain the credential store for AI settings and selected default connection IDs. A dedicated, encrypted per-user connection record stores each platform credential set so a scheduled post can retain its selected account after the user changes their default.
- The service needs one Meta OAuth App (`META_APP_ID`, `META_APP_SECRET`, and a callback URL). These are service integration credentials, not a user's Page credentials.
- Meta users authorize their own account, choose exactly one Page, and the application stores that Page's ID and access token for that user.
- A normal LINE Login cannot grant control of a Messaging API Channel. Each user must make a one-time connection by supplying the Channel ID and Channel Secret for their own existing Messaging API Channel. The application, not the user, issues and rotates its Channel Access Token.
- LINE uses the documented client-credentials short-lived-token endpoint. The application automatically reissues a token before it expires; it never displays or asks users to paste a token.
- Actual OAuth, token issuance, and publishing remain user-initiated or server-side operations only. No external Page, Channel, or production configuration is changed during development.

## User experience

### Settings > Publishing platforms

1. The page loads connection cards for Meta and LINE, with a concise status: not connected, connected, needs reconnection, or connecting.
2. Selecting **Connect Meta** opens the Meta OAuth flow. On return, the user sees a picker containing only Pages they can manage and selects one.
3. Completing the choice returns to settings with the selected Page name and a connected status. Raw Page tokens are never displayed.
4. Selecting **Connect LINE Official Account** opens a short explanation and a two-field form for Channel ID and Channel Secret. This is the only manual LINE credential step; users do not create, copy, or rotate Channel Access Tokens.
5. The server verifies the supplied LINE Channel credentials by issuing a token, stores it encrypted, and presents a connected status with the next renewal time.
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

- non-secret fields: connection ID, owner email, platform, display name, state (`active`, `archived`, `needs_reconnect`), created and updated times
- encrypted Meta fields: Page ID, Page name, Page Access Token, long-lived User Access Token, User Token expiry, and connection time
- encrypted LINE fields: Channel ID, Channel Secret, Channel Access Token, Token expiry, and connection time

User settings retain only `metaDefaultConnectionId` and `lineDefaultConnectionId`. Add `platform_connection_id` to `post_targets`, referencing the immutable connection chosen at post creation. `metaPageId` and `metaPageName` are safe to return in connection status. Token values, channel secrets, and expiry implementation details are never returned. A derived connection-status endpoint returns only platform, state, display name, and optional reconnection guidance.

### Meta OAuth

1. An authenticated user calls the start endpoint.
2. The server creates a short-lived signed state bound to that user and redirects to Meta OAuth with the Page-read and Page-post scopes.
3. The callback validates state, exchanges the authorization code for a user token, exchanges it for a long-lived token, and retrieves manageable Pages.
4. The callback stores the pending, server-side Page list and routes the user to a safe in-app Page selection screen.
5. The selection endpoint confirms that the Page belongs to the pending list, creates a new encrypted connection record, and makes it the current user's default Meta connection. A previous default becomes archived rather than being overwritten.
6. Before publish and during a background renewal pass, the service validates credentials. It refreshes recoverable Meta credentials using retained authorization data. If Meta rejects or revokes authorization, it marks the connection as needing reconnection rather than publishing with stale credentials.

### LINE token lifecycle

1. The authenticated user submits their Channel ID and Secret only over the connection endpoint.
2. The server calls LINE's client-credentials endpoint to issue a short-lived Channel Access Token, records its expiry, creates an encrypted connection record, and makes it the user's default LINE connection.
3. Before publish and in a scheduled renewal pass, the service reissues a token when it is near expiry and atomically replaces the encrypted token in the same connection record.
4. If issuance fails because Channel credentials are invalid or have been revoked, that connection becomes `needs_reconnect`; publishing is blocked for targets bound to it until the user reconnects that account.

### Publishing and scheduling

- Create-post validation accepts only platforms with an active default connection for the caller. Server-side validation prevents forged API requests from targeting disconnected platforms.
- At creation, each selected target stores the current connection ID. Immediate publishing and scheduled publishing load credentials by that immutable target connection ID, not by the user's current default.
- Changing a Page or LINE Channel affects only posts created after the change. An archived connection remains encrypted and eligible for renewal until every target that references it reaches a terminal status or is cancelled.
- A renewal failure is represented as a safe, generic publish failure and never exposes credentials or provider response bodies.

## Security and error handling

- All OAuth state is single-use, time-limited, user-bound, and checked before token exchange.
- Server-only environment variables hold Meta OAuth App credentials. No `NEXT_PUBLIC_` credential is added.
- Per-user tokens and LINE Channel secrets use the existing AES-GCM settings encryption.
- APIs return masked connection status only; errors are generic and redact secrets.
- Reconnection never overwrites another user's settings.

## Testing

- Unit tests cover OAuth state validation, Meta code/token/Page selection flow, LINE token issuance and renewal, invalid credential handling, and no-secret API responses.
- UI tests cover connection-state cards and visibility/default selection of Step 1 platform checkboxes.
- Publishing tests verify that disconnected platforms are rejected, targets receive an immutable connection ID at creation, and scheduled jobs renew and publish through that target's connection rather than the owner's current default.
- Run the existing test suite and production build; no live provider call is part of automated verification.

## External setup required before real use

- Configure the service's Meta OAuth App ID, App Secret, and registered callback URL; Meta permissions and App Review requirements apply outside development mode.
- Every user connects a Page they manage through Meta OAuth.
- Every LINE user must already own or have access to a Messaging API Channel and enter its Channel ID and Secret once. LINE Login alone is not sufficient for Messaging API broadcasting.
