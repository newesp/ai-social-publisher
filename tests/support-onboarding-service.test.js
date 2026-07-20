import assert from "node:assert/strict";
import { test } from "node:test";

import { hashWebhookKey } from "../src/lib/support/identity-crypto.js";
import { createSupportOnboardingService } from "../src/lib/support/support-onboarding-service.js";

const OWNER = "owner@example.com";
const CONNECTION_ID = "connection-1";
const FIXED_RANDOM_BYTES = Buffer.from(Array.from({ length: 32 }, (_, index) => index));

test("provision stores only the hash before configuring and verifies the generated HTTPS URL", async () => {
  const harness = createHarness();
  const result = await harness.service.provisionLineWebhook(OWNER, CONNECTION_ID);
  const webhookKey = result.webhookUrl.split("/").at(-1);

  assert.match(result.webhookUrl, /^https:\/\/app\.example\/api\/webhooks\/line\/[A-Za-z0-9_-]+$/);
  assert.equal(harness.configuration.webhookKeyHash, hashWebhookKey(webhookKey));
  assert.equal(harness.configuration.webhookKeyHash.includes(webhookKey), false);
  assert.equal(harness.configuration.webhookVerified, true);
  assert.deepEqual(harness.providerCalls.map(({ operation }) => operation), [
    "configure",
    "test",
    "status",
  ]);
  assert.equal(harness.providerCalls[0].hashWasStored, true);
  assert.equal(harness.providerCalls[0].accessToken, "line-access-token");
  assert.equal(harness.providerCalls[0].webhookUrl, result.webhookUrl);
  assert.equal(result.setupStatus, "verified");
  assert.equal(result.readiness.ready, true);
  assert.equal(JSON.stringify(result).includes("line-access-token"), false);
  assert.equal(JSON.stringify(result).includes(harness.configuration.webhookKeyHash), false);
});

test("provision rejects a non-HTTPS trusted base before persistence or provider use", async () => {
  const harness = createHarness({
    env: { NEXTAUTH_URL: "http://app.example" },
  });

  await assert.rejects(
    harness.service.provisionLineWebhook(OWNER, CONNECTION_ID),
    (error) => error.status === 503 && error.message === "LINE support setup is unavailable.",
  );
  assert.equal(harness.configuration.webhookKeyHash, null);
  assert.deepEqual(harness.providerCalls, []);
});

test("provider setup failure keeps the connection and support disabled with a safe retryable error", async () => {
  const harness = createHarness({
    lineAdapter: {
      async configureWebhook() {
        throw new Error("private LINE response containing line-access-token");
      },
    },
  });
  harness.configuration.supportState = "enabled";

  await assert.rejects(
    harness.service.provisionLineWebhook(OWNER, CONNECTION_ID),
    (error) => {
      assert.equal(error.status, 502);
      assert.equal(error.retryable, true);
      assert.equal(error.setupRetryable, true);
      assert.equal(error.message, "LINE support setup could not be completed.");
      assert.equal(JSON.stringify(error).includes("line-access-token"), false);
      assert.equal(JSON.stringify(error).includes("private LINE response"), false);
      return true;
    },
  );

  assert.equal(harness.connection.state, "active");
  assert.equal(harness.configuration.supportState, "disabled");
  assert.equal(harness.configuration.webhookVerified, false);
  assert.match(harness.configuration.webhookKeyHash, /^[a-f0-9]{64}$/);
});

test("an inactive or unreachable configured webhook remains a safe needs-action state", async () => {
  const harness = createHarness({
    lineAdapter: {
      async configureWebhook() {},
      async testWebhook() {
        return { success: false, statusCode: 503 };
      },
      async getWebhookStatus({ accessToken }) {
        return {
          active: false,
          endpoint: `https://app.example/api/webhooks/line/not-the-generated-key?token=${accessToken}`,
        };
      },
    },
  });

  const result = await harness.service.provisionLineWebhook(OWNER, CONNECTION_ID);

  assert.equal(result.setupStatus, "needs_action");
  assert.equal(result.readiness.ready, false);
  assert.equal(result.readiness.checks.webhookVerified, false);
  assert.equal(JSON.stringify(result).includes("line-access-token"), false);
});

