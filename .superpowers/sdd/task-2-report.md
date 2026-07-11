# Task 2 Report: Per-User Encrypted Settings Store

## Outcome

Replaced the shared local `data/settings.json` runtime path with encrypted, owner-keyed `user_settings` records. Settings, generation, and publishing now use the normalized owner returned by the existing NextAuth route guards. No remote database operation, provider call, or social-platform call was made.

## Data and Route Decisions

- Added `user_settings` with `owner_email` primary key, `encrypted_settings`, and `updated_at`.
- Added a repository backed by Drizzle/libSQL and a store that encrypts complete per-owner settings payloads with AES-256-GCM. `SETTINGS_ENCRYPTION_KEY` is required at request time.
- Only `metaPageId` is returned unmasked; all other supported values are masked. Empty/whitespace updates preserve existing values, while masked placeholders are rejected.
- Settings GET/PUT use `requireSettingsAccess`; generate uses `requireAppUser`; publish derives its settings owner with `requirePublisher`.
- Import/export endpoints are retired with HTTP 410 so their previous shared-secret path is unreachable.
- Settings UI now supports Meta and LINE credentials only; it removes Imgur, Instagram, admin-only wording, and the import/export UI. Image generation remains on the existing Vercel Blob flow.

## TDD Evidence

1. Added owner-isolation/encryption/masking/empty-preservation/placeholder-rejection tests in `tests/settings-store.test.js`.
   - RED: `npm.cmd test -- tests/settings-store.test.js` failed with `ERR_MODULE_NOT_FOUND` for the new store module.
   - GREEN: focused store and route tests passed after implementation.
2. Added session-owner propagation tests in `tests/settings-routes.test.js`.
   - RED: focused test run failed with `ERR_MODULE_NOT_FOUND` for the new route-handler module.
   - GREEN: handlers pass the session-derived owner to reads/updates.
3. Added the settings UI scope test in `tests/settings-panel.test.js`.
   - RED: it failed while the panel still contained Imgur/Instagram/admin/import-export UI.
   - GREEN: it passed after the panel was reduced to Meta/LINE and AI settings.
4. Added the publish settings-owner test in `tests/publish-settings-ownership.test.js`.
   - RED: it failed because the route called `readSettings()` without an owner.
   - GREEN: it passes after `requirePublisher()` supplies `ownerEmail`.
5. Build-regression investigation and correction:
   - Reproduction: `npm.cmd run build` compiled then failed collecting `/api/settings` with `LibsqlError: URL_INVALID` for an undefined Turso URL.
   - Root cause: Task 2 route modules eagerly invoked `getUserSettingsStore()` at import time, which constructed the libSQL client during build-time static collection.
   - Added `tests/settings-route-initialization.test.js` and deferred creation by passing `getUserSettingsStore` as a factory. Route handlers authenticate first and then call the factory at request time.
   - RED: `npm.cmd test -- tests/settings-routes.test.js tests/settings-route-initialization.test.js` failed (three failures) before the lazy factory implementation.
   - GREEN: the same focused suite passed after the one deferred-construction change.

## Verification

- `npx.cmd drizzle-kit generate` succeeded locally and generated `drizzle/0000_yellow_the_renegades.sql`.
- Focused tests: `npm.cmd test -- tests/settings-routes.test.js tests/settings-route-initialization.test.js tests/settings-store.test.js tests/settings-panel.test.js tests/publish-settings-ownership.test.js` — 10/10 passed.
- Full tests: `npm.cmd test` — 58/58 passed.
- Production build: `npm.cmd run build` — passed. Next emitted its pre-existing middleware-to-proxy deprecation warning.
- `git diff --check` — passed.

## Self-Review

- Owner identity is taken only from the central session-derived route guards; request bodies do not select an owner.
- No raw setting is returned by the settings API except the explicitly public Meta Page ID.
- The legacy filesystem settings store and route access to it were removed.
- Lazy store construction avoids both build-time database client creation and changing unauthenticated requests from 401 to configuration errors.
- No active platform beyond Meta/LINE is exposed in the edited settings UI.

## Concerns / Follow-up

- The repository had no existing Drizzle migration history. The locally generated initial migration contains all schema tables, not only `user_settings`; do not apply it blindly to an already-provisioned Turso database. Reconcile it with the actual remote schema before a separately authorized migration/push.
- Runtime settings requests require `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, and `SETTINGS_ENCRYPTION_KEY`; missing configuration correctly fails rather than falling back to a shared local file.
- No live Meta/LINE, paid provider, remote Turso, Drizzle push, or Turso mutation was performed.
