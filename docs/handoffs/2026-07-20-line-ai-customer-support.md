# LINE AI Customer Support Final Handoff

## Status

Tasks 1 through 10 are complete on
`codex/line-ai-customer-support`. Trust Git history and
`.superpowers/sdd/progress.md`; do not repeat Task 9 or Task 10.

The branch implements the approved owner-scoped LINE AI customer-support MVP:
signed webhook ingestion, durable Workflow processing, FAQ-grounded decisions,
immutable Push outbox delivery, automatic handoff, a human support inbox,
transitions and undo, retention operations, and operator documentation.

## Final security and reliability work

The whole-branch review findings were resolved in combined TDD waves:

- The public LINE webhook and Workflow internal routes bypass browser-session
  middleware while retaining their own authentication.
- Webhook input is byte-limited while streaming, event count is capped, and
  non-user/non-message behavior is bounded.
- LLM calls have a deadline and retry classification; reply/clarify content is
  deterministically grounded in cited FAQ material, and risky or injected
  input fails closed.
- Human ownership is monotonic, transitions are fenced, and automated delivery
  cannot race past human takeover.
- Reply, clarify, and automatic non-text handoff recover the exact persisted
  outbox after a post-commit/pre-delivery failure. Recovery never duplicates
  the decision, message, outbox, retry key, or Push.
- A terminal handoff replay finalizes only; it does not send again.
- Inbox pagination is keyset-based and reachable through Load more. Inbox,
  transition, detail, AI batch, and retention work are explicitly bounded.
- Production query-plan tests cover the inbox and decision-timeline indexes.
  Post-0004 migrations follow the documented manual-metadata policy and the
  backup-gated verifier.

## Final local evidence

- Full test suite: `npm.cmd test` — 496/496 passed.
- Focused replay/batch/fence tests: 5/5 passed.
- Affected support suites: 68/68 passed.
- Runtime configuration check: passed with disposable process-scoped values.
- Production build: passed; Workflow compiled 4 steps and 1 workflow.
- `git diff --check`: passed.
- Whole-branch secret scan: no credential-like matches; email matches were
  synthetic `example.com` fixtures.
- No lint script exists in `package.json`.
- Dependency advisory lookup was not run because it would disclose dependency
  metadata to the registry from this environment.

## Explicitly unverified

No live LINE, LLM, remote database, migration, credential, deployment, or
real-message action was performed. Authenticated browser QA against real
database state was also not run. UI changes received static structural review
and automated interaction/state coverage; a manual desktop/mobile pass remains
appropriate after an authorized test deployment.

Production migration remains manual-only. Follow
`docs/line-support-runbook.md`, verify a restorable backup first, and execute
the backup-gated migration only during an authorized maintenance window.

## Remaining non-blocking follow-ups

- Add a commercial-grade data-subject erasure flow and key rotation/purpose
  separation before expanding beyond the owner and dedicated test accounts.
- Migrate deprecated Next.js middleware convention to proxy when convenient.
- Resolve the existing multi-lockfile workspace-root build warning.
- Add rendered browser tests for the support inbox if the project adopts a
  browser test harness.

## Publishing

The branch may be pushed and opened as a ready-for-review PR after the final
confirmation review remains free of Critical/Important findings and GitHub
authentication is available.
