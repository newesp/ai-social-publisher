# Per-user Platform Connections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let every Google SSO user securely connect their own Meta Page and LINE Messaging API Channel, publish only through connected platforms, retain the selected account for scheduled posts, and automatically rotate renewable credentials.

**Architecture:** Add encrypted `platform_connections` and short-lived `oauth_transactions` records, while leaving AI keys in `user_settings`. A post target receives its immutable connection ID inside the create transaction; immediate and scheduled publishing load that connection instead of the user's current settings. Meta uses a server-side OAuth code flow and Page picker; LINE stores the submitted Channel ID/Secret and rotates a short-lived Channel Access Token.

**Tech Stack:** Next.js App Router, NextAuth Google SSO, Drizzle ORM/libSQL, Node `crypto` AES-256-GCM, Mantine, Node built-in test runner.

## Global Constraints

- Owner identity remains the authenticated, normalized Google email; every read/write joins on owner email.
- Do not expose Meta User/Page Tokens, Meta App Secret, LINE Channel Secret, or LINE Channel Access Tokens in API output, logs, UI, or errors.
- Meta OAuth settings use `META_APP_ID`, `META_APP_SECRET`, `META_OAUTH_REDIRECT_URI`, Graph API `v25.0`, and scopes `pages_show_list,pages_read_engagement,pages_manage_posts`.
- LINE issuance uses `POST https://api.line.me/v2/oauth/accessToken` with form-encoded `grant_type=client_credentials`, `client_id`, and `client_secret`; renew at `expiresAt - 72 hours`.
- A Meta authorization that cannot be extended, or a provider-rejected credential, becomes `needs_reconnect`; never claim guaranteed silent Meta renewal.
- No legacy platform credential is migrated. Remove it, require reconnection, and fail any pre-feature target without a connection ID safely.
- New selected targets must have an immutable connection ID. Changing a default affects future posts only.
- All platform-management routes require the signed-in owner and same-origin POST protection; no live provider call belongs in automated tests.

---

## File structure

- `src/lib/settings/credential-crypto.js`: shared AES-GCM JSON encryption/decryption used by user settings, connections, and OAuth transactions.
- `src/lib/platform-connections/*.js`: connection state, repository, store, Meta OAuth, LINE token issuance/renewal, and route handlers.
- `src/app/api/platform-connections/**/route.js`: owner-scoped API endpoints for availability, Meta OAuth, Page selection, LINE connect, and disconnect.
- `drizzle/0002_per_user_platform_connections.sql`, `src/lib/db/schema.js`: tables, indexes, and post-target connection column.
- `src/lib/posts/*`, `src/lib/platforms/publish-service.js`: bind and resolve connections during post creation and publishing.
- `src/components/SettingsPanel.js`, `src/components/CreatePostWizard.js`: smooth connection cards and connected-platform-only selection.
- `scripts/remove-legacy-platform-credentials.mjs`: one-time production migration; never run automatically in development or tests.
- `tests/*platform-connection*.test.js`, existing post/settings/wizard tests: deterministic provider mocks and owner-isolation coverage.

### Task 1: Persist encrypted platform connections and OAuth transactions

**Files:**
- Create: `drizzle/0002_per_user_platform_connections.sql`
- Create: `src/lib/settings/credential-crypto.js`
- Create: `src/lib/platform-connections/platform-connections-repository.js`
- Create: `src/lib/platform-connections/platform-connection-store.js`
- Create: `src/lib/platform-connections/oauth-transaction-store.js`
- Modify: `src/lib/db/schema.js`
- Modify: `src/lib/settings/user-settings-store.js`
- Test: `tests/platform-connection-store.test.js`
- Test: `tests/user-settings-store.test.js`

**Interfaces:**
- Produces `createPlatformConnectionStore({ repository, encryptionKey })` with `create(ownerEmail, input)`, `getDefault(ownerEmail, platform)`, `getById(ownerEmail, connectionId)`, `replaceCredentials(ownerEmail, connectionId, credentials)`, `archive(ownerEmail, connectionId)`, and `listAvailability(ownerEmail)`.
- Produces `createOAuthTransactionStore({ repository, encryptionKey })` with `create(ownerEmail, provider, payload, returnPath, now)`, `consume(ownerEmail, id, now)`, and `purgeExpired(now)`.

