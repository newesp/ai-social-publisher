# Task 5: Secure LINE webhook ingestion report

## Scope and external-state boundary

- Worktree: `E:\Leo\Projects\Auto-posting\.worktrees\line-ai-customer-support`
- Starting HEAD observed: `35e1596ea88ee850d47b35a9b455e506133ab1e8`
- No remote database migration, deployment, real LINE request, LLM request, or real credential was used.
- The existing schema already had the encrypted identity/reply-token columns and unique connection/event and connection/customer-lookup constraints; no migration was changed.

## Implementation

- Added a raw-body LINE webhook handler and thin public route.
- The handler hashes the opaque key, resolves only an active LINE connection, reads `request.text()` exactly once, verifies the signature before parsing, and returns fixed allowlisted responses.
- User events are transactionally claimed by the unique `(platform_connection_id, webhook_event_id)` key before conversation/message persistence and workflow start. Duplicate and concurrent duplicate deliveries do not start a second workflow.
- LINE customer IDs use the existing connection-scoped HMAC plus AES-256-GCM encryption. Reply tokens use a distinct AES-256-GCM payload purpose.
- Group/room events retain only safe event identity/source/status/time fields. Non-text user messages retain bounded metadata and put the conversation in `waiting_human` with `non_text` handoff reason.
- A new inbound message cancels only its own conversation's pending transition.
- The public workflow contract is `lineMessageWorkflow({ eventId, connectionId, conversationId })`; no raw message, provider token, reply token, or external identifier is passed.

## TDD evidence

### RED

1. `node --test tests/support-line-webhook.test.js`
   - Expected failure: `ERR_MODULE_NOT_FOUND` for `src/lib/support/routes/line-webhook-handler.js`.
2. `node --test tests/support-repository.test.js`
   - Expected failure: `TypeError: repository.ingestLineUserEvent is not a function`.
3. After explicit user approval for the build-contract shell: `node --test tests/support-line-webhook.test.js`
   - Expected failure: `ERR_MODULE_NOT_FOUND` for `src/lib/support/workflows/line-message-workflow.js`.

### GREEN / focused

`node --test tests/support-line-webhook.test.js tests/support-repository.test.js`

- Exit 0; 19 tests passed, 0 failed.
- Includes raw-body ordering/single consumption, invalid key/signature, malformed payload, empty events, group/room exclusion, encrypted persistence, non-text handoff, transition scoping, cross-connection customer separation, duplicate/concurrent duplicate behavior, and the safe workflow input boundary.

## Final verification

1. Full suite: `npm.cmd test`
   - Exit 0; 370 tests passed, 0 failed.
2. Production build (only command-scoped disposable demo values):
   - `AUTH_MODE=demo`, `SETTINGS_ENCRYPTION_KEY=build-only-support-key`, `TURSO_DATABASE_URL=libsql://build.invalid`, `TURSO_AUTH_TOKEN=build-only-token`, `BLOB_READ_WRITE_TOKEN=build-only-blob-token`, then `npm.cmd run build`.
   - Exit 0; production build compiled and includes `/api/webhooks/line/[webhookKey]`.
   - Warnings were limited to the pre-existing multi-lockfile workspace-root inference and Next.js middleware deprecation.
3. `git diff --check`
   - Exit 0; no whitespace errors.
4. Review and scans
   - Reviewed every changed/untracked source and test file.
   - Debug scan (`console.*`, `debugger`, `TODO`, `FIXME`): no matches.
   - Credential-literal scan (private keys, common provider token prefixes): no matches.
   - Source PII-fixture scan: no matches in `src`.

## Approved early workflow shell

The Task 5 route must start `lineMessageWorkflow`, while the durable workflow implementation is scheduled for Task 7. The user explicitly approved adding the smallest build-contract shell early. It accepts and returns only `{ eventId, connectionId, conversationId }` and has no LINE, LLM, database, batching, retrieval, AI, or reply side effects. Task 7 remains responsible for replacing its body with durable message processing while preserving this safe argument boundary.

