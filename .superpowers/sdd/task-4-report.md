# Task 4: Bind publishing targets to immutable platform connections

## Implementation summary

- `createPost` now resolves the normalized authenticated owner's active default connection for every active selected platform before persistence and stores each connection ID on its target in the existing parent-and-target create transaction.
- Missing, foreign-owner, archived, wrong-platform, and `needs_reconnect` defaults fail before any post rows are created with a generic reconnection error.
- Immediate and scheduled publishing now load credentials only by `post.ownerEmail` plus each target's stored `platformConnectionId`; no publishing path reads `user_settings`, environment platform credentials, or the current default.
- Archived immutable connections remain publishable for already-created targets, so a later default change does not retarget scheduled content. New posts still require an active default.
- Pre-feature targets without a connection ID fail safely and never attempt a default lookup or provider call.
- Meta and LINE publishers use the credential object paired to the target connection ID. Provider bodies and credential values are discarded from terminal errors.
- LINE connections run Task 3 `ensureUsable` before credentials are returned to the publisher. Provider rejection invokes the owner-scoped connection store's `markNeedsReconnect` callback for only the bound connection.
- API responses omit owner email, connection IDs, credentials, and stored provider error text. Existing cancellation and scheduling claim behavior remains unchanged.

## Files changed

- `src/lib/posts/post-service.js`
- `src/lib/posts/post-route-handlers.js`
- `src/lib/platforms/publish-service.js`
- `src/lib/platform-connections/line-channel-service.js`
- `src/lib/platform-connections/platform-connections-repository.js`
- `src/app/api/posts/route.js`
- `src/app/api/cron/route.js`
- `src/lib/scheduler/run-due-post-scheduler.js`
- `tests/post-service.test.js`
- `tests/post-route-handlers.test.js`
- `tests/scheduler.test.js`
- `tests/publish-service.test.js`
- `tests/line-channel-service.test.js`
- `.superpowers/sdd/task-4-report.md`

`src/lib/posts/post-repository.js` required no code change: its existing `createPostWithTargets` transaction spreads every supplied target field, so the newly supplied `platformConnectionId` is written in the same transaction and is already returned by target reads.

## RED evidence

Command:

`node --test tests/post-service.test.js tests/post-route-handlers.test.js tests/scheduler.test.js tests/publish-service.test.js`

Observed expected result: 29 tests, 14 passed, 15 failed. The failures showed the missing behavior directly: `resolveConnection` and `getConnection` were never called, target connection IDs were absent, invalid defaults did not reject, the legacy settings-shaped publisher could not consume per-connection credentials, old unbound targets returned the former generic pre-provider error, and provider rejection did not mark LINE for reconnection.

Additional lifecycle RED command:

`node --test tests/post-route-handlers.test.js`

Observed expected result: module instantiation failed because `createPublishingConnectionResolver` was not exported yet. This proved the new behavior test required the shared LINE `ensureUsable` composition helper rather than merely inspecting route source.

Archived LINE lifecycle RED command:

`node --test tests/line-channel-service.test.js`

Observed expected result: 8 tests, 7 passed, 1 failed. The archived bound connection failed with `The LINE connection is not available.` before provider renewal, proving Task 3's active-only lifecycle conflicted with immutable scheduled-target semantics. Per the integration decision, archived remains unavailable to new post selection but must remain usable by already-bound targets. The minimum GREEN change allows owner-scoped active or archived LINE connections in `ensureUsable`, and owner-scoped CAS/reconnect state updates now accept either state while credential updates preserve the existing state.

## GREEN focused verification

Command:

`node --test tests/line-channel-service.test.js tests/post-service.test.js tests/post-route-handlers.test.js tests/scheduler.test.js tests/publish-service.test.js`

Result: 42 passed, 0 failed, exit code 0.

## Full-suite verification

Command:

`npm.cmd test`

Result: 143 passed, 0 failed, exit code 0.

Additional check: `git diff --check` exited 0. Git emitted only the worktree's line-ending conversion warnings.

## Self-review

- Re-read the Task 4 brief and traced creation, publish-now, scheduler, cron, provider, store, and response-sanitization paths.
- Confirmed owner normalization precedes both default resolution and immutable ID reads.
- Confirmed creation resolves all selected connections before opening the repository create transaction, preventing partial post rows.
- Confirmed publish-time lookup never receives only a platform and never reads a current default.
- Confirmed archived connections are rejected for new posts but accepted when already bound to a target; `needs_reconnect` and unknown states fail closed.
- Confirmed archived bound LINE credentials can renew through compare-and-swap without changing the connection back to active, while foreign, missing, and `needs_reconnect` records remain rejected.
- Confirmed LINE lifecycle ordering is `getById` then `ensureUsable` then provider send, and reconnect marking closes over the same owner and connection ID.
- Confirmed publish-service errors never use provider response text and API mapping hides internal error text and connection IDs.
- Confirmed only credential-specific rejection signals (HTTP 401/403 or Meta OAuth code 190) mark reconnect; transient 429/5xx failures remain generic without mutating connection state.
- Confirmed a non-JSON credential rejection cannot bypass lifecycle marking, reconnect-state persistence failures do not erase terminal provider outcomes, and nested credential values are recursively redacted before repository writes.
- Confirmed all automated provider interactions use deterministic `fetchImpl` doubles; no live Meta or LINE calls occurred.
- Reviewed `git status` and excluded the pre-existing modified Task 3 report and all unrelated `.superpowers/sdd` artifacts from the Task 4 commit.

## PR-readiness review

- Correctness and security reviewers found no Critical issues. They identified three Important failure-path defects: double-reading a non-JSON rejection body, treating every non-2xx as credential rejection, allowing reconnect persistence failure to escape and overwrite terminal outcomes, and incomplete nested credential redaction (the two reviewers overlapped on body parsing).
- Added RED regression tests for transient 503 behavior, text-body 401 rejection, reconnect persistence failure, and nested secret redaction; 19 focused tests initially had 3 failures. The minimum fixes made response parsing single-attempt, classified credential rejection explicitly, isolated reconnect persistence failure, and recursively collected nested credential strings with cycle protection.
- Post-fix confirmation review found no Critical or Important issues and independently confirmed the 42/42 focused and 143/143 full-suite results.
- Manual maintainability review found only the acknowledged Minor cost of loading a LINE connection once in the resolver and again inside Task 3 `ensureUsable`, plus constructing services per target. With two active platforms this is bounded; changing the lifecycle interface or request-scoped service graph is deferred to avoid broadening this correctness-focused task.
- Diff secret/PII scan matched only credential field names and deterministic test placeholders (`owner@example.com`, `*-token`, `*-secret`); no real secret, personal address, or provider payload was found.
- `npm.cmd run build` was attempted but stopped in the existing `prebuild` runtime-config gate because `AUTH_MODE` is not configured in this worktree. No compilation failure was observed, and no production-like environment values were fabricated. The full Node test suite is the available verification evidence.

## Concerns

- No known blocker or functional concern within Task 4 scope.
- Production publishing still depends on configured database/encryption environment and valid owner connections; no production configuration or provider action was performed.
