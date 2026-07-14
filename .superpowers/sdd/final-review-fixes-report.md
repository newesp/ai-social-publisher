# Final review fixes report

Base: `81f7606`

## Outcome

Closed the wave-2 renewal, retry, OAuth atomicity/retention, secret-handling, migration, settings-feedback, and request-composition findings without live provider, account, database, migration, deployment, or dependency actions.

## RED then GREEN evidence

### Renewal fencing, deadlines, and provider classification

- RED: six focused lifecycle assertions failed before implementation: an expired LINE 503 was flattened into reconnect, a lost completion fence could return stale state, request abort did not produce a typed retry, Meta used a query token for `/me/accounts`, an ambiguous Meta 403 could be treated as authorization loss, and rejected Page plus transient refresh was terminal.
- GREEN: `connection-lifecycle.js` now supplies typed retryable/authorization outcomes and abortable deadlines. LINE and Meta lease completion is fenced; a loser boundedly reloads until it observes newer credentials or throws retryable 503, and only the current lease owner attempts the fenced release. Explicit auth rejection is separated from timeout/network/403/429/5xx.
- GREEN tests include expired transient renewal, abort and lease release, completion-CAS loss without stale reuse or reconnect mutation, observable newer fenced winner, cross-process/crashed lease behavior, Meta recovery after Page rejection, and ambiguous 403 behavior.

### Retryable post lifecycle

- RED: three focused post tests failed because lifecycle 503 outcomes were flattened into terminal target/post failure and partial successful targets could not be preserved for retry.
- GREEN: immediate retryable work returns to `draft`; scheduled retryable work returns to `scheduled` with a bounded 60-second backoff. Partial progress is committed transactionally and subsequent claims select only unfinished targets. Missing, foreign, disconnected, and confirmed reconnect-required connections remain terminal. Route output remains generic 503.
- GREEN repository, immediate-route, scheduler, provider-network, and partial-result tests prove requeue rather than loss while retaining existing cancellation semantics.

### Atomic Meta Page selection and retention

- RED: invalid Page selection consumed the picker, and the repository had no atomic replace-and-delete operation. The first concurrent SQLite test also exposed test-harness lock behavior; it was corrected to use separate WAL clients, matching real concurrent callers.
- GREEN: selection first validates a non-consuming owner-scoped picker read. One transaction then predicates on owner, provider, unconsumed state, and expiry; deletes the OAuth row, archives the active default, and inserts the new connection. Rollback preserves both picker and old default. Concurrent callers produce exactly one commit. Expired purge is bounded to 100 rows and is invoked opportunistically from Meta start.
- GREEN database-backed tests cover committed deletion, concurrent single use, insert-failure rollback, invalid selection retry, and bounded 101-row purge.

### Meta request secrets

- RED: `/me/accounts` placed an access token in the URL and there was no outward transport-error assertion for a URL containing `client_secret`.
- GREEN: Page validation and `/me/accounts` use `Authorization: Bearer`. Meta's documented server-side `oauth/access_token` exchange remains query-based; its constructed URL is caught behind a constant generic error and is never logged or returned. The callback transport-error test asserts that neither app secret nor OAuth code appears outward.

### Operator migration path

- RED: the requested orchestration and schema-application modules did not exist.
- GREEN: `npm run migrate:platform-connections` now composes schema application/verification before legacy cleanup. Separate schema and cleanup commands are explicit. Schema execution requires `PLATFORM_MIGRATION_BACKUP_CONFIRMED=YES`, applies the Drizzle chain, and verifies lease columns, the unique active-default index, and absence of duplicate defaults. Import/command tests prove migration is operator-only and is not wired to runtime scripts.
- A full operator sequence, verification queries, smoke steps, and recovery guidance are documented in `docs/platform-connection-migration-runbook.md`. No real database command was run.

### Settings lifecycle feedback

- RED: pure helper/source tests failed because safe persistent disconnect notices and lifecycle expiry wording were absent.
- GREEN: successful disconnect JSON maps only to constant safe Meta/LINE notices rendered in an accessible `role=status` live region. A 409 retains the connected state and actionable error. New actions clear stale notices. LINE shows automatic renewal/expiry; Meta wording remains explicitly best effort.
- Executable pure behavior and source-wiring tests pass. Rendered keyboard and pixel QA remains a documented manual limitation because no browser backend or testing-library dependency is available in this workspace.

### Request-level reuse and API cleanup

- RED: route and scheduler factory-count tests observed service composition per target.
- GREEN: posts compose one resolver per request and cron composes one per scheduler invocation, reusing it across targets. Production-only pre-lease credential replacement/archive APIs with no callers were removed; Change-account default replacement, disconnect, and lease operations remain.

## Documentation

- Updated the platform-connection design for atomic OAuth deletion, fenced deadlines, transient-vs-auth behavior, post requeue semantics, and Meta's documented query-secret exception.
- Added the migration runbook with stop-workers, backup acknowledgement, configuration, schema verification, cleanup, deployment, smoke, and rollback/recovery stages.

## Verification

- Focused post/retry suite: 49/49 passed.
- Focused lifecycle/repository suite: 40/40 passed, then LINE fencing suite 14/14 after adding explicit winner observation.
- Focused settings/migration suite: 10/10 passed.
- Fresh full suite after the final test: 207/207 passed, 0 failed/skipped/todo.
- Safe process-only `npm.cmd run build`: passed (Next.js 16.2.10, compile/typecheck/static generation complete).
- `git diff --check`: passed.
- `rg` scans: zero matches for removed production lifecycle APIs, legacy runtime publishing credentials, credential-path `console.*`/`response.text()`, and high-confidence private-key/API-token patterns.

Build emitted only the existing workspace-root inference and Next.js middleware-convention deprecation warnings.

## Deferred and manual limitations

- No live OAuth, provider publishing, disconnect/revoke, production DB migration, settings mutation, deployment, or dependency installation was performed.
- Rendered browser keyboard/pixel QA is manual as described above.
- The already-documented SQLite/Turso `post_targets.platform_connection_id NOT NULL` table rebuild and broader state-constant/DB-CHECK refactor remain out of this review wave.
- Unrelated dirty SDD artifacts were preserved and excluded from the commit.