test("concurrent webhook provisioning for one owner and connection is single-flight", async () => {
  let configureCalls = 0;
  let releaseFirst;
  let markFirstStarted;
  const firstStarted = new Promise((resolve) => {
    markFirstStarted = resolve;
  });
  const firstPending = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const harness = createHarness({
    webhookProvisionFlights: new Map(),
    lineAdapter: {
      async configureWebhook() {
        configureCalls += 1;
        if (configureCalls === 1) {
          markFirstStarted();
          await firstPending;
        }
      },
    },
  });

  const first = harness.service.provisionLineWebhook(OWNER, CONNECTION_ID);
  await firstStarted;
  try {
    await assert.rejects(
      harness.service.provisionLineWebhook(OWNER, CONNECTION_ID),
      (error) => error.status === 409
        && error.setupRetryable === true
        && error.message === "LINE support setup is already in progress.",
    );
  } finally {
    releaseFirst();
  }
  await first;
  assert.equal(configureCalls, 1);
  assert.deepEqual(harness.providerCalls.map(({ operation }) => operation), ["test", "status"]);
  await harness.service.provisionLineWebhook(OWNER, CONNECTION_ID);
  assert.equal(configureCalls, 2);
});

test("webhook provisioning single-flight is shared across service instances", async () => {
  let releaseFirst;
  let markFirstStarted;
  const firstStarted = new Promise((resolve) => {
    markFirstStarted = resolve;
  });
  const firstPending = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const firstHarness = createHarness({
    lineAdapter: {
      async configureWebhook() {
        markFirstStarted();
        await firstPending;
      },
    },
  });
  const secondHarness = createHarness();

  const first = firstHarness.service.provisionLineWebhook(OWNER, CONNECTION_ID);
  await firstStarted;
  try {
    await assert.rejects(
      secondHarness.service.provisionLineWebhook(OWNER, CONNECTION_ID),
      (error) => error.status === 409
        && error.message === "LINE support setup is already in progress.",
    );
  } finally {
    releaseFirst();
  }
  await first;
  assert.deepEqual(secondHarness.providerCalls, []);
});

test("readiness is static and does not call LINE or the AI provider on page load", async () => {
  let lineCalls = 0;
  let generationCalls = 0;
  const harness = createHarness({
    settings: {},
    lineAdapter: {
      async configureWebhook() { lineCalls += 1; },
      async testWebhook() { lineCalls += 1; },
      async getWebhookStatus() { lineCalls += 1; },
    },
    generateTextImpl: async () => {
      generationCalls += 1;
      return "OK";
    },
  });
  harness.configuration.webhookVerified = true;
  harness.configuration.providerTested = true;

  const readiness = await harness.service.getReadiness(OWNER, CONNECTION_ID);

  assert.equal(readiness.ready, false);
  assert.equal(readiness.checks.lineActive, true);
  assert.equal(readiness.checks.providerConfigured, false);
  assert.equal(readiness.checks.providerTested, true);
  assert.equal(readiness.checks.enabledFaq, true);
  assert.equal(lineCalls, 0);
  assert.equal(generationCalls, 0);
});

test("the explicit AI provider test makes one fixed minimal request and stores only tested state", async () => {
  const generationCalls = [];
  const harness = createHarness({
    generateTextImpl: async (input) => {
      generationCalls.push(input);
      return "private provider response";
    },
  });

  const result = await harness.service.testAiProvider(OWNER, CONNECTION_ID);

  assert.deepEqual(result, { status: "passed", providerTested: true });
  assert.equal(harness.configuration.providerTested, true);
  assert.equal(generationCalls.length, 1);
  assert.deepEqual(generationCalls[0], {
    llmProvider: "google",
    llmModel: "gemini-3.1-flash-lite",
    settings: { googleAiApiKey: "google-secret" },
    systemPrompt: "Return exactly OK.",
    prompt: "OK",
    signal: generationCalls[0].signal,
  });
  assert.equal(generationCalls[0].signal instanceof AbortSignal, true);
  assert.equal(JSON.stringify(result).includes("google-secret"), false);
  assert.equal(JSON.stringify(result).includes("private provider response"), false);
});

