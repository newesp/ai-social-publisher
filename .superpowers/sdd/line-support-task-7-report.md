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

## Second Combined Fix Wave (2026-07-20)

### Root-cause trace and implementation

- The workflow renewed its event and conversation leases immediately before `decideAndPersist`, but the processing service persisted with that pre-provider timestamp. The event predicate in `persistDecisionAndOutbound` also did not require an unexpired event lease. A provider call lasting beyond the 30-second lease could therefore write a decision/outbox after the event fence expired.
- The batch builder also marked messages processed before provider work. The fix moves that state transition into the same fenced transaction that creates the decision/outbox, so a stale or lost provider call leaves the turn available for later recovery rather than silently finalizing it.
- `persistDecisionAndOutbound` and `persistHandoff` now require both the named, unexpired event fence and the named, unexpired conversation fence. Decision outcomes take a fresh processing timestamp after provider work; workflow completion renews both fences at the post-decision/post-delivery boundary.
- `resolveLineEventAfterConversationLoss` owns completion when it returns truthy. The workflow no longer calls `completeEvent` a second time. A repository-backed test confirms the event is processed once and a second completion is rejected.
- Current processing context now verifies that the selected LINE connection remains active and that the selected provider/model/key remain ready. A false readiness result persists the safe `configuration_unready` handoff before an LLM decision; existing credential-rejection delivery behavior remains unchanged.
- The orchestration is a durable `"use workflow"` with individually durable `"use step"` claim, fence, turn, decision/persistence, delivery, finalization, release, and follow-up boundaries. The three-second durable sleep and internal-ID-only workflow interface remain unchanged.

### RED evidence

- `node --test tests/support-message-workflow.test.js tests/support-processing-service.test.js tests/support-repository.test.js tests/support-outbox-delivery.test.js tests/support-decision-service.test.js tests/line-support-adapter.test.js tests/support-line-webhook.test.js` exited 1 before the fixes: 65 passed, 3 failed. The expected failures were duplicate competing-event completion, absent post-decision fence renewal, and acceptance of decision/outbox persistence after the event lease expired.
- `node --test tests/support-repository.test.js` exited 1 before moving batch consumption into the fenced persistence transaction: 14 passed, 1 failed because the inbound message had already been marked processed (`2026-07-19T00:00:03.000Z`) rather than remaining `null` while provider work was outstanding.

### GREEN evidence

- `node --test tests/support-message-workflow.test.js tests/support-processing-service.test.js tests/support-repository.test.js tests/support-outbox-delivery.test.js tests/support-decision-service.test.js tests/line-support-adapter.test.js tests/support-line-webhook.test.js` exited 0: 68 passed, 0 failed.
- `git diff --check` exited 0.

### Self-review

- Rechecked all writes after protected provider work: decision/outbox, handoff, and event completion are fenced by current lease state; stale work cannot create an outbound message or mark an event complete.
- Rechecked ownership of the competing-event path: repository resolution is terminal and its workflow caller only releases an unresolved event.
- Rechecked Task 7 invariants: exact `windowStart + 3s` cutoff, owner-scoped current configuration, Push-only immutable outbox/retry path, credential-rejection handoff, 30-day context filter, follow-up discovery, and the Task 5 test seam remain in place.
- No providers, LINE endpoints, migrations, deployments, secrets, or external messages were invoked.

## Third and Final Combined Fix Wave (2026-07-20)

### Root-cause trace and architecture

- A delivery claim identified only the immutable outbox record. On a Push 401 the transport callback therefore had no event or conversation claim IDs, and `handleLineCredentialRejected` updated both connection and conversation with no current-lease predicates. The delivery workflow now passes both claims to the delivery step; the repository changes the connection only when the current event and conversation claims are unexpired, and changes the conversation using the same predicates. A stale 401 is a terminal outbox failure only.
- Event completion previously proved only the event claim. Normal workflow completion now supplies both event and conversation claim IDs; `markLineEventProcessed` applies the two unexpired predicates in one SQL update. Handoff and credential-rejection transactions complete the event as part of their fenced terminal transition, so the workflow cannot double-complete after clearing the conversation claim. The losing-event resolver is its separate repository-atomic ownership contract: it can complete only an already-consumed message while its own event claim remains unexpired, so a loser never needs or impersonates the winner's conversation claim.
- The first readiness read protected only the start of provider work. The provider-attempt service now reloads current owner-scoped connection/provider/model/key readiness after provider work and before it writes the decision/outbox. If it changed, the fenced result is `configuration_unready`; inactive LINE token loading cannot be translated into a generic delivery error.
- The shared durable-boundary flaw was that `decideWithRetry` made three external provider calls inside one `"use step"`. The workflow now owns exactly three provider-attempt iterations, each calling `providerAttemptStep` (`"use step"`); retryable provider errors return an opaque status, and the third result is persisted through its own `persistHandoffStep`. Provider request context and response text stay inside the provider step and are never workflow arguments. The production workflow entry takes only `{ eventId, connectionId, conversationId }`; its step functions construct protected services server-side.

### RED evidence

- `node --test tests/support-message-workflow.test.js tests/support-processing-service.test.js tests/support-outbox-delivery.test.js` exited 1 before implementation: 20 passed, 3 failed. The expected failures were the absent provider-attempt step/loop shape, 401 callback ownership data, and post-provider readiness fence.

### GREEN evidence

- `node --test tests/support-message-workflow.test.js tests/support-processing-service.test.js tests/support-repository.test.js tests/support-outbox-delivery.test.js tests/support-decision-service.test.js tests/line-support-adapter.test.js tests/support-line-webhook.test.js` exited 0: 72 passed, 0 failed.
- `AUTH_MODE=demo` with disposable command-scoped build values, then `npm.cmd run build`, exited 0. The installed Workflow SDK build reported `workflows build complete (4 steps, 1 workflow)` and Next compiled successfully. Local SDK documentation confirms that `"use workflow"` is the deterministic orchestration boundary, `"use step"` is the Node/side-effect boundary whose result is persisted, and `sleep("3s")` is a direct durable workflow call.
- `git diff --check` exited 0.

### Self-review

- Reviewed every terminal write after delivery/provider work: decision/outbox and handoff are jointly fenced; regular completion is jointly fenced; losing-event completion is an explicit event-lease-plus-consumed-message atomic contract; credential reconnect/handoff uses both leases and remains idempotent.
- Rechecked the Task 7 invariants: exact three-second cutoff/sleep, owner scope, 30-day context, exactly three provider attempts then handoff, Push-only immutable UUID-key delivery, 409/24-hour behavior, inbound dedupe, follow-up scheduling, and the Task 5 `processEvent` seam remain present.
- No real LINE or LLM provider, remote database, migration, deployment, secret write, or message was used.