- [ ] **Step 1: Write failing store tests**

```js
test("connection credentials are encrypted and isolated by owner", async () => {
  const store = createPlatformConnectionStore({ repository, encryptionKey: "test-key" });
  const connection = await store.create("owner@example.com", {
    platform: "line", displayName: "Owner OA", credentials: { channelSecret: "secret" },
  });
  assert.equal((await store.getById("other@example.com", connection.id)), null);
  assert.equal(repository.records.get(connection.id).encryptedCredentials.includes("secret"), false);
});

test("OAuth transactions are single-use, owner-bound, and expire after ten minutes", async () => {
  const transaction = await store.create("owner@example.com", "meta", { pages: [] }, "/settings", now);
  assert.deepEqual(await store.consume("owner@example.com", transaction.id, now), { pages: [] });
  await assert.rejects(store.consume("owner@example.com", transaction.id, now), /expired or already used/i);
});
```

- [ ] **Step 2: Run the new tests and confirm they fail because the stores do not exist**

Run: `node --test tests/platform-connection-store.test.js`

Expected: failure resolving `platform-connection-store.js`.

- [ ] **Step 3: Add schema and shared encryption implementation**

```js
export function encryptJson(value, encryptionKey) { /* v1.<iv>.<tag>.<ciphertext>, AES-256-GCM */ }
export function decryptJson(value, encryptionKey) { /* reject malformed or unauthenticated payloads */ }

export const platformConnections = sqliteTable("platform_connections", {
  id: text("id").primaryKey(), ownerEmail: text("owner_email").notNull(),
  platform: text("platform").notNull(), displayName: text("display_name").notNull(),
  state: text("state").notNull(), encryptedCredentials: text("encrypted_credentials").notNull(),
  credentialExpiresAt: integer("credential_expires_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});
```

Add `oauth_transactions` with encrypted payload, owner, provider, return path, expiry, and consumed time. Add nullable `post_targets.platform_connection_id` and indexes on owner/platform/state and transaction expiry. Refactor `user-settings-store.js` to import the shared crypto module and remove all platform token keys from `SETTING_KEYS`.

- [ ] **Step 4: Implement repositories and stores with owner-scoped queries**

```js
async function getById(ownerEmail, id) {
  const record = await repository.findByIdAndOwner(id, normalizeOwner(ownerEmail));
  return record ? toConnection(record, key) : null;
}

async function consume(ownerEmail, id, now) {
  const record = await repository.consume(id, normalizeOwner(ownerEmail), now);
  if (!record || record.expiresAt <= now) throw new Error("OAuth transaction is expired or already used.");
  return decryptJson(record.encryptedPayload, key);
}
```

Store only encrypted credential payloads. `listAvailability` returns `{ platform, state, displayName, expiresAt }` and never the credential object.

- [ ] **Step 5: Run focused tests**

Run: `node --test tests/platform-connection-store.test.js tests/user-settings-store.test.js`

Expected: PASS; encrypted repository rows contain none of the fixture secrets.

- [ ] **Step 6: Commit**

```bash
git add drizzle src/lib/db/schema.js src/lib/settings tests/platform-connection-store.test.js tests/user-settings-store.test.js
git commit -m "feat: persist encrypted per-user platform connections"
```

### Task 2: Implement secure Meta OAuth and Page selection APIs

**Files:**
- Create: `src/lib/platform-connections/meta-oauth-service.js`
- Create: `src/lib/platform-connections/platform-connection-route-handlers.js`
- Create: `src/app/api/platform-connections/meta/start/route.js`
- Create: `src/app/api/platform-connections/meta/callback/route.js`
- Create: `src/app/api/platform-connections/meta/select/route.js`
- Create: `src/app/api/platform-connections/route.js`
- Modify: `.env.example`
- Test: `tests/meta-oauth-service.test.js`
- Test: `tests/platform-connection-routes.test.js`

**Interfaces:**
- Produces `createMetaOAuthService({ env, fetchImpl, transactions, connections, now })` with `start(ownerEmail, returnPath)`, `completeCallback(searchParams)`, and `selectPage(ownerEmail, transactionId, pageId)`.
- `GET /api/platform-connections` returns only availability for the session owner.
- `POST /api/platform-connections/meta/start` returns `{ authorizeUrl }`; the client performs the navigation.