test("the explicit AI provider test has a deadline and aborts the injected provider call", async () => {
  let providerSignal;
  const harness = createHarness({
    providerTestTimeoutMs: 10,
    generateTextImpl: async ({ signal }) => {
      providerSignal = signal;
      if (!signal) throw new Error("missing abort signal");
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("private timeout")), { once: true });
      });
    },
  });

  await assert.rejects(
    harness.service.testAiProvider(OWNER, CONNECTION_ID),
    (error) => error.status === 502 && error.message === "AI provider test failed.",
  );
  assert.equal(providerSignal instanceof AbortSignal, true);
  assert.equal(providerSignal.aborted, true);
  assert.equal(harness.configuration.providerTested, false);
  assert.equal(harness.configuration.supportState, "disabled");
});

test("concurrent explicit provider tests for one owner and configuration charge at most once", async () => {
  let generationCalls = 0;
  let releaseFirst;
  let markStarted;
  const firstStarted = new Promise((resolve) => {
    markStarted = resolve;
  });
  const firstPending = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const harness = createHarness({
    generateTextImpl: async () => {
      generationCalls += 1;
      if (generationCalls === 1) {
        markStarted();
        await firstPending;
      }
      return "OK";
    },
  });

  const first = harness.service.testAiProvider(OWNER, CONNECTION_ID);
  await firstStarted;
  try {
    await assert.rejects(
      harness.service.testAiProvider(OWNER, CONNECTION_ID),
      (error) => error.status === 409
        && error.message === "AI provider test is already in progress.",
    );
  } finally {
    releaseFirst();
  }
  await first;
  assert.equal(generationCalls, 1);
});

test("a stale successful provider test cannot mark a changed configuration as tested", async () => {
  let releaseProvider;
  let markProviderStarted;
  const providerStarted = new Promise((resolve) => {
    markProviderStarted = resolve;
  });
  const providerPending = new Promise((resolve) => {
    releaseProvider = resolve;
  });
  const harness = createHarness({
    generateTextImpl: async () => {
      markProviderStarted();
      await providerPending;
      return "OK";
    },
  });
  harness.configuration.version = 7;

  const testing = harness.service.testAiProvider(OWNER, CONNECTION_ID);
  await providerStarted;
  harness.configuration.version = 8;
  harness.configuration.llmProvider = "openai";
  harness.configuration.llmModel = "gpt-4o";
  harness.configuration.providerTested = false;
  releaseProvider();

  await assert.rejects(
    testing,
    (error) => error.status === 409
      && error.message === "Support configuration changed. Refresh readiness and try again.",
  );
  assert.equal(harness.configuration.llmProvider, "openai");
  assert.equal(harness.configuration.providerTested, false);
  assert.equal(harness.configuration.version, 8);
});

test("a failed AI provider test disables support and redacts provider details", async () => {
  const harness = createHarness({
    generateTextImpl: async () => {
      throw new Error("private OpenAI body with google-secret");
    },
  });
  harness.configuration.supportState = "enabled";
  harness.configuration.providerTested = true;

  await assert.rejects(
    harness.service.testAiProvider(OWNER, CONNECTION_ID),
    (error) => error.status === 502
      && error.message === "AI provider test failed."
      && !JSON.stringify(error).includes("private OpenAI body")
      && !JSON.stringify(error).includes("google-secret"),
  );
  assert.equal(harness.configuration.providerTested, false);
  assert.equal(harness.configuration.supportState, "disabled");
});

test("support can be enabled only when every required static readiness check passes", async () => {
  const harness = createHarness();
  harness.configuration.webhookVerified = true;

  const enabled = await harness.service.setSupportEnabled(OWNER, CONNECTION_ID, true);
  assert.equal(enabled.supportEnabled, true);
  assert.equal(harness.configuration.supportState, "enabled");

  harness.configuration.supportState = "disabled";
  harness.faqs[0].enabled = false;
  await assert.rejects(
    harness.service.setSupportEnabled(OWNER, CONNECTION_ID, true),
    (error) => error.status === 409
      && error.message === "AI support is not ready to be enabled."
      && error.readiness?.checks.enabledFaq === false,
  );
  assert.equal(harness.configuration.supportState, "disabled");
});

