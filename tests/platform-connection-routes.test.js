import assert from "node:assert/strict";
import { test } from "node:test";

import { createPlatformConnectionRouteHandlers } from "../src/lib/platform-connections/platform-connection-route-handlers.js";

test("availability is scoped to the authenticated owner and never returns credentials", async () => {
  const calls = [];
  const handlers = createPlatformConnectionRouteHandlers({
    requireOwner: async () => "owner@example.com",
    getServices: async () => ({ connections: { async listAvailability(ownerEmail) { calls.push(ownerEmail); return [{ platform: "meta", state: "active", displayName: "Owner Page", expiresAt: null, credentials: { pageAccessToken: "secret" } }]; } } }),
  });

  const response = await handlers.GET();
  const body = await response.json();
  assert.deepEqual(calls, ["owner@example.com"]);
  assert.deepEqual(body, { connections: [{ platform: "meta", state: "active", displayName: "Owner Page", expiresAt: null }] });
  assert.equal(JSON.stringify(body).includes("secret"), false);
});

test("POST handlers reject cross-origin requests before initializing platform stores", async () => {
  let storesCreated = 0;
  const handlers = createPlatformConnectionRouteHandlers({
    requireOwner: async () => "owner@example.com",
    getServices: async () => { storesCreated += 1; return {}; },
  });
  const request = new Request("https://publisher.example/api/platform-connections/meta/start", {
    method: "POST", headers: { origin: "https://attacker.example" }, body: "{}",
  });

  await assert.rejects(handlers.startMeta(request), (error) => error.status === 403 && /origin/i.test(error.message));
  await assert.rejects(handlers.startMetaRedirect(new Request(request.url, {
    method: "POST",
    headers: { origin: "https://attacker.example", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ returnPath: "/settings?tab=publishing" }),
  })), (error) => error.status === 403 && /origin/i.test(error.message));
  assert.equal(storesCreated, 0);
});

test("POST handlers reject requests without an Origin before initializing platform stores", async () => {
  let storesCreated = 0;
  const handlers = createPlatformConnectionRouteHandlers({
    requireOwner: async () => "owner@example.com",
    getServices: async () => { storesCreated += 1; return {}; },
  });
  const request = new Request("https://publisher.example/api/platform-connections/meta/start", {
    method: "POST", body: "{}",
  });

  await assert.rejects(handlers.startMeta(request), (error) => error.status === 403 && /origin/i.test(error.message));
  assert.equal(storesCreated, 0);
});

test("Meta JSON start preserves the authenticated owner, safe Settings return path, and authorizeUrl response", async () => {
  const calls = [];
  const handlers = createPlatformConnectionRouteHandlers({
    requireOwner: async () => "owner@example.com",
    getServices: async () => ({
      meta: { async start(...args) {
        calls.push(args);
        return { authorizeUrl: "https://www.facebook.com/v25.0/dialog/oauth?state=opaque" };
      } },
    }),
  });
  const request = new Request("https://publisher.example/api/platform-connections/meta/start", {
    method: "POST",
    headers: { origin: "https://publisher.example", "content-type": "application/json" },
    body: JSON.stringify({ returnPath: "/settings?tab=publishing" }),
  });

  const response = await handlers.startMeta(request);

  assert.deepEqual(calls, [["owner@example.com", "/settings?tab=publishing"]]);
  assert.deepEqual(await response.json(), {
    authorizeUrl: "https://www.facebook.com/v25.0/dialog/oauth?state=opaque",
  });
});

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

test("Meta form start redacts invalid authorization redirect protocol, host, and path", async () => {
  const invalidAuthorizeUrls = [
    "http://www.facebook.com/v25.0/dialog/oauth?detail=protocol-secret",
    "https://attacker.example/v25.0/dialog/oauth?detail=host-secret",
    "https://www.facebook.com/v25.0/not-oauth?detail=path-secret",
  ];

  for (const authorizeUrl of invalidAuthorizeUrls) {
    const handlers = createPlatformConnectionRouteHandlers({
      requireOwner: async () => "owner@example.com",
      getServices: async () => ({ meta: { async start() { return { authorizeUrl }; } } }),
      redirect: (url, status) => new Response(null, { status, headers: { location: url } }),
    });
    const request = new Request("https://publisher.example/api/platform-connections/meta/start", {
      method: "POST",
      headers: { origin: "https://publisher.example", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ returnPath: "/settings?tab=publishing" }),
    });

    const response = await handlers.startMetaRedirect(request);

    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), "https://publisher.example/settings?tab=publishing&meta=start_error");
    assert.equal(response.headers.get("location").includes("secret"), false);
  }
});