- [ ] **Step 1: Write failing Meta flow tests**

```js
test("Meta callback exchanges code, stores a pending Page list, and never returns tokens", async () => {
  const result = await service.completeCallback(new URLSearchParams({ state, code: "code" }));
  assert.deepEqual(result.pages, [{ id: "page-1", name: "Owner Page" }]);
  assert.equal(JSON.stringify(result).includes("page-token"), false);
});

test("selectPage refuses a Page not included in this owner's unconsumed transaction", async () => {
  await assert.rejects(service.selectPage("owner@example.com", transactionId, "other-page"), /not available/i);
});
```

- [ ] **Step 2: Run tests and confirm failure**

Run: `node --test tests/meta-oauth-service.test.js tests/platform-connection-routes.test.js`

Expected: failure resolving the Meta service and routes.

- [ ] **Step 3: Implement authorization URL, callback, and selection**

```js
const scopes = ["pages_show_list", "pages_read_engagement", "pages_manage_posts"].join(",");
const authorizeUrl = new URL("https://www.facebook.com/v25.0/dialog/oauth");
authorizeUrl.searchParams.set("client_id", env.META_APP_ID);
authorizeUrl.searchParams.set("redirect_uri", env.META_OAUTH_REDIRECT_URI);
authorizeUrl.searchParams.set("state", transaction.id);
authorizeUrl.searchParams.set("scope", scopes);

const page = pending.pages.find((item) => item.id === pageId);
if (!page) throw routeError("The selected Meta Page is not available.", 400);
await connections.create(ownerEmail, { platform: "meta", displayName: page.name, credentials: page.credentials });
```

Exchange `code` for a User Token, exchange that for a long-lived User Token, then call `/me/accounts?fields=id,name,access_token`. Persist Page tokens only inside the encrypted transaction/connection records. Provider cancellation and missing server configuration redirect to settings with a generic reconnect message; no provider payload is echoed.

- [ ] **Step 4: Add owner and same-origin guards to the route handlers**

```js
export function requireSameOrigin(request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) throw routeError("Invalid request origin.", 403);
}
```

Call `requireSettingsAccess()` before every read/write, consume transactions with the current owner, and emit `NextResponse.redirect` only to a local settings path.

- [ ] **Step 5: Run focused tests**

Run: `node --test tests/meta-oauth-service.test.js tests/platform-connection-routes.test.js`

Expected: PASS; tests cover cancellation, expired state, another owner's state, and token redaction.

- [ ] **Step 6: Commit**

```bash
git add src/lib/platform-connections src/app/api/platform-connections .env.example tests/meta-oauth-service.test.js tests/platform-connection-routes.test.js
git commit -m "feat: connect Meta Pages through owner-scoped OAuth"
```

### Task 3: Implement LINE connection, validation, and renewable Token lifecycle

**Files:**
- Create: `src/lib/platform-connections/line-channel-service.js`
- Create: `src/app/api/platform-connections/line/route.js`
- Modify: `src/lib/platform-connections/platform-connection-route-handlers.js`
- Test: `tests/line-channel-service.test.js`
- Test: `tests/platform-connection-routes.test.js`

**Interfaces:**
- Produces `createLineChannelService({ fetchImpl, connections, now })` with `connect(ownerEmail, { channelId, channelSecret })` and `ensureUsable(ownerEmail, connectionId)`.
- `POST /api/platform-connections/line` accepts only `{ channelId, channelSecret }` and responds with safe availability.

- [ ] **Step 1: Write failing LINE tests**

```js
test("connect issues a short-lived LINE token and records the verified OA name", async () => {
  const connection = await service.connect("owner@example.com", { channelId: "id", channelSecret: "secret" });
  assert.equal(connection.displayName, "Owner Official Account");
  assert.equal(connection.expiresAt.toISOString(), "2026-08-12T00:00:00.000Z");
});

test("ensureUsable rotates once at 72 hours and concurrent callers reuse the winner", async () => {
  const [first, second] = await Promise.all([service.ensureUsable(owner, id), service.ensureUsable(owner, id)]);
  assert.equal(first.credentials.accessToken, second.credentials.accessToken);
});
```

