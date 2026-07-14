# Meta OAuth Start Redirect and LINE Credential Help

## Context

Production receives `POST /api/platform-connections/meta/start`, but the browser remains on Settings and the client collapses every failure in `fetch -> response.json() -> window.location.assign()` into one generic message. The server already creates an owner-scoped, expiring OAuth transaction and returns a Meta authorization URL.

The LINE connection succeeds, but the credential form does not explain where each value comes from. LINE's current documentation places both Channel ID and Channel secret under the Messaging API Channel's **Basic settings** tab. New Messaging API channels can no longer be created directly in LINE Developers Console; users first create or enable Messaging API for a LINE Official Account, then manage the resulting channel in the console.

## Goals

- Make Connect Meta use browser-native POST/redirect navigation instead of an asynchronous client-side navigation handoff.
- Preserve authentication, owner scoping, same-origin CSRF protection, opaque OAuth state, safe return paths, and secret redaction.
- Return a failed Meta start to Publishing platforms with a safe actionable notice.
- Add concise, accessible instructions for obtaining LINE Channel ID and Channel secret.
- Keep Channel access token issuance, storage, renewal, and revocation automatic and server-side.

## Non-goals

- Do not perform a real Meta OAuth authorization or change Meta App settings.
- Do not call LINE, issue a token, publish content, or change an external channel.
- Do not expose Meta App secret, LINE Channel secret, access tokens, provider errors, or database details.
- Do not change Page selection, immutable scheduled-post bindings, or token lifecycle behavior.

## Approaches Considered

### 1. Native POST followed by server 303 redirect (selected)

The Connect Meta control submits a normal same-origin form. The server creates the OAuth transaction and returns a `303 See Other` to the Meta authorization URL. This removes response parsing and imperative browser navigation from the critical path and follows the POST/Redirect/GET pattern.

### 2. Keep fetch and add more client diagnostics

This would identify more client failure states but retain the handoff that is currently failing. It is useful as observability, not as the primary correction.

### 3. Open Meta in a popup or new tab

An async fetch makes popup blocking likely, complicates focus and accessibility, and introduces cross-window state. This is not appropriate for the core OAuth path.

## Meta Flow Design

1. Settings renders Connect Meta as a native POST form targeting `/api/platform-connections/meta/start`.
2. The form includes only the validated return path `/settings?tab=publishing`. It never contains provider credentials.
3. The route continues to require an authenticated owner and exact same origin before creating any service or OAuth transaction.
4. For a form submission, the route starts Meta OAuth and responds with `303` to the generated `https://www.facebook.com/.../dialog/oauth` URL.
5. The existing JSON start behavior remains available for compatibility and unit isolation; the form path is selected only for `application/x-www-form-urlencoded` input.
6. A start failure redirects to `/settings?tab=publishing&meta=start_error`. No internal error text is placed in the URL.
7. Settings consumes the safe query flag, shows the existing actionable message, and removes the flag from browser history so refresh does not repeat it.

## LINE Help Design

The help appears inside the LINE card when its credential form is open. A native disclosure (`details`/`summary`) keeps the default card compact and keyboard accessible. The expanded content uses a short ordered list:

1. Sign in to [LINE Developers Console](https://developers.line.biz/).
2. Select the Provider and its **Messaging API** Channel. If none exists, create a LINE Official Account and enable Messaging API first, then return to the console.
3. Open **Basic settings**. Copy **Channel ID** and **Channel secret** from that tab.
4. Paste those two values into Settings. Do not paste or manually issue a Channel access token; this application manages it automatically.

External links open in a new tab with `rel="noreferrer noopener"`. Secret inputs keep password masking and existing autocomplete restrictions.

References:

- https://developers.line.biz/en/docs/messaging-api/getting-started/
- https://developers.line.biz/en/faq/
- https://developers.line.biz/en/docs/messaging-api/verify-webhook-signature/

## Error Handling and Security

- Form and JSON requests both retain exact-origin validation before service initialization.
- Only an HTTPS Meta authorization URL produced by the Meta service may be used as the external redirect.
- Start failures return to a fixed same-origin Settings path with an opaque error category.
- The UI never renders raw API response details for 5xx errors.
- OAuth transaction payloads and platform credentials remain encrypted and owner scoped.

## Tests and Verification

- Route test: a same-origin form POST produces a `303` to the Meta authorization URL and passes only owner plus safe return path to the service.
- Route test: cross-origin form POST is rejected before service initialization.
- Route test: a start failure redirects only to the fixed Settings error URL and does not leak the error message.
- Compatibility test: JSON Meta start continues returning `{ authorizeUrl }`.
- UI test: Connect Meta renders a native form targeting the start route.
- UI test: the LINE disclosure contains the official console link, Basic settings guidance, Channel ID, Channel secret, and automatic-token explanation.
- Focused tests, full test suite, production build, conflict-marker scan, and diff check must pass.
- Browser visual QA checks the disclosure at desktop and narrow viewport widths when a usable local authenticated backend is available. If authentication prevents browser QA, record that limitation and rely on structural/source assertions plus build verification.

## Scope and Atomic Release

Meta navigation reliability and LINE credential guidance are one **Settings > Publishing platforms** onboarding improvement drawn from the same production feedback. They share the same user-facing Settings surface, release, and QA pass, and neither requires a separate schema or configuration rollout. This is the product-level reason to ship them atomically in one PR; it does not imply that the Meta and LINE implementations are technically coupled.

## Rollout

Ship through a new branch and pull request as one Settings > Publishing platforms onboarding improvement. The change requires a Vercel deployment but no database migration, schema change, or additional configuration rollout. Production smoke testing must not complete a real Meta authorization or send a LINE message without separate explicit approval.
