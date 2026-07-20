# LINE Support Task 7 Recovery Design

## Goal

Close the four remaining Task 7 durability defects without starting Task 8,
adding a database migration, or invoking a live LINE, LLM, Workflow, or remote
database integration.

## Verified Failure Pattern

Three fix waves passed their focused tests but left the same architectural
invariants distributed across Workflow, service, and repository code:

- protected customer text crossed a durable step boundary;
- batch-companion event completion did not share the winner's two ownership
  fences;
- a delayed LINE 401 used a timestamp captured before the network request;
- a handoff could complete its primary event without consuming the rest of the
  claimed batch.

The current event and conversation leases already contain enough information
to represent ownership. A new processing-attempt table would make ownership
more explicit, but it would add migration and lifecycle work that is not
required to close these bounded defects.

## Chosen Architecture

Keep Workflow state identifier-only. Workflow step inputs and outputs may carry
internal event, connection, conversation, delivery, claim, and message IDs,
timestamps, status codes, and booleans. They must not carry customer text,
provider prompts, provider answers, credentials, encrypted identifiers, or
canonical LINE bodies.

Each provider-attempt step reloads its protected batch and current
configuration from the repository using internal IDs and the fixed batch
cutoff. The step calls the provider, reloads readiness after the call, and
persists a successful decision/outbox before returning only an internal
delivery ID and status.

All batch terminal outcomes use a common repository ownership predicate:

1. the primary event is still `processing` under the expected event claim;
2. the primary event lease is unexpired at transaction time;
3. the conversation is still `ai_active` under the expected conversation
   claim;
4. the conversation lease is unexpired at transaction time.

Successful reply, normal handoff, and credential-rejection handoff atomically
consume the selected inbound messages and complete all matching batch event
rows while the same predicate holds. A stale winner cannot complete an event
claimed by another worker.

Terminal writes use the time at which persistence is attempted. A LINE
response never reuses a timestamp captured before `sendPush`.

## Data Flow

1. Claim the event and conversation, sleep to the fixed three-second cutoff,
   and renew both leases.
2. Determine whether the batch exists without returning its customer text to
   Workflow state.
3. Invoke up to three durable provider-attempt steps. Each step loads protected
   data internally and returns only `retryable_provider`, a handoff status, or
   an internal delivery ID.
4. The repository transaction that persists the terminal outcome also consumes
   the batch and resolves eligible companion events.
5. Delivery retries reuse the immutable outbox record. A 401 obtains a fresh
   completion time and performs the jointly fenced credential handoff.
6. After release, schedule a follow-up only for a genuinely unprocessed event
   that remains eligible for AI processing.

## Rejected Alternatives

- Continue adding per-finding fence checks: rejected because three cycles
  proved that independently shaped terminal APIs keep reopening the same race.
- Add a new processing-attempt table now: rejected for this recovery because
  the existing claim IDs, cutoff, message rows, and event rows can express the
  required stable batch without a production migration.

## Acceptance Tests

- Workflow provider-step arguments contain IDs/status metadata only.
- A provider call that outlives either lease cannot persist a decision/outbox.
- A stale winner cannot complete a companion event now owned by another worker.
- A delayed 401 after lease expiry cannot mutate connection, conversation, or
  event state.
- Handoff atomically consumes the batch and leaves no duplicate primary event
  as the follow-up candidate.

Task 7 is complete only after focused tests, the full suite, a production build
with disposable command-scoped configuration, diff/secret checks, and a
ledger update all pass at the same final HEAD.
