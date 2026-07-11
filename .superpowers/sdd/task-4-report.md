# Task 4 report: Wizard, history, and schedule UI

## Implemented

- Replaced the retired client call to `/api/posts/manual/publish` with `POST /api/posts`.
- The wizard builds its request from the editable Meta and LINE preview targets, including the selected image URL.
- Added immediate publishing and scheduled publishing actions. Scheduled posts accept a date and the single Asia/Taipei `09:00` option; client-side validation rejects past Taiwan dates before an API request.
- Kept Instagram out of the selectable/published UI by using the existing active-platform configuration (Meta and LINE only).
- Replaced the hard-coded history rows with owner-scoped `GET /api/posts` data, including statuses, timestamps, safe errors, and cancellation only for scheduled rows via `DELETE /api/posts/:id`.
- Replaced malformed strings in the touched wizard/history surfaces.

## TDD evidence

1. Added tests for submission payload formation, fixed schedule time and past-date validation, history loading/cancellation, and UI wiring.
2. Observed the new helper/UI tests fail first because their modules and API wiring did not exist.
3. Added the minimal submission/history helpers and UI wiring, then reran the tests successfully.

## Verification

- `node --test` — 84 passed, 0 failed.
- `npm.cmd run build` — production build succeeded.
- `git diff --check` — no whitespace errors.

## Side effects and caveats

- No Meta/LINE publishing was invoked.
- No Turso database writes were performed by tests.
- The Next.js build emits the existing middleware-to-proxy deprecation warning; it is unrelated to Task 4.
