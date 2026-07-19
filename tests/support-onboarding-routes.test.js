import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { createSupportOnboardingRouteHandlers } from "../src/lib/support/routes/support-onboarding-route-handlers.js";

const OWNER = "owner@example.com";
const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";

test("static state loads owner readiness without a LINE or AI provider action", async () => {
  const calls = [];
  const readiness = readinessState();
  const handlers = createHandlers({
    supportStore: {
      async getConfiguration(ownerEmail) {
        calls.push(["configuration", ownerEmail]);
        return { platformConnectionId: CONNECTION_ID };
      },
    },
    onboarding: {
      async getReadiness(...args) {
        calls.push(["readiness", ...args]);
        return readiness;
      },
    },
  });

  const response = await handlers.getState();

  assert.deepEqual(await response.json(), { readiness });
  assert.deepEqual(calls, [
    ["configuration", OWNER],
    ["readiness", OWNER, CONNECTION_ID],
  ]);
});

test("every onboarding POST rejects cross-origin before lazy services are created", async () => {
  let servicesCreated = 0;
  const handlers = createSupportOnboardingRouteHandlers({
    requireOwner: async () => OWNER,
    requireSameOrigin(request) {
      if (request.headers.get("origin") !== new URL(request.url).origin) {
        const error = new Error("Invalid request origin.");
        error.status = 403;
        throw error;
      }
    },
    getServices: async () => {
      servicesCreated += 1;
      return {};
    },
  });
  const request = new Request("https://app.example/api/support/configuration/state", {
    method: "POST",
    headers: { origin: "https://attacker.example", "content-type": "application/json" },
    body: JSON.stringify({ enabled: false }),
  });

  await assert.rejects(handlers.setState(request), (error) => error.status === 403);
  await assert.rejects(handlers.testProvider(request), (error) => error.status === 403);
  await assert.rejects(handlers.refreshReadiness(request), (error) => error.status === 403);
  assert.equal(servicesCreated, 0);
});

test("explicit readiness action provisions the active default but returns no ID, hash, URL, or credentials", async () => {
  const calls = [];
  const readiness = readinessState({ ready: true, webhookVerified: true });
  const handlers = createHandlers({
    connections: {
      async getDefault(...args) {
        calls.push(["default", ...args]);
        return {
          id: CONNECTION_ID,
          ownerEmail: OWNER,
          platform: "line",
          state: "active",
          credentials: { accessToken: "line-access-token" },
        };
      },
    },
    onboarding: {
      async provisionLineWebhook(...args) {
        calls.push(["provision", ...args]);
        return {
          webhookUrl: "https://app.example/api/webhooks/line/private-webhook-key",
          setupStatus: "verified",
          readiness: {
            ...readiness,
            webhookKeyHash: "private-webhook-hash",
            connection: {
              ...readiness.connection,
              id: CONNECTION_ID,
              credentials: { accessToken: "line-access-token" },
            },
          },
        };
      },
    },
  });
  const request = sameOriginRequest("/api/support/configuration/readiness", {});

  const response = await handlers.refreshReadiness(request);
  const body = await response.json();

  assert.deepEqual(calls, [
    ["default", OWNER, "line"],
    ["provision", OWNER, CONNECTION_ID],
  ]);
  assert.deepEqual(body, {
    setup: { status: "verified", retryable: false },
    readiness,
  });
  assert.equal(JSON.stringify(body).includes(CONNECTION_ID), false);
  assert.equal(JSON.stringify(body).includes("line-access-token"), false);
  assert.equal(JSON.stringify(body).includes("private-webhook-key"), false);
});

test("readiness retry failure returns a bounded retryable setup state and disabled readiness", async () => {
  const readiness = readinessState();
  const handlers = createHandlers({
    connections: {
      async getDefault() {
        return { id: CONNECTION_ID, platform: "line", state: "active" };
      },
    },
    onboarding: {
      async provisionLineWebhook() {
        const error = new Error("private provider response");
        error.setupRetryable = true;
        throw error;
      },
      async setSupportEnabled(ownerEmail, connectionId, enabled) {
        assert.deepEqual([ownerEmail, connectionId, enabled], [OWNER, CONNECTION_ID, false]);
      },
      async getReadiness() {
        return readiness;
      },
    },
  });

  const response = await handlers.refreshReadiness(
    sameOriginRequest("/api/support/configuration/readiness", {}),
  );
  const body = await response.json();

  assert.equal(response.status, 502);
  assert.deepEqual(body, {
    setup: { status: "retryable", retryable: true },
    readiness,
  });
  assert.equal(JSON.stringify(body).includes("private provider response"), false);
});

test("provider test is explicit and returns only pass or bounded failure status", async () => {
  const success = createHandlers({
    supportStore: {
      async getConfiguration() {
        return { platformConnectionId: CONNECTION_ID };
      },
    },
    onboarding: {
      async testAiProvider(ownerEmail, connectionId) {
        assert.deepEqual([ownerEmail, connectionId], [OWNER, CONNECTION_ID]);
        return {
          status: "passed",
          providerTested: true,
          providerBody: "must-not-leak",
        };
      },
    },
  });

  const passed = await success.testProvider(
    sameOriginRequest("/api/support/configuration/test-provider", {}),
  );
  assert.deepEqual(await passed.json(), {
    providerTest: { status: "passed", providerTested: true },
  });

  const failure = createHandlers({
    supportStore: {
      async getConfiguration() {
        return { platformConnectionId: CONNECTION_ID };
      },
    },
    onboarding: {
      async testAiProvider() {
        throw new Error("private provider body with API key");
      },
    },
  });
  const failed = await failure.testProvider(
    sameOriginRequest("/api/support/configuration/test-provider", {}),
  );
  const failedBody = await failed.json();

  assert.equal(failed.status, 502);
  assert.deepEqual(failedBody, {
    error: "AI provider test failed.",
    providerTest: { status: "failed", providerTested: false },
  });
  assert.equal(JSON.stringify(failedBody).includes("private provider body"), false);
});

