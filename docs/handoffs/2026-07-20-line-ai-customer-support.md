# LINE AI Customer Support Session Handoff

## Objective

Finish the approved LINE AI customer-support MVP in the existing
`ai-social-publisher` repository. Each signed-in user owns one LINE Official
Account connection and one isolated support workspace. Automated replies use
the configured LLM provider, FAQ-grounded structured decisions, durable
Workflow processing, and an immutable Push outbox. Human agents reply only
through the product inbox for the MVP.

## Repository State

- Repository: `E:\Leo\Projects\Auto-posting`
- Isolated worktree:
  `E:\Leo\Projects\Auto-posting\.worktrees\line-ai-customer-support`
- Branch: `codex/line-ai-customer-support`
- Task 7 implementation commit: `ad499a0 fix: centralize LINE support batch fencing`
- Recovery design/plan commit: `6037bec docs: define Task 7 recovery architecture`
- Branch base: `d9601de`
- Upstream: none configured for this branch
- Worktree status at handoff creation: clean before this handoff document
- Plan:
  `docs/superpowers/plans/2026-07-19-line-ai-customer-support.md`
- Design:
  `docs/superpowers/specs/2026-07-19-line-ai-customer-support-design.md`
- Durable progress ledger: `.superpowers/sdd/progress.md`

Trust the ledger and Git history over conversational memory. Do not repeat a
task marked complete.

## Completed Gates

- Task 1: Workflow SDK smoke and protected local route.
- Task 2: support schema, strict local migrations, and backup-gated migration
  entrypoint.
- Task 3: owner-scoped support configuration and FAQ APIs.
- Task 4: LINE webhook provisioning, readiness, provider test, settings UI,
  and FAQ UI.
- Task 5: signed webhook ingestion, inbound event deduplication, encrypted
  identifiers, durable event claims, and immutable Push outbox.
- Task 6: deterministic FAQ retrieval and fail-closed structured support
  decisions.
- Task 7: identifier-only durable provider steps, three-second batching,
  jointly fenced terminal writes, immutable Push delivery, safe handoff, and
  durable follow-up scheduling.

Tasks 1–6 passed their recorded independent review gates. Task 7 passed the
user-authorized controller recovery acceptance gate after three earlier broad
review/fix cycles remained non-compliant. Commit ranges and known limitations
are recorded in `.superpowers/sdd/progress.md`.

## Current Gate: Task 7 Complete — Stop Requested

Task 7 is complete. Do not begin Task 8 until the user gives a new explicit
instruction.

- Recovery commit: `ad499a0 fix: centralize LINE support batch fencing`
- Report: `.superpowers/sdd/line-support-task-7-report.md`
- Recovery RED: 33 passed, 8 expected failures
- Recovery GREEN: 41/41 passed
- Complete Task 7 focused evidence: 57/57 passed
- Full suite evidence: `npm.cmd test` — 427/427 passed
- Production build: passed with command-scoped disposable values;
  `workflows build complete (4 steps, 1 workflow)`
- Diff/secret gate: clean; no Task 8 files changed
- No live LINE, LLM, remote database, deployment, credential, or migration
  action was performed

First action in the next session:

1. Read this handoff and `.superpowers/sdd/progress.md`.
2. Confirm Task 7 remains complete at or after `ad499a0`; do not repeat its
   implementation or review cycles.
3. Start Task 8 only after a new explicit user instruction.

## Remaining Tasks

- Task 8: owner-scoped support inbox APIs and responsive read UI.
- Task 9: human Push replies, takeover, ten-second return/resolve transitions,
  global undo, refresh/navigation recovery, and stale-state fencing.
- Task 10: retention cleanup, safe observability, runbook/README, local
  acceptance, visual QA, and the explicit live-MVP authorization gate.

Do not combine Tasks 8 and 9. They have different data-mutation and concurrency
risk. Task 10 must stop before live acceptance until the user explicitly names
the dedicated test LINE Official Account, test LINE user, deployed URL,
selected LLM provider/model, and exact messages.

## Binding Architecture Decisions

- Browser responses never expose owner email, LINE user ID, connection ID,
  tokens, credentials, webhook keys/hashes, configuration versions, or raw
  provider errors.
- Webhook signatures use the untouched raw request body. Official event ID plus
  connection scope is the inbound deduplication authority.
- External Workflow dispatch is at-least-once. The first durable event claim
  prevents duplicate LLM/outbox creation.
- Automated AI replies use Push, not Reply.
- Every automated outbound delivery is an immutable persisted record. Its
  canonical RFC 4122 UUID is the stable `X-Line-Retry-Key`; recipient and
  canonical request body never change.
