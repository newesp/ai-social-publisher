# Final fix wave report

## Scope and safety

- Implemented only the approved disconnect, transactional binding, renewal lease, Meta validation/refresh, schema, migration, UI conflict handling, and design-document reconciliation.
- Preserved Change account archival semantics and the existing operator-only legacy credential cleanup migration.
- Did not call live Meta, LINE, OAuth, publish, disconnect, account-management, production database, migration, or deployment endpoints. Provider behavior used deterministic injected fakes only.
- Did not modify or delete unrelated `.superpowers/sdd` artifacts; the pre-existing dirty `task-3-report.md` remains outside this wave.

## TDD evidence

### Important 1: disconnect semantics

- RED: repository tests failed because `disconnectActiveConnection` did not exist; blocked/unblocked cases could not enforce the transaction gate.
- GREEN: libSQL tests prove pending/draft/scheduled/publishing references block without mutation, terminal history remains bound, owner/platform isolation holds, and successful disconnect atomically changes state to `disconnected`, clears encrypted credentials/expiry/lease, and is idempotent.
- RED: route/store/UI focused run had 6 expected failures because production still called `archiveDefault`, had no `disconnectDefault`, no LINE revoke, and no 409 UI branch.
- GREEN: 30/30 route/store/UI tests passed. LINE revoke uses only form-encoded `access_token`; provider failure/body is redacted; Meta performs no provider call; 409 retains the connected UI state and shows the cancel/wait message.

### Important 2: create-transaction binding

- RED: stale archived binding inserted a post because the repository trusted service pre-resolution; test failed with “Missing expected rejection.”
- GREEN: connection ID + normalized owner + platform + active state are rechecked before parent insertion. Stale/foreign/missing rows throw the generic 409 and roll back all rows.
- RED: the two-client libSQL create/disconnect interleaving initially produced a rejected competing transaction (`SQLITE_BUSY`) rather than a serialized domain outcome.
- GREEN: bounded busy retry around both transactions makes the race resolve only as create+blocked-disconnect or disconnect+rolled-back-create. The impossible create+disconnected state is asserted.

### Important 3: LINE issuance lease

- RED: the first barrier run waited indefinitely because no pre-provider lease acquisition existed; it was terminated after proving the service never reached the lease barrier. The previous concurrent test also allowed two issuance attempts.
- GREEN: an opaque two-minute owner/connection lease is acquired before issuance. Default module-scoped flights share one promise across separately constructed same-process services; injectable independent flight maps simulate cross-process workers. Tests assert one issuance, one bot verification, one credential update, safe valid-token loser fallback, expired retryable loser failure, archived-state preservation, foreign-owner rejection, and expired/crashed lease recovery.
- Failure releases the owned lease best-effort; lease expiry independently guarantees recovery.

### Important 4: Meta pre-publish lifecycle

- RED: 5 focused failures showed `ensureUsable` was absent and the common resolver returned unvalidated Meta credentials.
- GREEN: Graph `v25.0` Page validation uses `Authorization: Bearer` and verifies the returned Page ID. Tests cover valid Page, mismatched ID, credential rejection recovered through retained User authorization plus `/me/accounts`, unextendable reconnect, transient validation fallback, archived bound connection, owner isolation, concurrent winner reuse, and provider-body/secret redaction.
- Immediate, scheduler, and cron paths already share `createPublishingConnectionResolver`; the resolver now calls both LINE and Meta lifecycle services.

## Schema and migration

- Added nullable `renewal_lease_id` and `renewal_lease_expires_at` columns.
- Added `platform_connections_one_active_owner_platform_idx`, a partial unique index for `state = 'active'`.
- Migration `0003_renewal_leases_active_default.sql`, journal entry, and `0003_snapshot.json` were generated with Drizzle. A manual deterministic data-reconciliation statement archives duplicate historical active rows by `updated_at`, then ID, before index creation.
- Offline migration integration applies the SQL to duplicate active rows, verifies the deterministic winner, rejects a second active row, permits archived history, and verifies journal/snapshot metadata.
- `post_targets.platform_connection_id` remains nullable only for bootstrap rows. Application/transaction validation requires binding now; future SQLite/Turso table rebuild can add `NOT NULL` after cleanup.
- No migration was executed against any real database.

## Design decisions and deviations

- Disconnect uses a distinct `disconnected` state and encrypted empty credentials because the existing credential column is `NOT NULL`; it never reuses Change account archival.
- Renewal leases expire after two minutes. LINE rotates at the existing 72-hour threshold. Meta attempts best-effort refresh when validation rejects the Page token or retained User authorization is within seven days of expiry.
- A valid Meta Page token remains usable with a generic warning after transient validation/refresh failures. This is not guaranteed permanent renewal.

## Verification

- Affected focused suites: 89/89 passed.
- Fresh full suite: `npm.cmd test` — 187/187 passed, 0 failed.
- Production build with process-only dummy configuration: `npm.cmd run build` — exit 0; Next.js compiled, type-checked, collected data, and generated 20/20 static pages.
- `git diff --check` — exit 0.
- Full feature-range high-confidence secret scan — clear.
- Full feature-range non-example email/PII scan — clear.
- Publishing-runtime legacy credential scan (`META_PAGE_ID`, `META_PAGE_ACCESS_TOKEN`, `LINE_CHANNEL_ACCESS_TOKEN`, and aliases) — clear.
- Credential-path logging scan — clear.

## Self-review

- Correctness/logic: found that per-service in-flight maps would not share across production factory instances. Fixed with module-scoped default flight maps while retaining injectable maps for cross-process tests. No remaining Critical/Important finding.
- Security/performance: confirmed all database operations are owner-scoped, provider bodies are discarded, credential clearing precedes best-effort revoke, leases precede provider issuance, and busy retry is bounded. No remaining Critical/Important finding.
- Maintainability/naming/location: moved static imports to file headers, normalized lease naming, kept migration metadata in Drizzle conventions, and updated the existing design doc rather than adding a competing model. No remaining Critical/Important finding.
- Dead code: no new dead export or test-only production method remains. The older archive method remains intentionally used by Change account behavior/tests.

## Concerns and deferred work

- The migration must be applied later by the authorized deployment/operator workflow; this wave intentionally did not execute it.
- `post_targets.platform_connection_id NOT NULL` remains deferred until bootstrap cleanup permits a safe SQLite/Turso table rebuild.
- Live-provider smoke testing was intentionally skipped by explicit constraint. All provider calls were injected fakes.
- Build emitted existing Next.js warnings about multiple lockfiles/workspace-root inference and the deprecated middleware filename convention; neither warning was introduced or changed by this wave.
