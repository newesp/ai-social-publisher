# LINE Support production handoff — 2026-07-21 (Asia/Taipei)

## Current state

- **Branch / head:** `codex/line-ai-customer-support` at `9f664f5` (`fix: capture support input values eagerly`).
- **Pull request:** https://github.com/newesp/ai-social-publisher/pull/4 is merged. The commits after it (`452755c` and `9f664f5`) require a follow-up PR from `codex/line-ai-customer-support` into `main`.
- **Code verification:** the full suite previously passed (`498/498`). After `9f664f5`, the focused settings and input-safety suite passed (`14/14`).
- **Production deployment:** verified ready deployment `dpl_FpGd4gXHLNpDNtcvkP4eSX9Guy3s`, aliased to `https://ai-social-publisher.vercel.app`. Its Vercel build passed runtime-config validation and Next.js build.

## Incident and root cause

The Support tab initially returned 500 for both:

- `GET /api/support/conversations`
- `GET /api/support/configuration/state`

The direct production cause was an incomplete release configuration:

1. Turso's `auto-posting` database did not contain the `support_*` schema.
2. Vercel Production had empty `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` values.

The generic client error was expected from `routeErrorResponse`; commit `452755c` changes a missing `support_*` table error to a safe, actionable 503 without returning database details.

## Follow-up client crash

After the production schema/configuration repair, editing the Support tab's brand or assistant name could crash the browser page. This was a client-side React event-lifetime issue, not a database or API failure: deferred form state updaters read `event.currentTarget.value` after the input event had completed.

Commit `9f664f5` captures the text during the input handler before queuing the state update. It applies the same safeguard to the Support FAQ text inputs and adds the focused regression test `tests/support-input-safety.test.js`. The fix was deployed in `dpl_FpGd4gXHLNpDNtcvkP4eSX9Guy3s`.

## Completed live operations

All of the following were explicitly authorized by the user.

1. Created and retained Turso rollback branch `auto-posting-backup-verify-20260721` from production database `auto-posting`.
2. Verified the branch was readable and contained the pre-migration schema/data. It showed no `support_*` tables, corroborating the incident root cause.
3. Created a replacement Turso Read & Write database token and stored the active token in Vercel Production only. Do **not** expose token values.
4. Configured Vercel Production variables `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` with non-empty values.
5. Ran the guarded production command after the backup confirmation:

   ```powershell
   $env:SUPPORT_MIGRATION_BACKUP_CONFIRMED = 'YES'
   node scripts\apply-support-schema.mjs
   ```

   Result: `LINE support schema migration and verification complete.` The script performs atomic migration and verifies required support tables/indexes.
6. Deployed the support schema/configuration repair to Vercel Production (`dpl_FgU8x6Jhs9TaUyaoFi3rrsHsbCDQ`), then deployed the Support input-crash fix (`dpl_FpGd4gXHLNpDNtcvkP4eSX9Guy3s`). Both deployments were `READY` and updated the production alias.
7. The user manually disabled Cron Jobs before migration and later manually re-enabled them.

No LINE message, LLM invocation, or live support workflow smoke action was performed.

## Remaining verification (do not claim complete until done)

- **Authenticated smoke test is unverified.** The agent browser could not access the user's Google app session. An unauthenticated GET returned a 307 login redirect rather than 500, but that does not exercise the database queries. The user reported logging in, but no independent HTTP 200 evidence was captured. Ask the user to refresh the Support tab, enter text in the brand/assistant fields, and confirm that conversations/configuration load successfully; alternatively inspect Vercel runtime logs for HTTP 200 responses on both endpoints.
- **Cron re-enable is user-reported, not independently verified.** Confirm in Vercel Project Settings → Cron Jobs if an audit record is required.
- **Rollback branch must be retained** until authenticated smoke verification and the agreed rollback window have passed. Do not delete it as routine cleanup.

## Security follow-up

During token capture, an initial newly-created Turso token could not be captured via the browser clipboard. A replacement token was then created and configured in Vercel. The first token is unused but may remain valid.

- Do **not** use Turso's `Invalidate All Tokens` control without explicit approval: it could disrupt unknown clients.
- With explicit authorization, rotate/revoke the unused token through Turso's least-disruptive token-management mechanism, then retain only the Vercel-configured active token.
- Temporary local token and Vercel environment-export files were deleted. No secret value belongs in this document, Git, Vercel logs, or an issue.

## Safe next-agent procedure

1. Work from `E:\Leo\Projects\Auto-posting\.worktrees\line-ai-customer-support` on `codex/line-ai-customer-support`.
2. Read this handoff and `docs/line-support-runbook.md` before any production action.
3. Obtain the authenticated Support-tab result. If it fails, collect only safe Vercel log metadata/error categories; do not run migrations again blindly.
4. If both GETs return 200 and the UI loads without an input crash, record the smoke result, retain the rollback branch for the agreed period, and arrange token cleanup under explicit authorization.
5. Any new migration, token rotation, Vercel environment change, deployment, Cron change, LINE action, or LLM action requires explicit user authorization.