- Retry identical Push requests only for timeout/transport failures explicitly
  marked retryable or 5xx. Treat 2xx and accepted 409 as sent. Other 4xx and
  unclassified failures are terminal.
- A delivery still unknown after LINE's 24-hour retry-key window enters human
  review. Never create a replacement key automatically.
- Explicit-human requests, refund/payment risk, personal-data incidents,
  prompt injection, invalid structured output, unsupported FAQ citations, and
  insufficient knowledge fail closed to human support.
- Support disable is always allowed. Enablement is repository-authoritative
  and atomically rechecks current FAQ, provider key/model, active LINE
  connection, webhook readiness, and acknowledgements.
- All owner and connection boundaries remain server-side and normalized.

## Verification and Environment Notes

- On this Windows host, use `npm.cmd test`; `npm test` may be blocked by the
  PowerShell `npm.ps1` execution policy before tests run.
- Production builds need required runtime configuration. Use disposable,
  process-scoped synthetic values for local verification; do not write fake or
  real secrets into repository files.
- Existing non-blocking build warnings:
  - multiple lockfiles/workspace-root inference;
  - deprecated Next.js middleware convention.
- Browser discovery previously returned no available backend. Screenshot and
  keyboard visual QA remain unverified; Task 10 must retry it or record the
  environment limitation precisely.
- The owner uses Vercel Hobby and this MVP is for the owner plus dedicated test
  accounts, not commercial traffic.
- Production Turso migrations, deployed Workflow smoke, real LINE messages,
  real LLM calls, Vercel deployment, and production runtime checks remain
  unauthorized and unverified.

## Token-Efficient Execution Policy

For each remaining task:

1. Use one implementer with a task brief, report path, and `fork_turns: "none"`.
2. The implementer uses focused tests and performs self-review. It does not
   dispatch nested reviewers.
3. Use one controller-dispatched independent reviewer and require one complete
   verdict containing all findings.
4. Resolve all Critical and Important findings in one combined fix wave, then
   perform one re-review.
5. Use focused or covering tests during implementation and fixes.
6. Run the final-head full suite, production build, diff check, and secret scan
   once after the last material fix before marking the task complete.
7. Pass file paths, not pasted plan/history content.

Model policy:

- Mechanical implementation: `gpt-5.6-terra`, medium reasoning.
- Task 8/9 multi-file integration, concurrency work, and all task reviewers:
  `gpt-5.6-terra`, high reasoning.
- Task 10 implementation: `gpt-5.6-terra`, medium or high according to the
  remaining integration risk.
- Final whole-branch architecture/security review only:
  `gpt-5.6-sol`, ultra reasoning.

Every dispatch must set `model`, `reasoning_effort`, and
`fork_turns: "none"` explicitly. If a model is unavailable or quota-blocked,
report the fallback; never silently inherit the controller model.

## Ready-to-Paste Startup Prompt

```text
Use collaborate-with-me and Subagent-Driven Development.

Continue the LINE AI customer-support implementation from:
E:\Leo\Projects\Auto-posting\.worktrees\line-ai-customer-support

Read first:
1. docs/handoffs/2026-07-20-line-ai-customer-support.md
2. .superpowers/sdd/progress.md
3. docs/superpowers/plans/2026-07-19-line-ai-customer-support.md

Trust the ledger and Git history. Do not repeat completed tasks. Task 7 is
complete through `ad499a0`. Stop unless the user explicitly requests Task 8.

For every implementer and task reviewer, explicitly use:
model: gpt-5.6-terra
reasoning_effort: high
fork_turns: none

Mechanical Task 10 work may use Terra medium. Use gpt-5.6-sol with high
reasoning only for the final whole-branch architecture/security review.
Do not allow implementers to spawn nested reviewers. Require one complete
task-review verdict, one combined Critical/Important fix wave, and one
re-review. Use focused tests during work and one final full-suite/build gate
after the last material fix.

Do not deploy, migrate a remote database, call a real LINE or LLM provider,
write production secrets, or send real messages without new explicit
authorization.
```

## Skill Synchronization Performed in the Previous Session

The token-efficient execution and model-selection policy was added identically
to:

- `C:\Users\Administrator\.codex\skills\collaborate-with-me\SKILL.md`
- `E:\Leo\Projects\my-skills\collaborate-with-me\SKILL.md`

The files had matching SHA-256 values immediately after synchronization. The
repository copy under `E:\Leo\Projects\my-skills` was not committed or pushed
as part of this project handoff.
