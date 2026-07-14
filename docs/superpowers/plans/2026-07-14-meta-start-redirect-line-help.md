# Meta Start Redirect and LINE Credential Help Implementation Plan

> **Status:** Executed and completed. This plan is retained as historical implementation documentation; all checkboxes record completed work, including verification performed through the documented fallback where authenticated browser QA was unavailable.
>
> **Historical execution note:** Agentic workers used the task-by-task implementation workflow. Completed steps use checkbox (`- [x]`) syntax below; this document is no longer an instruction to begin implementation.

**Goal:** Make Meta connection start through a reliable native POST/303 redirect and teach users where to obtain LINE Channel ID and Channel secret without asking for an access token.

**Architecture:** Keep the existing JSON Meta-start API for compatibility, and add a form-specific handler that validates owner and origin before returning a server-side `303` redirect. Settings submits a native form and consumes only a safe same-origin error flag. The LINE credential form gains an accessible native disclosure backed by current official LINE guidance.

**Tech Stack:** Next.js App Router, React, Mantine, Node.js test runner, Vercel Functions

**Final implementation status:** The production `POST` delegates content-type selection to a small pure dispatcher in `meta-start-dispatch.js`, covered directly by `meta-start-route-dispatch.test.js`.

**Final verification:** The final suite passed 245/245 and the production build passed. One first full-suite run had a non-reproducible `post-repository` test-worker failure; that file then passed 9/9 in isolation and the original full command passed 245/245 on retry, with no code change. Authenticated desktop/mobile browser QA was unavailable under safe local auth/browser runtime constraints, so structural/source assertions and production-build verification were used as the fallback.

## Global Constraints

- Preserve authentication, owner scoping, exact same-origin validation, opaque OAuth state, safe return paths, and credential redaction.
- Never render or log Meta App secret, LINE Channel secret, Page access token, Channel access token, provider body, or database detail.
- Keep the existing JSON `POST /api/platform-connections/meta/start` response for compatibility.
- A form start failure must return only to `/settings?tab=publishing&meta=start_error`.
- Channel ID and Channel secret guidance must point to **Basic settings**, not the Messaging API tab.
- Do not perform real Meta OAuth, LINE token issuance, publishing, or external account changes during verification.
- Do not include pre-existing `.superpowers/sdd` scratch changes in commits.

---

### Task 1: Native Meta POST and 303 redirect

**Files:**
- Modify: `tests/platform-connection-routes.test.js`
- Modify: `tests/settings-panel.test.js`
- Create: `tests/meta-start-route-dispatch.test.js`
- Modify: `src/lib/platform-connections/platform-connection-route-handlers.js`
- Modify: `src/app/api/platform-connections/meta/start/route.js`
- Create: `src/app/api/platform-connections/meta/start/meta-start-dispatch.js`
- Modify: `src/components/SettingsPanel.js`

**Interfaces:**
- Consumes: `meta.start(ownerEmail, returnPath) -> Promise<{ authorizeUrl: string }>`
- Produces: `handlers.startMetaRedirect(request) -> Promise<Response>`
- Produces: `dispatchMetaStartRequest(request, handlers) -> Promise<Response>` as a small pure dispatcher used by the production `POST`
- Preserves: `handlers.startMeta(request) -> Promise<Response>` returning `{ authorizeUrl }`
- Form contract: `POST application/x-www-form-urlencoded` with `returnPath=/settings?tab=publishing`
- Failure contract: `303 Location: /settings?tab=publishing&meta=start_error`

- [x] **Step 1: Write failing route tests for native redirect and safe failure**

Add focused tests to `tests/platform-connection-routes.test.js`:

```js
test("Meta form start redirects the browser with 303 after owner and origin validation", async () => {
  const calls = [];
  const handlers = createPlatformConnectionRouteHandlers({
    requireOwner: async () => "owner@example.com",
    getServices: async () => ({
      meta: { async start(ownerEmail, returnPath) {
        calls.push([ownerEmail, returnPath]);
        return { authorizeUrl: "https://www.facebook.com/v25.0/dialog/oauth?state=opaque" };
      } },
    }),
    redirect: (url, status) => new Response(null, { status, headers: { location: url } }),
  });
  const request = new Request("https://publisher.example/api/platform-connections/meta/start", {
    method: "POST",
    headers: { origin: "https://publisher.example", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ returnPath: "/settings?tab=publishing" }),
  });

  const response = await handlers.startMetaRedirect(request);

  assert.equal(response.status, 303);
  assert.match(response.headers.get("location"), /^https:\/\/www\.facebook\.com\//);
  assert.deepEqual(calls, [["owner@example.com", "/settings?tab=publishing"]]);
});

test("Meta form start redirects service failures to a fixed safe Settings URL", async () => {
  const handlers = createPlatformConnectionRouteHandlers({
    requireOwner: async () => "owner@example.com",
    getServices: async () => ({ meta: { async start() { throw new Error("private Meta configuration detail"); } } }),
    redirect: (url, status) => new Response(null, { status, headers: { location: url } }),
  });
  const request = new Request("https://publisher.example/api/platform-connections/meta/start", {
    method: "POST",
    headers: { origin: "https://publisher.example", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ returnPath: "https://attacker.example/private" }),
  });

  const response = await handlers.startMetaRedirect(request);

  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "https://publisher.example/settings?tab=publishing&meta=start_error");
  assert.equal(response.headers.get("location").includes("private"), false);
});
```

Extend the existing cross-origin test so `startMetaRedirect()` rejects before `getServices()` is called.

- [x] **Step 2: Write a failing Settings source test for the native form**

Add to `tests/settings-panel.test.js`:

```js
test("Meta connection starts with a native POST form and consumes only a safe error flag", async () => {
  const source = await readFile(new URL("../src/components/SettingsPanel.js", import.meta.url), "utf8");

  assert.equal(source.includes('action="/api/platform-connections/meta/start"'), true);
  assert.equal(source.includes('method="post"'), true);
  assert.equal(source.includes('name="returnPath"'), true);
  assert.equal(source.includes('type="submit"'), true);
  assert.equal(source.includes('fetch("/api/platform-connections/meta/start"'), false);
  assert.equal(source.includes('params.get("meta") === "start_error"'), true);
  assert.equal(source.includes('params.delete("meta")'), true);
});
```

- [x] **Step 3: Run focused tests and verify RED**

Run:

```powershell
node --test tests/platform-connection-routes.test.js tests/settings-panel.test.js
```

Expected: FAIL because `startMetaRedirect` and the native form do not exist, while the current client still calls `fetch()`.

- [x] **Step 4: Implement the form-specific handler**

In `src/lib/platform-connections/platform-connection-route-handlers.js`, make the default redirect accept a status and add the new method after `startMeta`:

```js
export function createPlatformConnectionRouteHandlers({
  requireOwner,
  getServices = () => getPlatformConnectionServices(),
  fetchImpl = fetch,
  requestTimeoutMs = 10_000,
  respond = (body, init) => Response.json(body, init),
  redirect = (url, status = 302) => Response.redirect(url, status),
}) {
  return {
    async startMeta(request) {
      const ownerEmail = await requireOwner();
      requireSameOrigin(request);
      const { meta } = await getServices();
      const body = await jsonBody(request);
      return respond(await meta.start(ownerEmail, body.returnPath));
    },
    async startMetaRedirect(request) {
      const ownerEmail = await requireOwner();
      requireSameOrigin(request);
      try {
        const { meta } = await getServices();
        const form = await request.formData();
        const result = await meta.start(ownerEmail, form.get("returnPath"));
        return redirect(requireMetaAuthorizationUrl(result?.authorizeUrl), 303);
      } catch {
        return redirect(new URL("/settings?tab=publishing&meta=start_error", request.url).toString(), 303);
      }
    },
```

Add the fixed-host redirect validator near the existing helpers:

```js
function requireMetaAuthorizationUrl(value) {
  const url = new URL(String(value ?? ""));
  if (url.protocol !== "https:" || url.hostname !== "www.facebook.com" || !url.pathname.endsWith("/dialog/oauth")) {
    throw routeError("Meta connection could not be started.", 502);
  }
  return url.toString();
}
```

Authentication and same-origin failures remain outside the `try` block so they cannot be converted into a misleading OAuth failure redirect.

- [x] **Step 5: Route production requests through a pure dispatcher**

