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
