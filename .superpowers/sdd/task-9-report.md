# Task 9 Report: human Push replies and undoable transitions

## Status

DONE_WITH_CONCERNS. The local/mock-focused behavior and full test suite pass. The required production build is blocked by the Workflow compiler rejecting the transition workflow's repository dependency because it reaches Node `crypto`; no live action was attempted.

## Implementation summary

- Added owner- and same-origin-scoped take-over, human message, transition, and exact-transition undo routes.
- Added server-side human Push preparation: the recipient is decrypted only in the repository, the persisted human message UUID is reused as the LINE retry key, and accepted `2xx` plus accepted `409` are persisted as sent. Other outcomes are persisted as failed with safe codes.
- Added durable transition request, commit fencing, and undo fencing. Requests set a ten-second pending state; commit requires the exact pending transition and `expectedVersion + 1`; undo restores only the recorded `fromStatus`.
- Updated inbound handling to cancel only its own pending transition and reopen resolved/pending conversations for normal AI classification.
- Added a global undo notice and human inbox controls. Return-to-AI asks for confirmation; Resolve requests immediately.

## Files changed

- `src/app/api/support/conversations/[id]/take-over/route.js`
- `src/app/api/support/conversations/[id]/messages/route.js`
- `src/app/api/support/conversations/[id]/transitions/route.js`
- `src/app/api/support/conversations/[id]/transitions/[transitionId]/undo/route.js`
- `src/lib/support/routes/support-human-action-route-handlers.js`
- `src/lib/support/workflows/support-transition-workflow.js`
- `src/lib/support/support-repository.js`
- `src/lib/support/support-store.js`
- `src/lib/support/routes/support-inbox-route-handlers.js`
- `src/components/support/GlobalTransitionUndo.js`
- `src/components/support/SupportInbox.js`
- `src/components/support/ConversationThread.js`
- `tests/support-human-actions.test.js`
- `tests/support-transition-workflow.test.js`
- `tests/support-inbox-ui.test.js`

## TDD evidence

1. RED: `node --test tests/support-human-actions.test.js tests/support-transition-workflow.test.js tests/support-inbox-ui.test.js` exited `1` as expected because the human-action handler, transition workflow, and global undo component did not exist.
2. GREEN: the same command exited `0`, with `10/10` tests passing.

## Verification

- `node --test tests/support-human-actions.test.js tests/support-transition-workflow.test.js tests/support-inbox-ui.test.js tests/support-line-webhook.test.js` — PASS, `27/27`.
- `npm.cmd test` — PASS, `441/441`.
- `git diff --check` — PASS.
- `npm.cmd run build` with process-scoped disposable `AUTH_MODE`, encryption, Turso, and Blob values — FAIL. The Workflow compiler reports `node:crypto` reachable from the support repository/credential crypto through `support-transition-workflow.js`. This is a build-system integration concern, not a test failure.

## Self-review

- Confirmed all browser mutation routes require the authenticated normalized owner and same-origin guard.
- Confirmed no customer external ID, owner email, token, retry key, or provider body is returned to the browser.
- Confirmed pending transitions are keyed by conversation and transition ID, not UI selection state.
- Confirmed inbound cancellation remains conversation-scoped.
- No live LINE, LLM, database, Workflow deployment, migration, credential, or message action was performed.

## Concern

The production build must be unblocked by adapting the Workflow-step integration to the repository's Node-only crypto dependency. This needs a focused Workflow-compatible boundary before deployment.

## Commit

`4a38ddc feat: add recoverable human support actions`