Create `src/app/api/platform-connections/meta/start/meta-start-dispatch.js` as a small pure content-type dispatcher. Cover JSON, URL-encoded form, and URL-encoded form-with-charset requests in `tests/meta-start-route-dispatch.test.js`, including a source assertion that the production route uses this dispatcher. In `src/app/api/platform-connections/meta/start/route.js`, pass a status-aware redirect dependency and delegate the production `POST` to it:

```js
// meta-start-dispatch.js
export function dispatchMetaStartRequest(request, handlers) {
  const contentType = String(request.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
  if (contentType === "application/x-www-form-urlencoded") return handlers.startMetaRedirect(request);
  return handlers.startMeta(request);
}

// route.js
const handlers = createPlatformConnectionRouteHandlers({
  requireOwner: requireSettingsAccess,
  getServices: () => getPlatformConnectionServices(),
  respond: (body, init) => NextResponse.json(body, init),
  redirect: (url, status) => NextResponse.redirect(url, status),
});

export async function POST(request) {
  try {
    return await dispatchMetaStartRequest(request, handlers);
  } catch (error) {
    return routeErrorResponse(error, NextResponse);
  }
}
```

- [x] **Step 6: Replace the imperative Meta start with a native form**

In `src/components/SettingsPanel.js`:

1. Delete `startMetaConnection()` and all references to its client fetch.
2. In the initial URL effect, add this safe error handling before the existing reconnect branch:

```js
if (params.get("meta") === "start_error") {
  setConnectionError("Meta connection could not be started. Please try again.");
  params.delete("meta");
  window.history.replaceState({}, "", `${window.location.pathname}?${params.toString()}`);
}
```

3. Replace only the Connect/Change/Reconnect button with this form, leaving Disconnect unchanged:

```jsx
<form
  action="/api/platform-connections/meta/start"
  method="post"
  onSubmit={() => setConnectionAction("meta-start")}
>
  <input type="hidden" name="returnPath" value="/settings?tab=publishing" />
  <Button type="submit" loading={connectionAction === "meta-start"} disabled={Boolean(connectionAction)}>
    {metaConnection.state === "active" ? "Change Page" : metaConnection.state === "needs_reconnect" ? "Reconnect" : "Connect Meta"}
  </Button>
</form>
```

- [x] **Step 7: Run focused tests and verify GREEN**

Run:

```powershell
node --test tests/platform-connection-routes.test.js tests/settings-panel.test.js
```

Expected: all focused tests pass, including the pre-existing JSON start and route security tests.

- [x] **Step 8: Commit Task 1**

```powershell
git add tests/platform-connection-routes.test.js tests/settings-panel.test.js src/lib/platform-connections/platform-connection-route-handlers.js src/app/api/platform-connections/meta/start/route.js src/components/SettingsPanel.js
git commit -m "fix: start Meta OAuth with a server redirect"
```

The final pure dispatcher and its direct production-dispatch test were added in the follow-up compatibility commit `31c5d0f`.

---

### Task 2: Accessible LINE Channel credential instructions

**Files:**
- Modify: `tests/settings-panel.test.js`
- Modify: `src/components/SettingsPanel.js`

**Interfaces:**
- Consumes: existing `lineEditing` credential form state
- Produces: an accessible `details` disclosure with official links and four ordered steps
- Preserves: `connectLine()` payload `{ channelId, channelSecret }` and automatic token lifecycle

- [x] **Step 1: Write the failing LINE help UI test**

Add to `tests/settings-panel.test.js`:

```js
test("LINE credential form explains where to find Channel ID and Channel secret", async () => {
  const source = await readFile(new URL("../src/components/SettingsPanel.js", import.meta.url), "utf8");

  for (const expected of [
    "How to get Channel ID / Channel secret",
    "https://developers.line.biz/",
    "Messaging API",
    "Basic settings",
    "LINE Official Account",
    "Do not paste a Channel access token",
    'rel="noreferrer noopener"',
  ]) {
    assert.equal(source.includes(expected), true, `missing ${expected}`);
  }
  assert.equal(source.includes("<details"), true);
  assert.equal(source.includes("<summary"), true);
});
```

- [x] **Step 2: Run the focused test and verify RED**

Run:

```powershell
node --test tests/settings-panel.test.js
```