test("provider test preserves bounded actionable setup conflicts", async () => {
  const handlers = createHandlers({
    supportStore: {
      async getConfiguration() {
        return { platformConnectionId: CONNECTION_ID };
      },
    },
    onboarding: {
      async testAiProvider() {
        const error = new Error("AI provider is not configured.");
        error.status = 409;
        throw error;
      },
    },
  });

  const response = await handlers.testProvider(
    sameOriginRequest("/api/support/configuration/test-provider", {}),
  );

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: "AI provider is not configured.",
    providerTest: { status: "not_ready", providerTested: false },
  });

  const stale = createHandlers({
    supportStore: {
      async getConfiguration() {
        return { platformConnectionId: CONNECTION_ID };
      },
    },
    onboarding: {
      async testAiProvider() {
        const error = new Error("Support configuration changed. Refresh readiness and try again.");
        error.status = 409;
        throw error;
      },
    },
  });
  const staleResponse = await stale.testProvider(
    sameOriginRequest("/api/support/configuration/test-provider", {}),
  );
  assert.equal(staleResponse.status, 409);
  assert.deepEqual(await staleResponse.json(), {
    error: "Support configuration changed. Refresh readiness and try again.",
    providerTest: { status: "not_ready", providerTested: false },
  });
});

test("state accepts only enabled boolean, gates enablement, and always permits disablement", async () => {
  const calls = [];
  const readiness = readinessState();
  const handlers = createHandlers({
    supportStore: {
      async getConfiguration() {
        return { platformConnectionId: CONNECTION_ID };
      },
    },
    onboarding: {
      async setSupportEnabled(ownerEmail, connectionId, enabled) {
        calls.push([ownerEmail, connectionId, enabled]);
        if (enabled) {
          const error = new Error("AI support is not ready to be enabled.");
          error.status = 409;
          error.readiness = readiness;
          throw error;
        }
        return { supportEnabled: false, state: "disabled" };
      },
    },
  });

  const disabled = await handlers.setState(
    sameOriginRequest("/api/support/configuration/state", { enabled: false }),
  );
  assert.deepEqual(await disabled.json(), {
    support: { enabled: false, state: "disabled" },
  });

  const blocked = await handlers.setState(
    sameOriginRequest("/api/support/configuration/state", { enabled: true }),
  );
  assert.equal(blocked.status, 409);
  assert.deepEqual(await blocked.json(), {
    error: "AI support is not ready to be enabled.",
    readiness,
  });
  assert.deepEqual(calls, [
    [OWNER, CONNECTION_ID, false],
    [OWNER, CONNECTION_ID, true],
  ]);

  await assert.rejects(
    handlers.setState(sameOriginRequest("/api/support/configuration/state", {
      enabled: false,
      extra: true,
    })),
    (error) => error.status === 400,
  );
});

test("thin onboarding routes keep authentication, same-origin protection, lazy services, and safe errors", async () => {
  const stateRoute = await readFile(
    new URL("../src/app/api/support/configuration/state/route.js", import.meta.url),
    "utf8",
  );
  const providerRoute = await readFile(
    new URL("../src/app/api/support/configuration/test-provider/route.js", import.meta.url),
    "utf8",
  );
  const readinessRoute = await readFile(
    new URL("../src/app/api/support/configuration/readiness/route.js", import.meta.url),
    "utf8",
  );

  assert.match(stateRoute, /export async function GET/);
  assert.match(stateRoute, /export async function POST/);
  assert.match(providerRoute, /export async function POST/);
  assert.match(readinessRoute, /export async function POST/);
  for (const source of [stateRoute, providerRoute, readinessRoute]) {
    assert.match(source, /requireSettingsAccess/);
    assert.match(source, /requireSameOrigin/);
    assert.match(source, /getPlatformConnectionServices/);
    assert.match(source, /routeErrorResponse/);
    assert.equal(source.includes("line-access-token"), false);
    assert.equal(source.includes("webhookKeyHash"), false);
  }
});

function createHandlers(overrides = {}) {
  return createSupportOnboardingRouteHandlers({
    requireOwner: async () => OWNER,
    requireSameOrigin(request) {
      if (request.headers.get("origin") !== new URL(request.url).origin) {
        const error = new Error("Invalid request origin.");
        error.status = 403;
        throw error;
      }
    },
    getServices: async () => ({
      connections: overrides.connections ?? {
        async getDefault() {
          return null;
        },
      },
      supportStore: overrides.supportStore ?? {
        async getConfiguration() {
          return null;
        },
      },
      onboarding: overrides.onboarding ?? {
        async getReadiness() {
          return readinessState();
        },
      },
    }),
  });
}

function sameOriginRequest(path, body) {
  return new Request(`https://app.example${path}`, {
    method: "POST",
    headers: {
      origin: "https://app.example",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function readinessState({ ready = false, webhookVerified = false } = {}) {
  return {
    status: ready ? "ready" : "needs_attention",
    ready,
    supportEnabled: false,
    state: "disabled",
    connection: { connected: true, active: true, displayName: "Owner OA" },
    checks: {
      lineActive: true,
      providerConfigured: ready,
      providerTested: false,
      enabledFaq: ready,
      webhookVerified,
      redeliveryAcknowledged: ready,
      nativeRepliesDisabledAcknowledged: ready,
    },
  };
}
