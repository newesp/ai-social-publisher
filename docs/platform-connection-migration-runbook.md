# Platform connection migration runbook

This migration is operator-only. It applies schema migrations `0002` and `0003` (plus any earlier unapplied Drizzle migrations), verifies the resulting connection schema, then removes legacy shared platform credentials and terminalizes unsafe unbound bootstrap targets.

## Before the maintenance window

1. Stop old application workers, cron invocations, and schedulers so old code cannot write during migration.
2. Create and independently verify a restorable Turso/libSQL backup. Record its identifier and timestamp in the change ticket.
3. Configure `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, and `SETTINGS_ENCRYPTION_KEY` in the operator process only.
4. After the backup is verified, set `PLATFORM_MIGRATION_BACKUP_CONFIRMED=YES`. This is an acknowledgement, not a backup mechanism.

## Apply and verify

1. Run `npm run migrate:platform-connections`. The command applies Drizzle schema migrations, verifies both renewal lease columns, the partial unique active-default index, and absence of duplicate active owner/platform rows, then runs legacy cleanup.
2. Record the reported cleaned settings and failed target counts. Investigate unexpected counts before deployment.
3. For diagnosis only, the stages can be run explicitly in order with `npm run migrate:platform-schema` followed by `npm run cleanup:legacy-platform-credentials`; do not reverse this order.
4. Verify no legacy platform credential keys remain and all unsafe unbound pending/draft/scheduled targets are terminal. Never print decrypted settings or credential values.

## Deploy and smoke test

1. Deploy the new application only after schema and cleanup verification succeeds.
2. Start workers and cron on the new version.
3. With dedicated test accounts, verify connection availability, Meta selection, LINE connection, immediate publish, scheduled publish, blocked disconnect, and cancellation. Do not use customer accounts.

## Failure and recovery

- If schema application or verification fails, keep workers stopped. Do not run cleanup. Diagnose against a restored copy before retrying.
- If cleanup fails, its transaction rolls back. Keep workers stopped, preserve logs without secrets, correct the cause, and rerun the orchestrator.
- If recovery requires restoration, restore the verified backup, confirm the pre-migration schema/data state, and redeploy the prior application version before restarting workers.
- Never partially hand-edit encrypted settings, lease fields, or connection states in production.