test("support enable invokes the repository-backed mutation gate before readiness diagnostics", async () => {
  const calls = [];
  const harness = createHarness({
    settingsStore: {
      async read() {
        calls.push("settings-read");
        return { googleAiApiKey: "google-secret" };
      },
    },
  });
  harness.configuration.webhookVerified = true;
  harness.supportStore.enableIfReady = async () => {
    calls.push("atomic-enable");
    harness.configuration.supportState = "enabled";
    harness.configuration.version += 1;
    return { ...harness.configuration };
  };

  const result = await harness.service.setSupportEnabled(OWNER, CONNECTION_ID, true);

  assert.equal(result.supportEnabled, true);
  assert.equal(harness.configuration.supportState, "enabled");
  assert.deepEqual(calls, ["atomic-enable", "settings-read"]);
});

test("an authoritative gate rejection cannot be bypassed by a ready diagnostic snapshot", async () => {
  const harness = createHarness();
  harness.configuration.webhookVerified = true;
  harness.supportStore.enableIfReady = async () => {
    const error = new Error("AI support is not ready to be enabled.");
    error.status = 409;
    throw error;
  };

  await assert.rejects(
    harness.service.setSupportEnabled(OWNER, CONNECTION_ID, true),
    (error) => error.status === 409
      && error.message === "AI support is not ready to be enabled."
      && error.readiness?.ready === true,
  );
  assert.equal(harness.configuration.supportState, "disabled");
});

test("disabling support is allowed without connection, settings, FAQ, LINE, or AI calls", async () => {
  const calls = [];
  const harness = createHarness({
    connections: {
      async getById() {
        throw new Error("connections must not be read");
      },
    },
    settingsStore: {
      async read() {
        throw new Error("settings must not be read");
      },
    },
    generateTextImpl: async () => {
      throw new Error("AI must not be called");
    },
  });
  harness.supportStore.listFaqs = async () => {
    throw new Error("FAQs must not be read");
  };
  harness.supportStore.setSupportState = async (ownerEmail, connectionId, state) => {
    calls.push([ownerEmail, connectionId, state]);
    harness.configuration.supportState = state;
    return { ...harness.configuration };
  };
  harness.configuration.supportState = "enabled";

  const result = await harness.service.setSupportEnabled(OWNER, CONNECTION_ID, false);

  assert.deepEqual(result, { supportEnabled: false, state: "disabled" });
  assert.deepEqual(calls, [[OWNER, CONNECTION_ID, "disabled"]]);
});