- [ ] **Step 2: Run tests and confirm failure**

Run: `node --test tests/line-channel-service.test.js`

Expected: failure resolving `line-channel-service.js`.

- [ ] **Step 3: Implement issue, bot-info validation, and atomic renewal**

```js
const response = await fetchImpl("https://api.line.me/v2/oauth/accessToken", {
  method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "client_credentials", client_id: channelId, client_secret: channelSecret }),
});
const token = await readJson(response, "LINE connection failed.");
const profile = await fetchImpl("https://api.line.me/v2/bot/info", { headers: { Authorization: `Bearer ${token.access_token}` } });
```

Set `expiresAt = new Date(now.getTime() + token.expires_in * 1000)`. At or below 72 hours, use a repository conditional update keyed by connection ID and `updatedAt`; on a losing update, reload the winner. Mark only that owner’s connection `needs_reconnect` when its Token is expired or rejected.

- [ ] **Step 4: Add the route and response sanitization**

```js
const body = await request.json();
const connection = await line.connect(ownerEmail, body);
return Response.json({ connection: toAvailability(connection) }, { status: 201 });
```

Reject empty/non-string Channel IDs and Secrets, masked values, cross-origin requests, and provider bodies in responses.

- [ ] **Step 5: Run focused tests**

Run: `node --test tests/line-channel-service.test.js tests/platform-connection-routes.test.js`

Expected: PASS; request fixtures prove `client_secret` and `access_token` never appear in API output.

- [ ] **Step 6: Commit**

```bash
git add src/lib/platform-connections src/app/api/platform-connections tests/line-channel-service.test.js tests/platform-connection-routes.test.js
git commit -m "feat: connect and renew LINE Messaging API channels"
```

### Task 4: Bind selected connections to posts and publish through them

**Files:**
- Modify: `src/lib/posts/post-service.js`
- Modify: `src/lib/posts/post-route-handlers.js`
- Modify: `src/lib/posts/post-repository.js`
- Modify: `src/lib/platforms/publish-service.js`
- Modify: `src/app/api/posts/route.js`
- Modify: `src/app/api/cron/route.js`
- Modify: `src/lib/scheduler/run-due-post-scheduler.js`
- Test: `tests/post-service.test.js`
- Test: `tests/post-route-handlers.test.js`
- Test: `tests/scheduler.test.js`
- Test: `tests/publish-service.test.js`

**Interfaces:**
- `createPost({ ownerEmail, input, repository, resolveConnection, now })` calls `resolveConnection(ownerEmail, platform)` before creating target rows.
- `publishClaimedPost({ post, repository, getConnection, publishTargets, now })` calls `getConnection(post.ownerEmail, target.platformConnectionId)` for each target.
- `publishTargets({ targets, connections, fetchImpl })` receives target-specific credential objects rather than the shared settings object.

- [ ] **Step 1: Write failing binding and scheduling tests**

```js
test("new targets receive the current owner's connection IDs in the create transaction", async () => {
  const post = await createPost({ ownerEmail: "owner@example.com", input, repository, resolveConnection });
  assert.deepEqual(post.targets.map((target) => target.platformConnectionId), ["meta-connection", "line-connection"]);
});

test("a scheduled post uses its stored connection after the owner changes their default", async () => {
  await publishClaimedPost({ post: scheduledPost, getConnection: async (_owner, id) => connections[id], repository, publishTargets });
  assert.equal(usedConnection.id, "old-meta-connection");
});
```

- [ ] **Step 2: Run tests and confirm failure**

Run: `node --test tests/post-service.test.js tests/scheduler.test.js tests/publish-service.test.js`

Expected: assertions fail because targets do not contain connection IDs.

- [ ] **Step 3: Resolve connections before target insertion and publish with target-specific credentials**

```js
const targets = await Promise.all(activeTargets(input.targets).map(async (target) => ({
  ...target,
  platformConnectionId: (await resolveConnection(owner, target.platform)).id,
})));

const connections = await Promise.all(post.targets.map((target) => getConnection(owner, target.platformConnectionId)));
return publishTargets({ targets: toPublishTargets(post), connections });
```

