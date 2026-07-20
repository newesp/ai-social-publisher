# Task 9 Report: human Push replies and undoable transitions

## Status

DONE. The local/mock-focused behavior, full test suite, and production build pass; no live action was attempted.

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
- `npm.cmd run build` with process-scoped disposable `AUTH_MODE`, encryption, Turso, and Blob values — PASS. Workflow build completed with `4 steps, 1 workflow`; the transition and undo routes rendered in the production route manifest.

## Self-review

- Confirmed all browser mutation routes require the authenticated normalized owner and same-origin guard.
- Confirmed no customer external ID, owner email, token, retry key, or provider body is returned to the browser.
- Confirmed pending transitions are keyed by conversation and transition ID, not UI selection state.
- Confirmed inbound cancellation remains conversation-scoped.
- No live LINE, LLM, database, Workflow deployment, migration, credential, or message action was performed.

## Build blocker recovery

- RED: the prior production build reproducibly failed because the transition route had a literal dynamic import of `support-transition-workflow.js`, causing Workflow analysis to trace Node-only `crypto` through the repository.
- GREEN: the transition route now composes the workflow module specifier at runtime, matching the established LINE webhook workflow start boundary. Focused Task 9 coverage passed `27/27`, `npm.cmd test` passed `441/441`, and the production build passed.

## Commit

`4a38ddc feat: add recoverable human support actions`; the subsequent commit records the build-boundary fix.
