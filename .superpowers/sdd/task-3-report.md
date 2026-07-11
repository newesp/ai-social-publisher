# Task 3 Report: Owner-Scoped Posts, Publish Runner, And Cancellation

## Scope delivered

- Replaced the in-memory `/api/posts` list/create route with owner-scoped persistence handlers.
- Added post rows with `owner_email`, publish-start timestamp, and owner/history plus schedule indexes. This is a local schema preparation only; no Drizzle push, migration, or Turso write was run.
- Added `POST /api/posts` modes:
  - `scheduled` converts Taiwan `09:00` to UTC, persists scheduled parent/target rows, and makes no provider or settings call.
  - `now` persists a draft first, then uses the shared `publishPost` runner with the authenticated owner's decrypted settings and records every target result.
- Added conditional cancellation for an owner’s scheduled row only; all its target rows become `cancelled` after the parent conditional update succeeds.
- Retired `/api/posts/[id]/publish` with HTTP 410, removing its client-controlled direct publishing and shared-settings path.
- Active targets are filtered to Meta and LINE only. The target/platform persistence field remains extensible, while Instagram is not accepted for post creation.
- Provider error text is persisted after redacting values from that owner’s settings.

## TDD evidence

1. RED: `npm.cmd test -- tests/post-service.test.js`
   - Failed with `ERR_MODULE_NOT_FOUND` because `src/lib/posts/post-service.js` did not exist.
2. GREEN: the same service suite passed after the minimal scheduling, ownership, cancellation, and shared publish-runner implementation: 4/4 passed.
3. RED: `npm.cmd test -- tests/post-route-handlers.test.js`
   - Failed with `ERR_MODULE_NOT_FOUND` because `src/lib/posts/post-route-handlers.js` did not exist.
4. GREEN: `npm.cmd test -- tests/post-service.test.js tests/post-route-handlers.test.js`
   - Passed: 8/8. These tests use injected in-memory repositories and injected publishers only.
5. RED: updated the provider-error persistence assertion to include the owner token; focused route test failed because the stored error contained the token.
6. GREEN: after adding settings-value and bearer/access-token redaction in the publish runner, the focused service/route tests passed: 8/8.

## Verification

- `npm.cmd test -- tests/post-service.test.js tests/post-route-handlers.test.js`: 8 passed, 0 failed.
- `npm.cmd test`: 66 passed, 0 failed.
- `npm.cmd run build`: passed. Next.js emitted the existing middleware-to-proxy deprecation warning.
- `git diff --check`: passed.
- No Meta, LINE, remote Turso, Drizzle push/migration, or other live external side effect was performed.

## Files changed

- `src/lib/db/schema.js`
- `src/lib/posts/post-status.js`
- `src/lib/posts/schedule-time.js`
- `src/lib/posts/post-service.js`
- `src/lib/posts/post-repository.js`
- `src/lib/posts/post-route-handlers.js`
- `src/app/api/posts/route.js`
- `src/app/api/posts/[id]/route.js`
- `src/app/api/posts/[id]/publish/route.js`
- `tests/post-service.test.js`
- `tests/post-route-handlers.test.js`
- `tests/publish-settings-ownership.test.js`

## Self-review

- Every public posts route derives its owner only through the session-backed route guards; no body/query owner field exists.
- Repository list, find, claim, and cancellation mutations include the owner condition. Cancellation also requires `scheduled` in its SQL condition.
- Scheduled creation exits before settings reads or publish-runner invocation.
- Publish-now is create-first, claim-before-provider, owner-settings-only, and persists target errors/outcomes.
- The retired legacy route has no settings or provider imports, so it cannot be used to publish with a shared runtime configuration.

## Concerns / follow-up

- The local schema adds non-null `posts.owner_email`; reconcile and explicitly authorize any migration against an existing Turso database before applying it. This task intentionally did not create or push a remote migration.
- The Task 4 UI has not yet been wired to `POST /api/posts`, so current UI behavior remains outside this task’s scope.
- Task 5 will need to reuse the `publishPost` runner with an appropriately scheduled-row claim policy; the current immediate claim deliberately permits only `draft`.

## Acceptance correction: post-claim exception persistence

### Change

- `publishPost` now catches failures after a post has been claimed, including owner-settings reads, preview assembly, and the injected platform publisher. It writes a failed result for every claimed target before returning the final post.
- The persisted fallback message is generic and contains neither the signed-in owner email nor a settings value/token.
- The route handler also converts any publish-outcome persistence failure into a generic HTTP 500 error, so the app route cannot echo a lower-level exception message.

### TDD evidence

1. RED: added independent route-handler tests for a publisher throw after claim and a rejected `readSettings` call. `npm.cmd test -- tests/post-route-handlers.test.js` failed 2/6, each failure exposing the original owner email and token in the thrown error.
2. GREEN: after the runner catch/persist change, `npm.cmd test -- tests/post-service.test.js tests/post-route-handlers.test.js` passed 10/10. Both tests assert a `failed` parent, `failed` target, and response error text that excludes the owner email and token.

### Correction verification

- `npm.cmd test`: 68 passed, 0 failed.
- `npm.cmd run build`: passed; Next.js emitted the existing middleware-to-proxy deprecation warning.
- `git diff --check`: passed.
- No Meta, LINE, Turso, migration, or remote call was made; all provider and settings failures were injected locally.
