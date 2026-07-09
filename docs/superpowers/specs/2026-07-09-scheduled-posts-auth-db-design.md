# Scheduled Posts, Per-User Settings, Auth, and History Design

## Goal

Build the missing production-shaped flow for AI Social Publisher:

- Google sign in and sign out.
- Demo mode where any Google account can use settings and publishing.
- Production mode where only allowed Google accounts can sign in and use settings and publishing.
- Per-account API key and token settings stored in the database, encrypted at rest.
- Post history and scheduled posts stored in the database.
- Immediate publishing and scheduled publishing through the same publishing core.
- Scheduled post cancellation before a post starts publishing.
- Vercel Hobby-compatible daily scheduling at 9:00 AM Taiwan time for the demo.
- A scheduler core that can later be triggered by n8n, QStash, Inngest, Trigger.dev, or a custom worker without rewriting publishing logic.

## Current State

The app already has useful pieces:

- Next.js App Router routes and pages.
- Google NextAuth provider configuration in `src/lib/auth.js`.
- A Drizzle schema with `posts`, `post_targets`, `settings`, and `audit_logs`.
- Platform publishing logic for active Meta and LINE targets in `src/lib/platforms/publish-service.js`.
- AI generation logic and Vercel Blob upload logic.
- A `vercel.json` cron entry.

The missing pieces are:

- Product routes do not use the DB yet.
- `/api/posts` returns demo data.
- `/history` shows hardcoded rows.
- `/api/cron` is only a placeholder.
- The wizard publishes to `/api/posts/manual/publish`, but that route does not exist.
- Settings currently persist to `data/settings.json`, which is shared across all users and unsuitable for Vercel serverless.
- Auth role checks exist, but settings and publishing are not consistently guarded.

## Requirements

### Demo Mode

- `AUTH_MODE=demo`.
- Any authenticated Google account can sign in.
- Any authenticated Google account can update its own settings.
- Any authenticated Google account can generate, publish, schedule, cancel, and view its own posts.
- Users must not see or cancel other users' posts.
- Users must not read other users' settings.

### Production Mode

- `AUTH_MODE=production`.
- Only emails listed in `ADMIN_EMAILS` can sign in.
- Only those allowed emails can update settings, publish, schedule, cancel, and view posts.
- Data remains scoped per account even in production.

### Scheduling

- The demo uses Vercel Hobby-compatible daily cron.
- The only enabled scheduled time in the UI is 9:00 AM Taiwan time.
- Vercel cron uses UTC, so `vercel.json` must use `0 1 * * *`.
- The UI should still present a schedule button plus a time select, but the time select initially has one value: `9:00 AM`.
- DB records store the exact `scheduledFor` timestamp in UTC.
- Scheduled publishing is not minute-precise in this demo. Posts are published when the daily cron finds them due.

### Future Scheduler Replacement

The scheduler trigger must be separate from scheduler behavior:

- The scheduler behavior lives in `runDuePostScheduler()`.
- Vercel cron is only the first trigger.
- Later, n8n can call a protected endpoint that runs the same scheduler service.
- n8n should preferably trigger the app API rather than directly querying the DB, so locking, publishing, idempotency, and error tracking stay inside the app.

## Data Model

### `posts`

Add ownership and keep scheduled/published state on the parent post.

Required columns:

- `id`: integer primary key.
- `owner_email`: text, required.
- `product_name`: text, required.
- `product_features`: text, required.
- `image_prompt`: text, nullable.
- `image_imgur_url`: text, nullable. Existing name can be kept even if the URL is from Vercel Blob.
- `status`: text, required.
- `scheduled_for`: timestamp integer, nullable.
- `published_at`: timestamp integer, nullable.
- `created_at`: timestamp integer, required.
- `updated_at`: timestamp integer, required.

Allowed parent statuses:

- `draft`: created but not scheduled or published.
- `scheduled`: waiting for a scheduler trigger.
- `publishing`: locked by the publish runner.
- `published`: all active targets published successfully.
- `partial_failed`: at least one active target published and at least one failed.
- `failed`: all active targets failed or a system error prevented publishing.
- `cancelled`: user cancelled before publishing started.

### `post_targets`

Keep one target row per platform.

Required columns:

- `id`: integer primary key.
- `post_id`: integer, required, references `posts.id`.
- `platform`: text, required.
- `content`: text, required.
- `hashtags_json`: text, required, default `[]`.
- `status`: text, required.
- `external_post_id`: text, nullable.
- `error_message`: text, nullable.
- `published_at`: timestamp integer, nullable.
- `created_at`: timestamp integer, required.
- `updated_at`: timestamp integer, required.

Allowed target statuses:

- `draft`.
- `scheduled`.
- `publishing`.
- `published`.
- `failed`.
- `cancelled`.

### `user_settings`

Replace the shared JSON settings store for runtime settings.

The existing `settings` table and `data/settings.json` can remain temporarily for compatibility during implementation, but all runtime settings reads and writes for this feature must use `user_settings`.

Required columns:

- `owner_email`: text, required.
- `key`: text, required.
- `encrypted_value`: text, required.
- `updated_at`: timestamp integer, required.

Primary key:

- `(owner_email, key)`.

The app should store user-entered API keys and tokens here:

- `googleAiApiKey`.
- `openAiApiKey`.
- `metaPageId`.
- `metaPageAccessToken`.
- `instagramUserId`.
- `lineChannelAccessToken`.
- `imgurClientId`.

`metaPageId` is not secret, but it can still be stored in the same table for a simpler per-user settings interface.

### `audit_logs`

Keep audit logs available for future hardening. This feature does not require a full audit UI.

Useful actions:

- `settings_update`.
- `publish`.
- `schedule`.
- `cancel_schedule`.
- `cron_run`.

Audit metadata must not include raw secrets.

## Secret Storage

User settings are stored in DB, encrypted at rest.

Use an app-level environment variable:

- `SETTINGS_ENCRYPTION_KEY`.

Implementation requirements:

- Treat `SETTINGS_ENCRYPTION_KEY` as a base64-encoded 32-byte key.
- Use AES-256-GCM or the existing secret-bundle crypto pattern for authenticated encryption.
- Encrypt values before inserting/updating `user_settings`.
- Decrypt values only on the server side when calling providers.
- Mask settings values in API responses.
- Never return raw secret values to the browser.
- Keep secret import/export compatible with the per-user settings model by reading/writing the signed-in user's settings only.

If `SETTINGS_ENCRYPTION_KEY` is missing, settings write and publish operations should fail with a clear server error. The app should not silently store secrets in plaintext.

## Auth Design

### Policy

Create `src/lib/auth/policy.js` with centralized policy logic:

- `getAuthMode(env)`: returns `demo` unless `AUTH_MODE=production`.
- `canSignInWithGoogle(email, env)`.
- `canUseApp(email, env)`.
- `canPublish(email, env)`.
- `canManageSettings(email, env)`.

Policy behavior:

- Demo mode: any non-empty Google email can sign in and operate on its own data.
- Production mode: only emails in `ADMIN_EMAILS` can sign in and operate.

### Route Guards

Create `src/lib/auth/route-guards.js` with route helpers:

- `requireAppUser()`: returns the current user email or throws 401/403.
- `requirePublisher()`: returns the current user email or throws 401/403.
- `requireSettingsAccess()`: returns the current user email or throws 401/403.

Routes should call these helpers instead of duplicating auth checks.

Middleware must not block `/api/cron`, because Vercel and later n8n will call it without a browser session. The route itself must enforce `Authorization: Bearer ${CRON_SECRET}`.

### Sign In And Sign Out

- Continue using NextAuth Google provider.
- Login page should call the NextAuth sign-in flow.
- Header logout should call the NextAuth sign-out flow.
- Header should show the signed-in user email or an initial derived from the account.

## API Design

### `POST /api/posts`

Creates a post and either publishes now or schedules it.

Request body:

- `productName`.
- `productFeatures`.
- `imagePrompt`.
- `imageUrl`.
- `targets`: array of platform targets with `platform`, `content`, and `hashtags`.
- `mode`: `now` or `scheduled`.
- `scheduledTime`: currently only `09:00`.

Behavior:

- Require a signed-in publisher.
- Use the signed-in email as `owner_email`.
- Insert `posts` and `post_targets`.
- If `mode=scheduled`, set parent and target status to `scheduled` and do not call external platform APIs.
- If `mode=now`, insert first, then call the same publishing service used by scheduler, then persist results.