test("Meta selection passes only the authenticated owner and returns a safe connection", async () => {
  const calls = [];
  const handlers = createPlatformConnectionRouteHandlers({
    requireOwner: async () => "owner@example.com",
    getServices: async () => ({ meta: { async selectPage(...args) { calls.push(args); return { platform: "meta", state: "active", displayName: "Owner Page", expiresAt: null, credentials: { pageAccessToken: "secret" } }; } } }),
  });
  const response = await handlers.selectMeta(new Request("https://publisher.example/api/platform-connections/meta/select", {
    method: "POST", headers: { origin: "https://publisher.example" }, body: JSON.stringify({ transactionId: "transaction-1", pageId: "page-1" }),
  }));
  const body = await response.json();

  assert.deepEqual(calls, [["owner@example.com", "transaction-1", "page-1"]]);
  assert.deepEqual(body, { connection: { platform: "meta", state: "active", displayName: "Owner Page", expiresAt: null } });
  assert.equal(JSON.stringify(body).includes("secret"), false);
});

test("Meta callback turns a provider cancellation into a generic settings redirect", async () => {
  const handlers = createPlatformConnectionRouteHandlers({
    requireOwner: async () => "owner@example.com",
    getServices: async () => ({ meta: { async completeCallback() { return { status: "reconnect", returnPath: "/settings?tab=publishing", providerDetail: "do-not-leak" }; } } }),
  });

  const response = await handlers.completeMeta(new Request("https://publisher.example/api/platform-connections/meta/callback?error=access_denied"));
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "https://publisher.example/settings?tab=publishing&meta=reconnect");
  assert.equal(response.headers.get("location").includes("do-not-leak"), false);
});

test("Meta callback redirects only an opaque picker transaction to settings", async () => {
  const handlers = createPlatformConnectionRouteHandlers({
    requireOwner: async () => "owner@example.com",
    getServices: async () => ({ meta: { async completeCallback() { return {
      status: "select_page", transactionId: "transaction-1", returnPath: "/settings?tab=publishing",
      pages: [{ id: "page-1", name: "Owner Page", accessToken: "secret" }],
    }; } } }),
  });

  const response = await handlers.completeMeta(new Request("https://publisher.example/api/platform-connections/meta/callback?code=code"));
  const location = new URL(response.headers.get("location"));
  assert.equal(location.pathname, "/settings");
  assert.equal(location.searchParams.get("meta"), "select");
  assert.equal(location.searchParams.get("transactionId"), "transaction-1");
  assert.equal(location.searchParams.get("pages"), null);
  assert.equal(location.toString().includes("secret"), false);
});

test("Meta pending Page route obtains choices only for the authenticated owner and redacts credentials", async () => {
  const calls = [];
  const handlers = createPlatformConnectionRouteHandlers({
    requireOwner: async () => "owner@example.com",
    getServices: async () => ({ meta: { async getPendingPages(...args) { calls.push(args); return [{ id: "page-1", name: "Owner Page", accessToken: "secret" }]; } } }),
  });

  const response = await handlers.getMetaPending(new Request("https://publisher.example/api/platform-connections/meta/pending?transactionId=transaction-1"));
  const body = await response.json();
  assert.deepEqual(calls, [["owner@example.com", "transaction-1"]]);
  assert.deepEqual(body, { pages: [{ id: "page-1", name: "Owner Page" }] });
  assert.equal(JSON.stringify(body).includes("secret"), false);
});

