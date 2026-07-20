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

## Review fix wave: refresh reconciliation and workflow-start compensation

### Fixes

- Inbox summaries now carry only safe pending-transition metadata (transition ID, action, effective time) for the authenticated owner's conversations. `SupportInbox` reconciles its global undo notice from those summaries after initial load, polling, and refresh, so a pending transition remains undoable after reload and after changing the selected conversation.
- A transition-start failure now calls a server-side exact-transition recovery method. It delegates to the repository's owner-, conversation-, transition-ID-, and optimistic-version-fenced undo mutation; the browser never supplies a replacement state. The route returns a bounded `503` after attempted recovery instead of stranding AI in a pending state.

### TDD evidence

1. RED: `node --test tests/support-human-actions.test.js tests/support-inbox-ui.test.js` exited `1` with the expected missing workflow-failure compensation and missing global reconciliation assertions.
2. GREEN: `node --test tests/support-human-actions.test.js tests/support-inbox-ui.test.js tests/support-transition-workflow.test.js` exited `0`, `12/12` passing.

### Verification

- `npm.cmd test` — PASS, `443/443`.
- `npm.cmd run build` with disposable process-scoped runtime values — PASS; Workflow build reported `4 steps, 1 workflow` and rendered the transition/undo routes.
- `git diff --check` — PASS.

### Files amended

- `src/components/support/SupportInbox.js`
- `src/lib/support/support-repository.js`
- `src/lib/support/support-store.js`
- `src/lib/support/routes/support-inbox-route-handlers.js`
- `src/lib/support/routes/support-human-action-route-handlers.js`
- `tests/support-human-actions.test.js`
- `tests/support-inbox-ui.test.js`
- `tests/support-inbox-routes.test.js`

### Self-review

- Pending transition data in list responses is limited to the existing safe customer label and transition metadata; no owner, external recipient, credential, or provider data was added.
- Reconciliation derives the undo target from server state, not the selected thread or browser-supplied state.
- Recovery reuses the exact transition fence and is harmless if a competing commit, inbound cancellation, or undo has already made the transition stale.

## Authorized recovery: owner-global active pending transitions

### Implementation

- Added `GET /api/support/conversations/active-pending-transitions`, independent of inbox cursor/page slicing. It returns every active pending transition for only the authenticated owner.
- The response is restricted to transition ID, conversation ID, action, effective time, and the existing safe `Customer` label.
- `SupportInbox` fetches this collection during initial load, refresh, and visible-tab polling. `GlobalTransitionUndo` now renders and independently undoes every active transition using its existing path IDs.

### TDD evidence

1. RED: `node --test tests/support-inbox-routes.test.js tests/support-inbox-ui.test.js tests/support-human-actions.test.js tests/support-transition-workflow.test.js` exited `1`: the active-pending handler was absent and the inbox had no collection endpoint/reconciliation.
2. GREEN: the same command exited `0`, `18/18` passing.

### Verification

- `npm.cmd test` — PASS, `445/445`.
- `npm.cmd run build` with disposable process-scoped runtime values — PASS; `4 steps, 1 workflow`, including `/api/support/conversations/active-pending-transitions`.
- `git diff --check` — PASS.

### Files amended

- `src/app/api/support/conversations/active-pending-transitions/route.js`
- `src/components/support/GlobalTransitionUndo.js`
- `src/components/support/SupportInbox.js`
- `src/lib/support/support-repository.js`
- `src/lib/support/support-store.js`
- `src/lib/support/routes/support-inbox-route-handlers.js`
- `tests/support-inbox-routes.test.js`
- `tests/support-inbox-ui.test.js`

### Self-review and concerns

- The collection is owner-filtered before transition selection and never exposes identifiers outside the approved safe browser contract.
- It queries all active pending transitions rather than relying on the 30-item conversation page; concurrent transitions are retained, deduplicated, and individually undoable.
- No concerns remain. No live external action was performed.