Reject missing, archived, foreign-owner, or `needs_reconnect` connections before the post is created. Keep generic error messages in history responses. Replace `settings.metaPageId`/`settings.lineChannelAccessToken` reads in `publish-service.js` with the validated Meta/LINE connection credentials.

- [ ] **Step 4: Make bootstrap targets terminal and preserve cancellation semantics**

```js
await tx.update(postTargets).set({ status: "failed", errorMessage: "Platform reconnection is required." })
  .where(and(isNull(postTargets.platformConnectionId), inArray(postTargets.status, ["draft", "scheduled"])));
```

Run this only from the explicit deployment script in Task 6. The normal publisher refuses a missing connection ID as a safe failure, never falling back to `user_settings` or environment values.

- [ ] **Step 5: Run focused tests**

Run: `node --test tests/post-service.test.js tests/post-route-handlers.test.js tests/scheduler.test.js tests/publish-service.test.js`

Expected: PASS; immediate, scheduled, stale-client, and old-target scenarios use no shared credential fallback.

- [ ] **Step 6: Commit**

```bash
git add src/lib/posts src/lib/platforms src/lib/scheduler src/app/api/posts src/app/api/cron tests/post-service.test.js tests/post-route-handlers.test.js tests/scheduler.test.js tests/publish-service.test.js
git commit -m "feat: bind publishing targets to immutable platform connections"
```

### Task 5: Add connected-platform UI and smooth connection management

**Files:**
- Modify: `src/components/SettingsPanel.js`
- Modify: `src/components/CreatePostWizard.js`
- Modify: `src/lib/wizard/wizard-flow.js`
- Modify: `src/app/login/page.js`
- Test: `tests/settings-panel.test.js`
- Test: `tests/wizard-flow.test.js`
- Test: `tests/wizard-ui.test.js`

**Interfaces:**
- `GET /api/platform-connections` response shape is `{ connections: [{ platform, state, displayName, expiresAt }] }`.
- `getInitialPostForm(modelPreferences, connectedPlatforms)` returns only valid connected platform selections.

- [ ] **Step 1: Write failing UI/source and flow tests**

```js
test("initial form selects only connected platforms", () => {
  assert.deepEqual(getInitialPostForm({}, ["line"] ).platforms, ["line"]);
});

test("wizard hides disconnected platform checkboxes and renders the settings CTA", async () => {
  const source = await readFile(new URL("../src/components/CreatePostWizard.js", import.meta.url), "utf8");
  assert.equal(source.includes("/api/platform-connections"), true);
  assert.equal(source.includes("前往發布平台設定"), true);
});
```

- [ ] **Step 2: Run tests and confirm failure**

Run: `node --test tests/settings-panel.test.js tests/wizard-flow.test.js tests/wizard-ui.test.js`

Expected: failures because the current UI always maps `ACTIVE_PLATFORMS` and contains manual token inputs.

- [ ] **Step 3: Replace manual platform Token inputs with connection cards**

```jsx
<ConnectionCard platform="meta" connection={connections.meta} onConnect={() => window.location.assign(metaAuthorizeUrl)} />
<ConnectionCard platform="line" connection={connections.line} onConnect={openLineDialog} />
```

The Meta card starts OAuth, handles `connected`, `needs_reconnect`, and `archived` states, and offers **Change Page**. The LINE card asks once for Channel ID and Secret, shows the verified OA name, and never renders a stored Token. Preserve the AI settings tab unchanged. Replace the login-page admin-only copy with text that says every account can connect its own publishing platforms.

- [ ] **Step 4: Fetch availability in Step 1 and enforce a frictionless empty state**

```js
useEffect(() => {
  fetch("/api/platform-connections").then((response) => response.json())
    .then(({ connections }) => setConnectedPlatforms(connections.filter((item) => item.state === "active").map((item) => item.platform)));
}, []);
```

Render checkboxes only for `connectedPlatforms`; reset invalid form selections after the response; default to the remaining connected values. If none are connected, show one inline button to `/settings` and disable progression until a platform is connected.

- [ ] **Step 5: Run focused tests**

Run: `node --test tests/settings-panel.test.js tests/wizard-flow.test.js tests/wizard-ui.test.js`