test("LINE connect is owner-scoped, same-origin protected, and returns only safe availability", async () => {
  const calls = [];
  const readiness = {
    status: "ready",
    ready: true,
    supportEnabled: false,
    state: "disabled",
    connection: { connected: true, active: true, displayName: "Owner OA" },
    checks: {
      lineActive: true,
      providerConfigured: true,
      providerTested: false,
      enabledFaq: true,
      webhookVerified: true,
      redeliveryAcknowledged: true,
      nativeRepliesDisabledAcknowledged: true,
    },
  };
  const handlers = createPlatformConnectionRouteHandlers({
    requireOwner: async () => "owner@example.com",
    getServices: async () => ({
      line: {
        async connect(...args) {
          calls.push(["connect", ...args]);
          return {
            platform: "line",
            state: "active",
            displayName: "Owner OA",
            expiresAt: new Date("2026-08-12T00:00:00.000Z"),
          };
        },
      },
      connections: {
        async getDefault(...args) {
          calls.push(["getDefault", ...args]);
          return {
            id: "connection-1",
            ownerEmail: "owner@example.com",
            platform: "line",
            state: "active",
            displayName: "Owner OA",
            credentials: { channelSecret: "secret", accessToken: "token" },
          };
        },
      },
      onboarding: {
        async provisionLineWebhook(...args) {
          calls.push(["provision", ...args]);
          return {
            webhookUrl: "https://publisher.example/api/webhooks/line/private-webhook-key",
            setupStatus: "verified",
            readiness: {
              ...readiness,
              webhookKeyHash: "private-webhook-hash",
              connection: {
                ...readiness.connection,
                id: "connection-1",
                credentials: { accessToken: "token" },
              },
            },
          };
        },
      },
    }),
  });

  const response = await handlers.connectLine(new Request("https://publisher.example/api/platform-connections/line", {
    method: "POST", headers: { origin: "https://publisher.example", "content-type": "application/json" }, body: JSON.stringify({ channelId: "channel-id", channelSecret: "channel-secret" }),
  }));
  const body = await response.json();

  assert.deepEqual(calls, [
    ["connect", "owner@example.com", { channelId: "channel-id", channelSecret: "channel-secret" }],
    ["getDefault", "owner@example.com", "line"],
    ["provision", "owner@example.com", "connection-1"],
  ]);
  assert.deepEqual(body, {
    connection: {
      platform: "line",
      state: "active",
      displayName: "Owner OA",
      expiresAt: "2026-08-12T00:00:00.000Z",
    },
    supportSetup: { status: "verified", retryable: false },
    readiness,
  });
  assert.equal(JSON.stringify(body).includes("secret"), false);
  assert.equal(JSON.stringify(body).includes("token"), false);
  assert.equal(JSON.stringify(body).includes("connection-1"), false);
  assert.equal(JSON.stringify(body).includes("private-webhook-key"), false);
});

test("LINE connect retains the connection and returns a safe retry state when webhook setup fails", async () => {
  const calls = [];
  const readiness = {
    status: "needs_attention",
    ready: false,
    supportEnabled: false,
    state: "disabled",
    connection: { connected: true, active: true, displayName: "Owner OA" },
    checks: {
      lineActive: true,
      providerConfigured: false,
      providerTested: false,
      enabledFaq: false,
      webhookVerified: false,
      redeliveryAcknowledged: false,
      nativeRepliesDisabledAcknowledged: false,
    },
  };
  const handlers = createPlatformConnectionRouteHandlers({
    requireOwner: async () => "owner@example.com",
    getServices: async () => ({
      line: {
        async connect() {
          return {
            platform: "line",
            state: "active",
            displayName: "Owner OA",
            expiresAt: null,
          };
        },
      },
      connections: {
        async getDefault() {
          return {
            id: "connection-1",
            platform: "line",
            state: "active",
            credentials: { accessToken: "line-access-token" },
          };
        },
      },
      onboarding: {
        async provisionLineWebhook() {
          throw new Error("private LINE provider body with line-access-token");
        },
        async setSupportEnabled(...args) {
          calls.push(["disable", ...args]);
          return { supportEnabled: false, state: "disabled" };
        },
        async getReadiness(...args) {
          calls.push(["readiness", ...args]);
          return readiness;
        },
      },
    }),
  });

  const response = await handlers.connectLine(new Request("https://publisher.example/api/platform-connections/line", {
    method: "POST",
    headers: { origin: "https://publisher.example", "content-type": "application/json" },
    body: JSON.stringify({ channelId: "channel-id", channelSecret: "channel-secret" }),
  }));
  const body = await response.json();

  assert.equal(response.status, 201);
  assert.deepEqual(calls, [
    ["readiness", "owner@example.com", "connection-1"],
  ]);
  assert.deepEqual(body, {
    connection: {
      platform: "line",
      state: "active",
      displayName: "Owner OA",
      expiresAt: null,
    },
    supportSetup: { status: "retryable", retryable: true },
    readiness,
  });
  assert.equal(JSON.stringify(body).includes("private LINE provider body"), false);
  assert.equal(JSON.stringify(body).includes("line-access-token"), false);
  assert.equal(JSON.stringify(body).includes("connection-1"), false);
});