### `GET /api/posts`

Returns the signed-in user's history and scheduled posts.

Behavior:

- Require a signed-in app user.
- Return only rows where `posts.owner_email` matches the signed-in email.
- Include targets for each post.
- Include status, scheduled time, published time, external IDs, and error messages.

### `DELETE /api/posts/[id]`

Cancels a scheduled post.

Behavior:

- Require a signed-in publisher.
- Only affect rows where `owner_email` matches the signed-in email.
- If status is `scheduled`, update parent and targets to `cancelled`.
- If status is `publishing`, `published`, `partial_failed`, or `failed`, return 409 conflict.
- Do not physically delete the row.

### `POST /api/posts/[id]/publish`

Manual publish or retry endpoint.

Behavior:

- Require a signed-in publisher.
- Only affect rows where `owner_email` matches the signed-in email.
- Allow `draft` and `failed`.
- Do not publish an already `published` post.
- Use the post owner's settings.
- Persist target results.

### `GET /api/cron`

Scheduler trigger endpoint.

Behavior:

- Do not require a user session.
- Require `Authorization: Bearer ${CRON_SECRET}`.
- Call `runDuePostScheduler()`.
- Return a summary with checked count, published count, failed count, and skipped count.
- Do not expose raw post content or secrets in the response.

### `GET /api/settings`

Returns masked settings for the signed-in user.

Behavior:

- Require settings access.
- Load settings where `owner_email` matches the signed-in email.
- Return masked values only.

### `PUT /api/settings`

Updates settings for the signed-in user.

Behavior:

- Require settings access.
- Encrypt each non-empty value.
- Upsert rows by `(owner_email, key)`.
- Return masked settings only.

## Service Boundaries

### `src/lib/settings/user-settings-store.js`

Responsible for per-user settings storage:

- `readUserSettings(ownerEmail)`.
- `getMaskedUserSettings(ownerEmail)`.
- `updateUserSettings(ownerEmail, updates)`.
- `replaceUserSettings(ownerEmail, settings)`.

### `src/lib/settings/settings-encryption.js`

Responsible for encrypting and decrypting DB settings values:

- `encryptSettingValue(value, env)`.
- `decryptSettingValue(encryptedValue, env)`.

### `src/lib/posts/post-repository.js`

Responsible for DB CRUD:

- Create posts and targets.
- List posts with targets by owner.
- Find a post with targets by ID and owner.
- Find due scheduled posts.
- Mark scheduled post cancelled.
- Mark post publishing.
- Persist publish results.

### `src/lib/posts/post-service.js`

Responsible for user-facing use cases:

- `createScheduledPost({ ownerEmail, input })`.
- `createAndPublishPost({ ownerEmail, input })`.
- `cancelScheduledPost({ ownerEmail, postId })`.
- `publishExistingPost({ ownerEmail, postId })`.

### `src/lib/scheduler/run-due-post-scheduler.js`

Responsible for scheduler behavior:

- Query due scheduled posts where `scheduled_for <= now` and status is `scheduled`.
- Lock each post by moving it to `publishing`.
- Publish each locked post.
- Persist success, partial failure, and failure results.
- Continue processing other due posts if one post fails.

### `src/lib/posts/publish-runner.js`

Responsible for translating stored DB rows into platform publish payloads and calling `publishTargets()`.

Rules:

- Use the post owner's decrypted settings.
- Build platform previews/payloads from stored targets and image URL.
- Update target statuses individually.
- Compute parent post status from target statuses.

## UI Design

### Wizard

The final wizard step should show:

- Editable platform previews.
- Mode control: `Publish now` or `Schedule`.
- When `Schedule` is selected, show a time select.
- The time select currently has exactly one enabled value: `9:00 AM`.
- The schedule button creates a scheduled DB row and does not call external platform APIs.
- The publish-now button creates a DB row and then publishes immediately.

Button behavior:

- `Publish now`: calls `POST /api/posts` with `mode=now`.
- `Schedule`: calls `POST /api/posts` with `mode=scheduled` and `scheduledTime=09:00`.

### History And Schedule Page

Replace hardcoded rows with data from `GET /api/posts`.

Display:

- Product name.
- Platforms.
- Parent status.
- Target statuses.
- Scheduled time.
- Published time.
- Error messages.
- Cancel button for `scheduled` posts.