Expected: FAIL with `missing How to get Channel ID / Channel secret`.

- [x] **Step 3: Add the LINE disclosure above the credential inputs**

In the `lineEditing` stack in `src/components/SettingsPanel.js`, add this block before `TextInput`:

```jsx
<details>
  <summary style={{ cursor: "pointer", fontWeight: 600 }}>How to get Channel ID / Channel secret</summary>
  <ol style={{ marginBlock: "0.75rem 0", paddingInlineStart: "1.25rem" }}>
    <li><Text size="sm">Sign in to <Text component="a" href="https://developers.line.biz/" target="_blank" rel="noreferrer noopener" inherit td="underline">LINE Developers Console</Text>.</Text></li>
    <li><Text size="sm">Select your Provider and its <strong>Messaging API</strong> Channel. If none exists, create a LINE Official Account and enable Messaging API first.</Text></li>
    <li><Text size="sm">Open <strong>Basic settings</strong>, then copy the <strong>Channel ID</strong> and <strong>Channel secret</strong>.</Text></li>
    <li><Text size="sm">Paste those two values below. Do not paste a Channel access token; this application obtains and renews it automatically.</Text></li>
  </ol>
</details>
```

Keep the current password masking, autocomplete attributes, connect/cancel controls, and responsive one-column card layout.

- [x] **Step 4: Run focused tests and verify GREEN**

Run:

```powershell
node --test tests/settings-panel.test.js tests/platform-connection-routes.test.js
```

Expected: all focused tests pass.

- [x] **Step 5: Commit Task 2**

```powershell
git add tests/settings-panel.test.js src/components/SettingsPanel.js
git commit -m "feat: explain LINE channel credentials"
```

---

### Task 3: Regression and visual verification

**Files:**
- Verify only: `src/components/SettingsPanel.js`
- Verify only: `src/app/api/platform-connections/meta/start/route.js`
- Verify only: `src/app/api/platform-connections/meta/start/meta-start-dispatch.js`
- Verify only: `src/lib/platform-connections/platform-connection-route-handlers.js`

**Interfaces:**
- Consumes: completed Task 1 and Task 2 behavior
- Produces: verified branch ready for review

- [x] **Step 1: Run the full automated test suite**

```powershell
npm.cmd test
```

Expected: zero failed tests.

- [x] **Step 2: Run the production build with process-only test configuration**

```powershell
$env:AUTH_MODE = "demo"
$env:SETTINGS_ENCRYPTION_KEY = "test-settings-encryption-key"
$env:TURSO_DATABASE_URL = "libsql://example.turso.io"
$env:TURSO_AUTH_TOKEN = "test-token"
$env:BLOB_READ_WRITE_TOKEN = "test-blob-token"
npm.cmd run build
```

Expected: Next.js production build exits 0 and generates all routes.

- [x] **Step 3: Run static safety checks**

```powershell
git diff --check
rg -n "^(<<<<<<<|=======|>>>>>>>)" src tests docs
rg -n "META_APP_SECRET|LINE_CHANNEL_ACCESS_TOKEN|pageAccessToken" src/components/SettingsPanel.js
rg -n "channelSecret" src/components/SettingsPanel.js
```

Expected: the first three commands produce no errors or matches. The final command matches only the existing masked `channelSecret` form state/input and payload field; it must not match logging, rendered secret text, or a token.

- [x] **Step 4: Perform visual QA or its documented safe fallback**

At desktop and narrow mobile widths, verify:

- LINE disclosure stays within its card and ordered steps wrap without horizontal scrolling.
- Channel ID, Channel Secret, Connect, and Cancel remain visible.
- Meta form submit and Disconnect remain distinct and usable.
- Loading, disconnected, active, reconnect, and error states remain understandable.

Do not complete real OAuth or connect a real LINE channel. Authenticated desktop/mobile browser QA was unavailable under safe local auth/browser runtime constraints; this verification step was completed using the documented structural/source assertions and successful production build fallback.

- [x] **Step 5: Review the final diff and commit only if verification required a correction**

```powershell
git diff --stat origin/main...HEAD
git diff --check
git status -sb
```

Expected: only the design, plan, Meta redirect, LINE help, and related tests are committed; `.superpowers/sdd` scratch remains uncommitted.