test("LINE connect does not disable a newer webhook attempt when provisioning is already in flight", async () => {
  let disableCalls = 0;
  const handlers = createPlatformConnectionRouteHandlers({
    requireOwner: async () => "owner@example.com",
    getServices: async () => ({
      line: {
        async connect() {
          return {
            platform: "line",
            state: "active",
            displayName: "Owner OA",
            expiresAt: null,
          };
        },
      },
      connections: {
        async getDefault() {
          return {
            id: "connection-1",
            platform: "line",
            state: "active",
          };
        },
      },
      onboarding: {
        async provisionLineWebhook() {
          const error = new Error("LINE support setup is already in progress.");
          error.status = 409;
          error.setupRetryable = true;
          throw error;
        },
        async setSupportEnabled() {
          disableCalls += 1;
        },
        async getReadiness() {
          return {
            status: "needs_attention",
            ready: false,
            supportEnabled: false,
            state: "disabled",
            connection: { connected: true, active: true, displayName: "Owner OA" },
            checks: {
              lineActive: true,
              providerConfigured: false,
              providerTested: false,
              enabledFaq: false,
              webhookVerified: false,
              redeliveryAcknowledged: false,
              nativeRepliesDisabledAcknowledged: false,
            },
          };
        },
      },
    }),
  });

  const response = await handlers.connectLine(new Request(
    "https://publisher.example/api/platform-connections/line",
    {
      method: "POST",
      headers: {
        origin: "https://publisher.example",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        channelId: "channel-id",
        channelSecret: "channel-secret",
      }),
    },
  ));

  assert.equal(response.status, 201);
  assert.equal(disableCalls, 0);
  assert.equal((await response.json()).supportSetup.status, "retryable");
});

test("LINE connect rejects cross-origin requests before initializing platform stores", async () => {
  let storesCreated = 0;
  const handlers = createPlatformConnectionRouteHandlers({
    requireOwner: async () => "owner@example.com",
    getServices: async () => { storesCreated += 1; return {}; },
  });
  const request = new Request("https://publisher.example/api/platform-connections/line", {
    method: "POST", headers: { origin: "https://attacker.example" }, body: "{}",
  });

  await assert.rejects(handlers.connectLine(request), (error) => error.status === 403 && /origin/i.test(error.message));
  assert.equal(storesCreated, 0);
});

test("LINE connect accepts only a Channel ID and Channel Secret JSON object", async () => {
  let calls = 0;
  const handlers = createPlatformConnectionRouteHandlers({
    requireOwner: async () => "owner@example.com",
    getServices: async () => ({ line: { async connect() { calls += 1; } } }),
  });
  const request = new Request("https://publisher.example/api/platform-connections/line", {
    method: "POST", headers: { origin: "https://publisher.example", "content-type": "application/json" },
    body: JSON.stringify({ channelId: "channel-id", channelSecret: "channel-secret", unexpected: "value" }),
  });

  await assert.rejects(handlers.connectLine(request), (error) => error.status === 400 && /channel id.*channel secret/i.test(error.message));
  assert.equal(calls, 0);
});

test("disconnect requires an authenticated owner before initializing platform stores", async () => {
  let storesCreated = 0;
  const handlers = createPlatformConnectionRouteHandlers({
    requireOwner: async () => { const error = new Error("Unauthorized"); error.status = 401; throw error; },
    getServices: async () => { storesCreated += 1; return {}; },
  });

  await assert.rejects(
    handlers.disconnectPlatform(new Request("https://publisher.example/api/platform-connections/meta/disconnect", {
      method: "POST", headers: { origin: "https://publisher.example" },
    }), "meta"),
    (error) => error.status === 401,
  );
  assert.equal(storesCreated, 0);
});

test("disconnect rejects cross-origin requests before initializing platform stores", async () => {
  let storesCreated = 0;
  const handlers = createPlatformConnectionRouteHandlers({
    requireOwner: async () => "owner@example.com",
    getServices: async () => { storesCreated += 1; return {}; },
  });

  await assert.rejects(
    handlers.disconnectPlatform(new Request("https://publisher.example/api/platform-connections/line/disconnect", {
      method: "POST", headers: { origin: "https://attacker.example" },
    }), "line"),
    (error) => error.status === 403 && /origin/i.test(error.message),
  );
  assert.equal(storesCreated, 0);
});

test("disconnect strictly rejects unsupported platforms", async () => {
  let storesCreated = 0;
  const handlers = createPlatformConnectionRouteHandlers({
    requireOwner: async () => "owner@example.com",
    getServices: async () => { storesCreated += 1; return {}; },
  });

  await assert.rejects(
    handlers.disconnectPlatform(new Request("https://publisher.example/api/platform-connections/instagram/disconnect", {
      method: "POST", headers: { origin: "https://publisher.example" },
    }), "instagram"),
    (error) => error.status === 404,
  );
  assert.equal(storesCreated, 0);
});

