# LINE Support Task 7 Report

## Outcome

Implemented durable LINE support processing with a three-second conversation batch, fenced event and conversation claims, current protected-data loading, persisted decision/outbox creation, Push-only delivery, bounded retry, and fail-closed handoff outcomes.

## Changes

- Added `createSupportProcessingService` for conversation claims, turn construction, decision persistence, immutable-outbox delivery, release, and follow-up discovery.
- Extended the durable LINE workflow to retain the Task 5 event-processing fence, batch messages for three seconds, release competing runs safely, schedule follow-up work, and retry only the existing immutable delivery record.
- Added repository operations for conversation leases, current scoped context/decryption, atomic decision/message/outbox persistence, safe handoff state, follow-up lookup, LINE token loading, and connection reconnect state.
- Kept automated AI output on Push only. The existing outbox UUID remains the retry key; 2xx and accepted 409 remain terminal sent states, other 4xx are terminal, and unknown delivery after 24 hours remains human review.
- Preserved the Task 5 test-only `processEvent` workflow seam for its event-claim regression coverage.

## Verification

- RED: `node --test tests/support-message-workflow.test.js tests/support-processing-service.test.js` failed before the new processing service/workflow behavior existed.
- Focused GREEN: `node --test tests/support-message-workflow.test.js tests/support-processing-service.test.js tests/support-repository.test.js tests/support-outbox-delivery.test.js tests/line-support-adapter.test.js tests/support-line-webhook.test.js` — 50 passed, 0 failed.
- Full suite: `npm.cmd test` — 413 passed, 0 failed.
- Production build: `npm.cmd run build` with command-scoped disposable demo values — succeeded. No remote database, LINE, LLM, credentials, deployment, or migration was used.
- `git diff --check` — clean.
- Scan: reviewed changed production files for debug output and credential/customer disclosure. The only credential/identifier references are required decrypt/transport field names or deliberately fake test fixtures; no secrets, PII logs, or raw provider errors were added.

## Notes

- Build emits existing warnings about multiple worktree lockfiles and the deprecated Next.js middleware convention; neither is changed by this task.

## Critical/Important Fix Wave (2026-07-20)

### Root causes and fixes

- Renewed both event and conversation claims at every durable processing boundary and during retry waits (in 25-second slices). Renewal and finalization are fenced by both claim ID and an unexpired lease, so stale work cannot persist a decision, handoff, or completion after its fence is lost.
- Preserved the exact batch cutoff as `windowStart + 3s`, while loading a fresh current timestamp after the batch sleep and at each decision/delivery/attempt boundary. Retry transport attempts now use wake-time rather than the pre-sleep batch timestamp.
- Resolved all other internal webhook events whose messages were consumed by the winning batch. A loser additionally resolves its own event if the winner had already consumed it; otherwise it returns it to dispatched and the winner's release/follow-up path owns the remaining unprocessed event. This closes the dispatch-stranding race.
- Allowed only safe retryable provider failures to propagate out of the decision service. The processing service therefore performs exactly three decision attempts, then persists the `provider_unavailable` handoff. Parsing, schema, and non-retryable provider failures remain fail-closed as `invalid_ai_decision` without provider details.
- Extended the immutable delivery claim with its conversation ID. Push 401 now atomically marks that LINE connection `needs_reconnect` and transitions only its active conversation to `waiting_human` with `credential_rejected`; the conditional state transition is idempotent, so it cannot produce a duplicate handoff acknowledgement.
- Added a 30-day lower bound to protected conversation-context reads, independent of cleanup jobs.

### Regression coverage added

- Fence renewal, stale-conversation-fence rejection, and post-sleep attempt timestamps.
- Winning-batch resolution of competing events, including a repository-backed competing processing claim.
- Exactly-three retryable LLM attempts followed by a safe handoff, plus retryable-error propagation from the decision layer.
- Push 401 reconnect plus `waiting_human` handoff and idempotence.
- Exclusion of context text older than 30 days.

### Verification

- RED: `node --test tests/support-message-workflow.test.js tests/support-processing-service.test.js tests/support-decision-service.test.js tests/support-outbox-delivery.test.js` exited 1 with the expected missing retry propagation, missing lost-event resolution, absent fence renewal/current timestamps, missing credential conversation ID, and absent stale-claim method failures. `node --test tests/support-repository.test.js` exited 1 because 31-day-old context text was still returned. A further workflow RED exited 1 because a winning batch did not resolve consumed competing events.
- Focused GREEN: `node --test tests/support-message-workflow.test.js tests/support-processing-service.test.js tests/support-repository.test.js tests/support-outbox-delivery.test.js tests/line-support-adapter.test.js tests/support-line-webhook.test.js` exited 0: 53 passed, 0 failed.
- Full suite: `npm.cmd test` exited 0: 417 passed, 0 failed.
- `git diff --check` exited 0. No live LINE/LLM calls, deployments, remote database migrations, secret writes, or real messages were performed.