Cancel button behavior:

- Calls `DELETE /api/posts/[id]`.
- On success, row status becomes `cancelled`.
- On 409, refresh and show the current status.

### Settings Page

Use per-user DB settings instead of the shared JSON file.

Behavior:

- Load masked settings for the signed-in user.
- Save only the signed-in user's settings.
- Never show raw stored secret values.

## Error Handling

### Missing Provider Settings

- Scheduling can succeed even if provider settings are missing.
- Publishing fails with a clear error if required settings are missing.
- The post and target rows store the failure status and error message.

### Partial Platform Failure

- Successful targets become `published`.
- Failed targets become `failed`.
- Parent post becomes `partial_failed`.

### Duplicate Scheduler Trigger

- Scheduler only processes rows in `scheduled` status.
- Scheduler moves a row to `publishing` before calling external providers.
- If a row is already `publishing`, it is skipped.

### Cancel Race

- Cancelling a `scheduled` row succeeds.
- Cancelling a `publishing` row returns 409 conflict.
- Cancelling a completed row returns 409 conflict.

## Deployment Configuration

`vercel.json`:

```json
{
  "crons": [
    {
      "path": "/api/cron",
      "schedule": "0 1 * * *"
    }
  ]
}
```

Required demo env:

```env
AUTH_MODE=demo
NEXTAUTH_URL=https://your-vercel-domain.example
NEXTAUTH_SECRET=replace-with-random-secret
GOOGLE_CLIENT_ID=replace-with-google-client-id
GOOGLE_CLIENT_SECRET=replace-with-google-client-secret
TURSO_DATABASE_URL=replace-with-turso-url
TURSO_AUTH_TOKEN=replace-with-turso-token
SETTINGS_ENCRYPTION_KEY=replace-with-32-byte-base64-key
CRON_SECRET=replace-with-random-secret
BLOB_READ_WRITE_TOKEN=replace-with-vercel-blob-token
```

Required production env:

```env
AUTH_MODE=production
ADMIN_EMAILS=owner@example.com
```

Production also needs the same DB, auth, encryption, cron, blob, and provider-related env values as demo.

## Testing Plan

### Auth Policy Tests

- Demo mode allows any non-empty Google email.
- Production mode allows only emails in `ADMIN_EMAILS`.
- Production mode rejects unlisted emails.

### Settings Tests

- Settings are stored per owner email.
- One user's masked settings do not include another user's settings.
- Stored values are encrypted, not plaintext.
- Missing `SETTINGS_ENCRYPTION_KEY` fails settings writes.

### Post Repository And Service Tests

- Creating a scheduled post inserts one parent row and target rows.
- Creating a scheduled post stores `owner_email`.
- Listing posts returns only the signed-in owner's posts.
- Cancelling a scheduled post updates parent and target statuses to `cancelled`.
- Cancelling a publishing or published post returns conflict.
- Creating a now post inserts DB rows before publishing.

### Scheduler Tests

- Scheduler selects only due `scheduled` posts.
- Scheduler skips future posts.
- Scheduler skips cancelled, published, and already publishing posts.
- Scheduler uses each post owner's settings.
- Scheduler updates targets and parent post on full success.
- Scheduler updates parent post to `partial_failed` on mixed target results.
- Scheduler continues after one post fails.

### API Tests

- `/api/cron` rejects missing or wrong bearer secret.
- `/api/cron` accepts `Authorization: Bearer ${CRON_SECRET}`.
- `/api/posts` requires a signed-in user.
- `/api/posts` scopes reads and mutations by owner email.
- `/api/settings` scopes reads and writes by owner email.

### UI Logic Tests

- Wizard starts in publish-now mode.
- Selecting schedule shows the time select.
- Time select has one option: `9:00 AM`.
- Schedule submission calls `POST /api/posts` with `mode=scheduled`.
- Publish-now submission calls `POST /api/posts` with `mode=now`.

## Open Future Extensions

These are intentionally out of scope for this implementation but supported by the design:

- Add more schedule times to the UI.
- Trigger `runDuePostScheduler()` from n8n at a higher frequency.
- Replace `owner_email` with `workspace_id` for team accounts.
- Add an audit log UI.
- Add retry controls per failed target.
- Add Instagram publishing once the platform is activated.