function createHarness(overrides = {}) {
  const connection = {
    id: CONNECTION_ID,
    ownerEmail: OWNER,
    platform: "line",
    state: "active",
    displayName: "Owner OA",
    credentials: {
      accessToken: "line-access-token",
      channelSecret: "channel-secret",
    },
  };
  const configuration = {
    id: "configuration-1",
    platformConnectionId: CONNECTION_ID,
    brandName: "Acme",
    assistantName: "Ada",
    replyTone: "friendly",
    llmProvider: "google",
    llmModel: "gemini-3.1-flash-lite",
    supportState: "disabled",
    webhookKeyHash: null,
    webhookVerified: false,
    redeliveryAcknowledged: true,
    nativeRepliesDisabledAcknowledged: true,
    providerTested: false,
    version: 0,
  };
  const faqs = [{
    id: "faq-1",
    question: "How?",
    answer: "Like this.",
    enabled: true,
    priority: 0,
  }];
  const providerCalls = [];
  const connections = overrides.connections ?? {
    async getById(ownerEmail, connectionId) {
      return ownerEmail === OWNER && connectionId === CONNECTION_ID ? connection : null;
    },
  };
  const supportStore = {
    async prepareWebhook(ownerEmail, connectionId, webhookKeyHash) {
      assert.equal(ownerEmail, OWNER);
      assert.equal(connectionId, CONNECTION_ID);
      configuration.platformConnectionId = connectionId;
      configuration.webhookKeyHash = webhookKeyHash;
      configuration.webhookVerified = false;
      configuration.supportState = "disabled";
      return { ...configuration };
    },
    async recordWebhookVerification(ownerEmail, connectionId, verified, options = {}) {
      assert.equal(ownerEmail, OWNER);
      assert.equal(connectionId, CONNECTION_ID);
      if (
        options.expectedVersion !== configuration.version
        || options.expectedWebhookKeyHash !== configuration.webhookKeyHash
      ) {
        const error = new Error("Support configuration changed. Refresh readiness and try again.");
        error.status = 409;
        throw error;
      }
      configuration.webhookVerified = verified;
      if (!verified) configuration.supportState = "disabled";
      configuration.version += 1;
      return { ...configuration };
    },
    async recordProviderTest(ownerEmail, connectionId, tested, options = {}) {
      assert.equal(ownerEmail, OWNER);
      assert.equal(connectionId, CONNECTION_ID);
      if (options.expectedVersion !== configuration.version) {
        const error = new Error("Support configuration changed. Refresh readiness and try again.");
        error.status = 409;
        throw error;
      }
      configuration.providerTested = tested;
      if (!tested) configuration.supportState = "disabled";
      configuration.version += 1;
      return { ...configuration };
    },
    async enableIfReady(ownerEmail, connectionId) {
      assert.equal(ownerEmail, OWNER);
      assert.equal(connectionId, CONNECTION_ID);
      const currentConnection = await connections.getById(ownerEmail, connectionId);
      const currentSettings = await settingsStore.read(ownerEmail);
      const providerKey = configuration.llmProvider === "google"
        ? currentSettings.googleAiApiKey
        : currentSettings.openAiApiKey;
      if (
        currentConnection?.platform !== "line"
        || currentConnection?.state !== "active"
        || typeof providerKey !== "string"
        || !providerKey.trim()
        || !faqs.some((faq) => faq.enabled)
        || configuration.webhookVerified !== true
        || configuration.redeliveryAcknowledged !== true
        || configuration.nativeRepliesDisabledAcknowledged !== true
      ) {
        const error = new Error("AI support is not ready to be enabled.");
        error.status = 409;
        throw error;
      }
      configuration.supportState = "enabled";
      configuration.version += 1;
      return { ...configuration };
    },
    async setSupportState(ownerEmail, connectionId, state, options = {}) {
      assert.equal(ownerEmail, OWNER);
      assert.equal(connectionId, CONNECTION_ID);
      if (state === "enabled" && options.expectedVersion !== configuration.version) {
        const error = new Error("Support configuration changed. Refresh readiness and try again.");
        error.status = 409;
        throw error;
      }
      configuration.supportState = state;
      configuration.version += 1;
      return { ...configuration };
    },
    async getConfiguration(ownerEmail) {
      return ownerEmail === OWNER ? { ...configuration } : null;
    },
    async listFaqs(ownerEmail) {
      return ownerEmail === OWNER ? faqs.map((faq) => ({ ...faq })) : [];
    },
  };
  const lineAdapter = {
    async configureWebhook({ accessToken, webhookUrl }) {
      providerCalls.push({
        operation: "configure",
        accessToken,
        webhookUrl,
        hashWasStored: Boolean(configuration.webhookKeyHash),
      });
    },
    async testWebhook({ accessToken }) {
      providerCalls.push({ operation: "test", accessToken });
      return { success: true, statusCode: 200 };
    },
    async getWebhookStatus({ accessToken }) {
      providerCalls.push({ operation: "status", accessToken });
      const configuredUrl = providerCalls.find(({ webhookUrl }) => webhookUrl)?.webhookUrl;
      return { endpoint: configuredUrl, active: true };
    },
    ...overrides.lineAdapter,
  };
  const settings = overrides.settings ?? { googleAiApiKey: "google-secret" };
  const settingsStore = overrides.settingsStore ?? {
    async read(ownerEmail) {
      return ownerEmail === OWNER ? { ...settings } : {};
    },
  };
  const service = createSupportOnboardingService({
    connections,
    supportStore,
    settingsStore,
    lineAdapter,
    generateTextImpl: overrides.generateTextImpl ?? (async () => "OK"),
    env: overrides.env ?? { NEXTAUTH_URL: "https://app.example" },
    providerTestTimeoutMs: overrides.providerTestTimeoutMs,
    providerTestFlights: overrides.providerTestFlights,
    webhookProvisionFlights: overrides.webhookProvisionFlights,
    randomBytes: (size) => {
      assert.equal(size, 32);
      return FIXED_RANDOM_BYTES;
    },
  });

  return {
    service,
    connection,
    configuration,
    faqs,
    providerCalls,
    supportStore,
  };
}
