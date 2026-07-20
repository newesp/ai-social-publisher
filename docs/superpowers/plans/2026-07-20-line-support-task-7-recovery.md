# LINE Support Task 7 Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the four remaining Task 7 durability defects and stop before Task 8.

**Architecture:** Keep durable Workflow state identifier-only and load protected
batch data inside provider steps. Centralize reply, handoff, credential
rejection, batch consumption, and companion-event completion behind repository
transactions that jointly fence the event and conversation leases at write
time.

**Tech Stack:** Next.js App Router, JavaScript, Drizzle ORM/libSQL, Vercel
Workflow SDK, Node built-in test runner.

## Global Constraints

- Do not add a migration unless the existing claim and batch rows prove
  insufficient.
- Do not call live LINE, LLM, Workflow, deployment, or remote database systems.
- Workflow arguments never contain raw message text, provider answers,
  credentials, external LINE identifiers, or canonical request bodies.
- Automated replies continue using the immutable Push outbox and UUID retry
  key.
- Do not begin Task 8.

---

### Task 1: Encode the five recovery invariants

**Files:**
- Modify: `tests/support-message-workflow.test.js`
- Modify: `tests/support-repository.test.js`
- Modify: `tests/support-processing-service.test.js`
- Modify: `tests/support-outbox-delivery.test.js`

**Interfaces:**
- Consumes: existing Workflow/service/repository factories and test database.
- Produces: repository-backed regression coverage for ownership, protected
  Workflow state, post-network time, and atomic batch finalization.

- [ ] **Step 1: Add a Workflow payload regression**

Capture the real provider-step input and assert that it contains identifiers,
claim IDs, cutoff, and attempt metadata but no `customerTexts`, messages,
provider answer, credentials, recipient, or canonical body.

- [ ] **Step 2: Add repository ownership regressions**

Use the real test database to demonstrate that an expired primary event or
conversation claim rejects decision/outbox persistence and that a companion
event with a different active claim is not completed by batch finalization.

- [ ] **Step 3: Add handoff batch finalization regression**

Persist two inbound messages in one cutoff, perform a fenced handoff, and assert
that both selected messages and eligible event rows are terminal while
`findNextUnprocessedEvent` does not return the completed primary event.

- [ ] **Step 4: Add delayed-401 regression**

Pause `sendPush`, advance the supplied clock beyond the processing leases,
resolve the request as 401, and assert that credential rejection receives the
post-response time and cannot mutate protected state.

- [ ] **Step 5: Verify RED**

Run:

```powershell
npm.cmd test -- --test tests/support-message-workflow.test.js tests/support-processing-service.test.js tests/support-repository.test.js tests/support-outbox-delivery.test.js
```

Expected: each new case fails on the current implementation for its stated
architectural reason.

### Task 2: Make Workflow state identifier-only

**Files:**
- Modify: `src/lib/support/workflows/line-message-workflow.js`
- Modify: `src/lib/support/support-processing-service.js`
- Modify: `src/lib/support/support-repository.js`

**Interfaces:**
- `buildTurn(input)` produces batch metadata only, including an internal inbound
  message ID, not customer text.
- `decideAndPersist(input)` receives IDs, claims, cutoff, attempt metadata, and
  time; it loads all protected content internally.
- Provider Workflow steps return `{ status, deliveryId?, eventCompleted? }`.

- [ ] **Step 1: Remove protected turn data from Workflow state**

Change `buildClaimedTurn`/`buildTurn` to return only internal batch metadata.
Remove `...turn` and `customerTexts` from provider-step input.

- [ ] **Step 2: Load the fixed batch inside the provider step**

Extend `loadCurrentProcessingContext` to derive FAQ query input from inbound
messages selected by the fixed cutoff. Keep message text inside the repository
and processing step.

- [ ] **Step 3: Run the focused tests**

Run the Task 1 command and require all cases to pass before proceeding.

### Task 3: Centralize fenced batch terminal writes

**Files:**
- Modify: `src/lib/support/support-repository.js`
- Modify: `src/lib/support/support-processing-service.js`
- Modify: `src/lib/support/workflows/line-message-workflow.js`

**Interfaces:**
- Reply persistence atomically creates decision/outbox, consumes the batch, and
  completes only eligible companion events under both leases.
- `persistHandoff(input)` atomically transitions the conversation, consumes the
  batch, and completes eligible batch events under both leases.
- Workflow no longer calls an unfenced post-persistence
  `resolveBatchedEventsStep`.

- [ ] **Step 1: Share one joint ownership predicate**

Build the event/conversation lease predicates from event ID, event claim ID,
conversation ID, conversation claim ID, connection ID, and transaction-time
`now`. Apply them to every terminal transaction.

- [ ] **Step 2: Finalize eligible batch events atomically**

Only complete companion events that are still `dispatched`, or the primary
event under its expected unexpired claim. Never overwrite a companion event
owned by another claim.

- [ ] **Step 3: Consume the handoff batch atomically**

Set `processedAt` for the selected inbound messages in the same transaction as
the conversation handoff and event completion.

- [ ] **Step 4: Remove the separate batch resolver**

Delete the Workflow/service call that completes batched events after terminal
persistence.

- [ ] **Step 5: Run the focused tests**

Run the Task 1 command and require all cases to pass.

### Task 4: Fence LINE terminal writes at response time

**Files:**
- Modify: `src/lib/support/outbox/line-outbound-delivery-service.js`
- Modify: `src/lib/support/support-repository.js`
- Modify: `tests/support-outbox-delivery.test.js`
- Modify: `tests/support-repository.test.js`

**Interfaces:**
- `attemptDelivery` accepts a clock function for current time while retaining
  the existing explicit initial-attempt time used by deterministic tests.
- Credential rejection is persisted with a time obtained after `sendPush`.

- [ ] **Step 1: Obtain fresh time after the network response**

Use a clock function after `sendPush` resolves for 401 handoff and all delivery
terminal timestamps. Do not use the pre-request `attemptedAt` value.

- [ ] **Step 2: Keep credential rejection jointly fenced**

Require both unexpired processing claims in the credential-rejection
transaction before changing the connection, conversation, or event.

- [ ] **Step 3: Run the focused tests**

Run the Task 1 command and require all cases to pass.

### Task 5: Verify, record, and stop

**Files:**
- Modify: `.superpowers/sdd/line-support-task-7-report.md`
- Modify: `.superpowers/sdd/progress.md`
- Modify: `docs/handoffs/2026-07-20-line-ai-customer-support.md`

- [ ] **Step 1: Run focused acceptance**

Run all Task 7 support tests and record the pass count.

- [ ] **Step 2: Run the final full suite once**

```powershell
npm.cmd test
```

- [ ] **Step 3: Run the production build once**

Use only disposable command-scoped synthetic configuration required by the
existing build.

- [ ] **Step 4: Inspect final state**

Run `git diff --check`, inspect `git diff --stat`, scan changed files for
secrets/private identifiers, and confirm no Task 8 file was touched.

- [ ] **Step 5: Update durable records and commit**

Record exact commands, counts, limitations, and final commit range in the Task
7 report, progress ledger, and handoff. Commit the completed Task 7 recovery
and stop.