## Remaining external prerequisites

- No live webhook, Workflow deployment, or dedicated LINE-account smoke test was performed; each requires separate explicit authorization and test resources.

## Review-fix addendum: recoverable workflow dispatch and timestamp schema

An independent review identified that a persisted unique event could be permanently skipped when the first Workflow start failed. The root cause was that `inserted: false` duplicates were acknowledged without a dispatch state or re-claim path. It also identified that a finite but unusable timestamp could reach repository validation and produce `503` rather than public schema `400`.

### RED evidence

`node --test tests/support-line-webhook.test.js tests/support-repository.test.js`

- Exit 1 before the fix.
- Verified timestamp `100000000000000000000` incorrectly returned `200` in the handler harness.
- Verified the reviewer sequence: first delivery `503`, second delivery `200`, workflow starts `1` instead of the required retry start `2`.
- The repository claim test failed with `TypeError: repository.claimLineWorkflowDispatch is not a function`.

### Fix

- Existing `support_webhook_events` fields now implement a migration-free outbox/dispatch state:
  - `processing_status`: `queued` → `dispatching` → `dispatched`, or `retryable` after start failure.
  - `processed_at`: a 30-second lease expiration while `dispatching`, then the actual dispatched timestamp.
  - `safe_error_code`: an opaque UUID claim ID while dispatching; compare-and-set completion/release prevents a stale claimant from overwriting a newer reclaim.
- Every delivery, including a duplicate, attempts an atomic claim. Only the successful claim invokes `startWorkflow`; success marks it dispatched and failure releases it as retryable before returning a fixed `503`.
- Expired dispatch leases are atomically reclaimable; concurrent redeliveries cannot both claim the same event.
- Handler timestamp validation now requires a positive safe integer in `1..8640000000000000`, and a valid JavaScript Date, before any persistence call.

### GREEN / final verification

1. Focused coverage: `node --test tests/support-line-webhook.test.js tests/support-repository.test.js`
   - Exit 0; 24 tests passed, 0 failed.
   - Covers failed-start redelivery retry, concurrent retry claim, durable claim/release/complete, stale lease reclaim, stale release fencing, and timestamp lower/upper/fractional boundaries.
2. Full suite: `npm.cmd test`
   - Exit 0; 375 tests passed, 0 failed.
3. Production build with the same command-scoped disposable demo values documented above: `npm.cmd run build`
   - Exit 0; compiled and includes `/api/webhooks/line/[webhookKey]`.
4. No migration or live LINE/LLM/database/deployment action was used.

### Final completion-record guard

One additional RED/GREEN cycle covered the case where `startWorkflow` succeeds but the compare-and-set `dispatched` write does not report success. Before the guard, the handler returned `200`; it now returns the same bounded `503` retryable response rather than acknowledging an unrecorded dispatch.

- Focused command: `node --test tests/support-line-webhook.test.js tests/support-repository.test.js`
  - Exit 0; 25 tests passed, 0 failed.
- Fresh full suite: `npm.cmd test`
  - Exit 0; 376 tests passed, 0 failed.
- Fresh production build with the disposable command-scoped demo values
  - Exit 0; build passed.

## User-approved at-least-once dispatch / exactly-once processing amendment

The owner explicitly approved the reliability amendment in `.superpowers/sdd/task-5-brief.md`. The dispatcher retains recoverable at-least-once behavior: an ambiguous successful Workflow start plus a failed completion write can later create another Workflow run. Customer-visible processing is instead fenced in the first durable Workflow step.

### Implementation