test("blocked disconnect returns 409 without calling the provider", async () => {
  let providerCalls = 0;
  const handlers = createPlatformConnectionRouteHandlers({
    requireOwner: async () => "owner@example.com",
    fetchImpl: async () => { providerCalls += 1; throw new Error("must not call"); },
    getServices: async () => ({ connections: { async disconnectDefault() { return { status: "blocked" }; } } }),
  });
  const response = await handlers.disconnectPlatform(new Request("https://publisher.example/api/platform-connections/line/disconnect", {
    method: "POST", headers: { origin: "https://publisher.example" },
  }), "line");

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "Cancel or wait for pending posts before disconnecting this platform." });
  assert.equal(providerCalls, 0);
});

test("LINE disconnect revokes the removed token with the documented request shape and redacts failures", async () => {
  const calls = [];
  const handlers = createPlatformConnectionRouteHandlers({
    requireOwner: async () => "owner@example.com",
    fetchImpl: async (...args) => { calls.push(args); return new Response("private provider body", { status: 503 }); },
    getServices: async () => ({ connections: {
      async disconnectDefault(...args) {
        assert.deepEqual(args, ["owner@example.com", "line"]);
        return { status: "disconnected", credentials: { accessToken: "line-secret" } };
      },
    } }),
  });

  const response = await handlers.disconnectPlatform(new Request("https://publisher.example/api/platform-connections/line/disconnect", {
    method: "POST", headers: { origin: "https://publisher.example" },
  }), "line");
  const body = await response.json();

  assert.equal(calls[0][0], "https://api.line.me/v2/oauth/revoke");
  assert.equal(calls[0][1].method, "POST");
  assert.equal(calls[0][1].headers["content-type"], "application/x-www-form-urlencoded");
  assert.equal(String(calls[0][1].body), "access_token=line-secret");
  assert.deepEqual(body, { connection: null, warning: "LINE was disconnected locally, but token revocation could not be confirmed." });
  assert.equal(JSON.stringify(body).includes("line-secret"), false);
  assert.equal(JSON.stringify(body).includes("private provider body"), false);
});

test("LINE revoke deadline covers stalled response consumption and returns only a safe warning", { timeout: 250 }, async () => {
  const handlers = createPlatformConnectionRouteHandlers({
    requireOwner: async () => "owner@example.com",
    requestTimeoutMs: 10,
    fetchImpl: async (_url, options) => ({
      ok: true, status: 200,
      arrayBuffer: async () => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("private stalled revoke body")))),
    }),
    getServices: async () => ({ connections: { async disconnectDefault() { return { status: "disconnected", credentials: { accessToken: "line-secret" } }; } } }),
  });

  const response = await handlers.disconnectPlatform(new Request("https://publisher.example/api/platform-connections/line/disconnect", {
    method: "POST", headers: { origin: "https://publisher.example" },
  }), "line");

  assert.deepEqual(await response.json(), { connection: null, warning: "LINE was disconnected locally, but token revocation could not be confirmed." });
});

test("Meta disconnect removes local credentials without a provider call", async () => {
  let providerCalls = 0;
  const handlers = createPlatformConnectionRouteHandlers({
    requireOwner: async () => "owner@example.com",
    fetchImpl: async () => { providerCalls += 1; },
    getServices: async () => ({ connections: { async disconnectDefault() { return { status: "disconnected", credentials: { pageAccessToken: "secret" } }; } } }),
  });
  const response = await handlers.disconnectPlatform(new Request("https://publisher.example/api/platform-connections/meta/disconnect", {
    method: "POST", headers: { origin: "https://publisher.example" },
  }), "meta");
  assert.deepEqual(await response.json(), { connection: null, notice: "You can separately revoke app access in Meta." });
  assert.equal(providerCalls, 0);
});

test("disconnect is idempotent when the owner has no active default", async () => {
  const handlers = createPlatformConnectionRouteHandlers({
    requireOwner: async () => "owner@example.com",
    getServices: async () => ({ connections: {
      async disconnectDefault(ownerEmail, platform) {
        assert.deepEqual([ownerEmail, platform], ["owner@example.com", "line"]);
        return { status: "not_found" };
      },
    } }),
  });

  const response = await handlers.disconnectPlatform(new Request("https://publisher.example/api/platform-connections/line/disconnect", {
    method: "POST", headers: { origin: "https://publisher.example" },
  }), "line");

  assert.deepEqual(await response.json(), { connection: null });
});