Expected: PASS; no source asserts or rendered behavior expose manual publishing Tokens or admin-only wording.

- [ ] **Step 6: Commit**

```bash
git add src/components src/lib/wizard src/app/login tests/settings-panel.test.js tests/wizard-flow.test.js tests/wizard-ui.test.js
git commit -m "feat: show only connected publishing platforms"
```

### Task 6: Remove legacy credentials and document deployment setup

**Files:**
- Create: `scripts/remove-legacy-platform-credentials.mjs`
- Modify: `package.json`
- Modify: `.env.example`
- Modify: `scripts/runtime-config.mjs`
- Test: `tests/remove-legacy-platform-credentials.test.js`
- Test: `tests/runtime-config.test.js`

**Interfaces:**
- `npm run migrate:platform-connections` is an explicit, operator-run migration that removes legacy platform keys and marks old unbound targets failed. It requires `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, and `SETTINGS_ENCRYPTION_KEY`.

- [ ] **Step 1: Write failing bootstrap and configuration tests**

```js
test("legacy cleanup preserves AI keys but removes all legacy platform credentials", async () => {
  const settings = await removeLegacyPlatformCredentials({ googleAiApiKey: "ai", metaPageAccessToken: "old", lineChannelAccessToken: "old" });
  assert.deepEqual(settings, { googleAiApiKey: "ai" });
});

test("runtime configuration does not require shared Meta or LINE publishing tokens", () => {
  assert.doesNotThrow(() => validateRuntimeConfig(validEnvWithoutSharedPlatformTokens));
});
```

- [ ] **Step 2: Run tests and confirm failure**

Run: `node --test tests/remove-legacy-platform-credentials.test.js tests/runtime-config.test.js`

Expected: failure resolving the cleanup module.

- [ ] **Step 3: Implement an explicit migration command, never an automatic production write**

```js
export function removeLegacyPlatformCredentials(settings) {
  const { metaPageId, metaPageAccessToken, lineChannelAccessToken, ...remaining } = settings;
  return remaining;
}

await repository.forEachUserSetting(async (record) => repository.save({
  ...record, encryptedSettings: encryptJson(removeLegacyPlatformCredentials(decryptJson(record.encryptedSettings, key)), key), updatedAt: now,
}));
await repository.failUnboundPendingTargets(now, "Platform reconnection is required.");
```

Add `"migrate:platform-connections": "node scripts/remove-legacy-platform-credentials.mjs"`. Remove shared platform variables from `.env.example`; add the three Meta OAuth variables with comments that they are server-only integration settings. Do not add them to `NEXT_PUBLIC_` and do not make local build fail until the user attempts Meta connection.

- [ ] **Step 4: Run focused tests**

Run: `node --test tests/remove-legacy-platform-credentials.test.js tests/runtime-config.test.js`

Expected: PASS; test fixtures prove AI keys survive and no legacy publishing credential survives.

- [ ] **Step 5: Commit**

```bash
git add scripts package.json .env.example tests/remove-legacy-platform-credentials.test.js tests/runtime-config.test.js
git commit -m "feat: require platform reconnection after credential cleanup"
```

### Task 7: Full verification and release safety review

**Files:**
- Modify: `docs/superpowers/specs/2026-07-13-per-user-platform-connections-design.md` only if verification reveals a design mismatch.
- Test: all `tests/*.test.js`

- [ ] **Step 1: Run the complete deterministic test suite**

Run: `npm test`

Expected: PASS with all connection, publishing, settings, scheduler, and UI tests.

- [ ] **Step 2: Run production build without live publishing**

Run: `npm run build`

Expected: `Runtime configuration is valid.` followed by a successful Next.js build.

- [ ] **Step 3: Scan tracked changes for accidental credentials and legacy runtime use**

Run: `git diff HEAD~1..HEAD -- . ':!package-lock.json' | rg -n "(EAA[A-Za-z0-9]|Bearer [A-Za-z0-9._-]{20,}|client_secret=|access_token=)"`

Expected: no credential values; only safe field names and redaction logic may appear.

- [ ] **Step 4: Commit any test-only corrections**

```bash
git add tests src docs
git commit -m "test: verify per-user platform connection flows"
```