- `lineMessageWorkflow` now has a first `"use step"` that atomically claims the persisted LINE webhook event before invoking the next processing hook.
- The existing event fields represent the execution state after dispatch: `dispatched` → `processing` → `processed`.
- A processing lease is stored in `processed_at`; an opaque UUID claim token is stored in `safe_error_code`. Completion and release compare that token, so stale runs cannot overwrite a newer claimant.
- A duplicate run exits `{ status: "duplicate" }` before the hook. A hook failure releases its claim back to `dispatched`; a completed event cannot be claimed again.
- The production hook is deliberately a no-op. No batching, retrieval, LLM request, LINE action, handoff, or customer-visible persistence was added; Task 7 supplies that downstream hook later.

### RED / GREEN evidence

RED command: `node --test tests/support-line-webhook.test.js tests/support-repository.test.js`

- Exit 1 before the amendment implementation: `createLineMessageWorkflow` export was absent and `repository.claimLineEventProcessing` was not a function.

GREEN command: `node --test tests/support-line-webhook.test.js tests/support-repository.test.js`

- Exit 0; 28 tests passed, 0 failed.
- Two duplicate durable runs yield one `processed` and one `duplicate` result, with one downstream-hook call.
- A controlled downstream failure releases the first claim; retry succeeds; a completed event is rejected without another hook call.
- Repository coverage confirms atomic claim, duplicate fencing, release, retry, and final completion persistence.

### Final verification

- `npm.cmd test`: exit 0; 379 tests passed, 0 failed.
- `npm.cmd run build` using the documented command-scoped disposable demo values: exit 0.
- No migration, live LINE/LLM/database call, deployment, batching, retrieval, or delivery action was performed.

## Transactional outbound-delivery amendment

The approved delivery-reliability prerequisite is implemented as the smallest reusable seam; Task 7 remains responsible for decision generation and the production caller that supplies connection credentials.

### Durable contract

- Migration `0005_line_outbound_delivery_outbox` adds `support_outbound_deliveries`, keyed once per inbound webhook-event row. It persists a canonical RFC 4122 UUID retry key, encrypted recipient, encrypted exact canonical Push JSON body, claim lease, attempt timestamps, retry time, terminal status, acceptance ID, and review timestamp.
- Creation requires the active durable event-processing claim. On a later claimant after lease expiry, the event-unique constraint returns the original delivery ID/retry key and never overwrites the originally encrypted recipient or body.
- Delivery claims are fenced with their own 30-second lease. The first attempt starts the 24-hour review window. Expired uncertain work moves to `human_review` and never receives a new retry key.
- `createLineOutboundDeliveryService` classifies the persisted Push record: timeout/transport failures and 5xx become bounded exponential retryable work; 2xx and 409 with `x-line-accepted-request-id` are terminal `sent`; every other 4xx is terminal `failed`.
- `pushCanonical` transmits the persisted body string unchanged with the stored UUID in `X-Line-Retry-Key`, returning only response status and the accepted-request header. No live request was made.

### RED / GREEN evidence

- RED: `node --test tests/support-outbox-delivery.test.js` initially failed because the delivery seam did not exist.
- GREEN focused verification: `node --test tests/line-support-adapter.test.js tests/support-outbox-delivery.test.js tests/support-repository.test.js tests/support-schema.test.js tests/support-migration-entrypoint.test.js tests/support-line-webhook.test.js`
  - Exit 0; 49 tests passed, 0 failed.
  - Covers lease-expiry duplicate creation returning one immutable outbox row, encrypted-at-rest recipient/body, same-body/same-key retries, 2xx/accepted-409 success, terminal other-4xx, and 24-hour human review.
- Full suite: `npm.cmd test`
  - Exit 0; 385 tests passed, 0 failed.
- Production build: `npm.cmd run build` with command-scoped disposable `AUTH_MODE=demo`, Turso, encryption, and blob values
  - Exit 0; optimized build passed.
- `git diff --check` passed. Repository scans found only documented placeholder/example credential names; no newly added secret was found. No remote migration, live LINE/LLM/database call, deployment, or delivery action was performed.
