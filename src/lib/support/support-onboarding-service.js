import crypto from "node:crypto";

import { getLLMModelOptions } from "../ai/model-config.js";
import { normalizeEmail } from "../auth/policy.js";
import { hashWebhookKey } from "./identity-crypto.js";

const WEBHOOK_KEY_BYTES = 32;
const DEFAULT_PROVIDER_TEST_TIMEOUT_MS = 10_000;
const AI_TEST_SYSTEM_PROMPT = "Return exactly OK.";
const AI_TEST_PROMPT = "OK";
const defaultWebhookProvisionFlights = new Map();
const PROVIDER_KEY_BY_NAME = Object.freeze({
  google: "googleAiApiKey",
  openai: "openAiApiKey",
});

export function createSupportOnboardingService({
  connections,
  supportStore,
  settingsStore,
  lineAdapter,
  generateTextImpl,
  env = process.env,
  randomBytes = crypto.randomBytes,
  providerTestTimeoutMs = DEFAULT_PROVIDER_TEST_TIMEOUT_MS,
  providerTestFlights = new Map(),
  webhookProvisionFlights = defaultWebhookProvisionFlights,
}) {
  return {
    async provisionLineWebhook(ownerEmail, connectionId) {
      const owner = requireOwner(ownerEmail);
      const id = requireConnectionId(connectionId);
      const flightKey = `${owner}\u0000${id}`;
      if (webhookProvisionFlights.has(flightKey)) throw webhookProvisionBusyError();
      const operation = runWebhookProvision({
        connections,
        supportStore,
        settingsStore,
        lineAdapter,
        env,
        randomBytes,
        owner,
        connectionId: id,
      });
      webhookProvisionFlights.set(flightKey, operation);
      try {
        return await operation;
      } finally {
        if (webhookProvisionFlights.get(flightKey) === operation) {
          webhookProvisionFlights.delete(flightKey);
        }
      }
    },

    async getReadiness(ownerEmail, connectionId) {
      return getReadiness({
        connections,
        supportStore,
        settingsStore,
        owner: requireOwner(ownerEmail),
        connectionId: optionalConnectionId(connectionId),
      });
    },

    async testAiProvider(ownerEmail, connectionId) {
      const owner = requireOwner(ownerEmail);
      const id = requireConnectionId(connectionId);
      const flightKey = `${owner}\u0000${id}`;
      if (providerTestFlights.has(flightKey)) throw providerTestBusyError();
      const operation = runProviderTest({
        supportStore,
        settingsStore,
        generateTextImpl,
        owner,
        connectionId: id,
        timeoutMs: normalizeProviderTestTimeout(providerTestTimeoutMs),
      });
      providerTestFlights.set(flightKey, operation);
      try {
        return await operation;
      } finally {
        if (providerTestFlights.get(flightKey) === operation) {
          providerTestFlights.delete(flightKey);
        }
      }
    },

    async setSupportEnabled(ownerEmail, connectionId, enabled) {
      const owner = requireOwner(ownerEmail);
      const id = requireConnectionId(connectionId);
      if (typeof enabled !== "boolean") throw routeError("Support enabled must be a boolean.", 400);

      if (!enabled) {
        await supportStore.setSupportState(owner, id, "disabled");
        return { supportEnabled: false, state: "disabled" };
      }

      try {
        await supportStore.enableIfReady(owner, id);
      } catch (error) {
        if (error?.status !== 409) throw error;
        error.readiness = await getReadiness({
          connections,
          supportStore,
          settingsStore,
          owner,
          connectionId: id,
        });
        throw error;
      }

      const readiness = await getReadiness({
        connections,
        supportStore,
        settingsStore,
        owner,
        connectionId: id,
      });
      return {
        ...readiness,
        supportEnabled: true,
        state: "enabled",
      };
    },
  };
}

async function runWebhookProvision({
  connections,
  supportStore,
  settingsStore,
  lineAdapter,
  env,
  randomBytes,
  owner,
  connectionId,
}) {
  const baseUrl = trustedHttpsBase(env?.NEXTAUTH_URL);
  const connection = await requireActiveLineConnection(connections, owner, connectionId);
  const accessToken = requireConnectionToken(connection);
  const webhookKey = toWebhookKey(randomBytes(WEBHOOK_KEY_BYTES));
  const webhookUrl = new URL(`/api/webhooks/line/${webhookKey}`, baseUrl).toString();
  const webhookKeyHash = hashWebhookKey(webhookKey);

  let prepared;
  try {
    prepared = await supportStore.prepareWebhook(owner, connectionId, webhookKeyHash);
  } catch (error) {
    if (isConfigurationChanged(error)) throw webhookProvisionConflictError();
    throw setupError();
  }
  const attempt = {
    expectedVersion: prepared.version,
    expectedWebhookKeyHash: webhookKeyHash,
  };

  let verified = false;
  try {
    await lineAdapter.configureWebhook({ accessToken, webhookUrl });
    const testResult = await lineAdapter.testWebhook({ accessToken });
    const status = await lineAdapter.getWebhookStatus({ accessToken });
    verified = testResult?.success === true
      && status?.active === true
      && sameWebhookUrl(status?.endpoint, webhookUrl);
    await supportStore.recordWebhookVerification(
      owner,
      connectionId,
      verified,
      attempt,
    );
  } catch (error) {
    if (isConfigurationChanged(error)) throw webhookProvisionConflictError();
    try {
      await supportStore.recordWebhookVerification(
        owner,
        connectionId,
        false,
        attempt,
      );
    } catch (recordError) {
      if (isConfigurationChanged(recordError)) throw webhookProvisionConflictError();
      // The setup error below remains bounded even if readiness persistence also fails.
    }
    throw setupError();
  }

  return {
    webhookUrl,
    setupStatus: verified ? "verified" : "needs_action",
    readiness: await getReadiness({
      connections,
      supportStore,
      settingsStore,
      owner,
      connectionId,
    }),
  };
}

export function toSafeSupportReadiness(value) {
  const ready = value?.ready === true;
  return {
    status: ready ? "ready" : "needs_attention",
    ready,
    supportEnabled: value?.supportEnabled === true,
    state: value?.state === "enabled" ? "enabled" : "disabled",
    connection: {
      connected: value?.connection?.connected === true,
      active: value?.connection?.active === true,
      displayName: typeof value?.connection?.displayName === "string"
        ? value.connection.displayName
        : "",
    },
    checks: {
      lineActive: value?.checks?.lineActive === true,
      providerConfigured: value?.checks?.providerConfigured === true,
      providerTested: value?.checks?.providerTested === true,
      enabledFaq: value?.checks?.enabledFaq === true,
      webhookVerified: value?.checks?.webhookVerified === true,
      redeliveryAcknowledged: value?.checks?.redeliveryAcknowledged === true,
      nativeRepliesDisabledAcknowledged:
        value?.checks?.nativeRepliesDisabledAcknowledged === true,
    },
  };
}

async function getReadiness({ connections, supportStore, settingsStore, owner, connectionId }) {
  const configuration = await supportStore.getConfiguration(owner);
  const configuredConnectionId = configuration?.platformConnectionId;
  const id = connectionId ?? configuredConnectionId ?? null;
  const configurationMatches = Boolean(configuration && id && configuredConnectionId === id);

  const [connection, settings, faqs] = await Promise.all([
    id ? connections.getById(owner, id) : null,
    configurationMatches ? settingsStore.read(owner) : {},
    configurationMatches ? supportStore.listFaqs(owner) : [],
  ]);

  const checks = {
    lineActive: isActiveLineConnection(connection),
    providerConfigured: configurationMatches && hasConfiguredProvider(configuration, settings),
    providerTested: configurationMatches && configuration.providerTested === true,
    enabledFaq: configurationMatches && faqs.some((faq) => faq?.enabled === true),
    webhookVerified: configurationMatches && configuration.webhookVerified === true,
    redeliveryAcknowledged: configurationMatches && configuration.redeliveryAcknowledged === true,
    nativeRepliesDisabledAcknowledged:
      configurationMatches && configuration.nativeRepliesDisabledAcknowledged === true,
  };
  const ready = checks.lineActive
    && checks.providerConfigured
    && checks.enabledFaq
    && checks.webhookVerified
    && checks.redeliveryAcknowledged
    && checks.nativeRepliesDisabledAcknowledged;

  return {
    status: ready ? "ready" : "needs_attention",
    ready,
    supportEnabled: configurationMatches && configuration.supportState === "enabled",
    state: configurationMatches ? configuration.supportState : "disabled",
    connection: {
      connected: Boolean(connection),
      active: checks.lineActive,
      displayName: typeof connection?.displayName === "string" ? connection.displayName : "",
    },
    checks,
  };
}

async function runProviderTest({
  supportStore,
  settingsStore,
  generateTextImpl,
  owner,
  connectionId,
  timeoutMs,
}) {
  const configuration = await requireMatchingConfiguration(supportStore, owner, connectionId);
  const settings = await settingsStore.read(owner);
  if (!hasConfiguredProvider(configuration, settings)) {
    throw routeError("AI provider is not configured.", 409);
  }
  const expectedVersion = configuration.version;
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
    throw configurationChangedError();
  }

  const controller = new AbortController();
  let timeoutId;
  const deadline = new Promise((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new Error("AI provider test deadline exceeded."));
    }, timeoutMs);
  });

  try {
    await Promise.race([
      generateTextImpl({
        llmProvider: configuration.llmProvider,
        llmModel: configuration.llmModel,
        settings,
        systemPrompt: AI_TEST_SYSTEM_PROMPT,
        prompt: AI_TEST_PROMPT,
        signal: controller.signal,
      }),
      deadline,
    ]);
  } catch {
    await recordProviderFailure(supportStore, owner, connectionId, expectedVersion);
    throw providerTestError();
  } finally {
    clearTimeout(timeoutId);
  }

  try {
    await supportStore.recordProviderTest(owner, connectionId, true, { expectedVersion });
  } catch (error) {
    if (isConfigurationChanged(error)) throw error;
    await recordProviderFailure(supportStore, owner, connectionId, expectedVersion);
    throw providerTestError();
  }

  return { status: "passed", providerTested: true };
}

async function recordProviderFailure(supportStore, owner, connectionId, expectedVersion) {
  try {
    await supportStore.recordProviderTest(owner, connectionId, false, { expectedVersion });
  } catch {
    // Do not let a stale provider result mutate a newer configuration.
  }
}

function isConfigurationChanged(error) {
  return error?.status === 409
    && error?.message === "Support configuration changed. Refresh readiness and try again.";
}

async function requireMatchingConfiguration(supportStore, owner, connectionId) {
  const configuration = await supportStore.getConfiguration(owner);
  if (!configuration || configuration.platformConnectionId !== connectionId) {
    throw routeError("Support configuration was not found.", 404);
  }
  return configuration;
}

async function requireActiveLineConnection(connections, owner, connectionId) {
  const connection = await connections.getById(owner, connectionId);
  if (!isActiveLineConnection(connection)) throw routeError("The LINE connection is not available.", 404);
  return connection;
}

function isActiveLineConnection(connection) {
  return connection?.platform === "line" && connection?.state === "active";
}

function hasConfiguredProvider(configuration, settings) {
  const provider = configuration?.llmProvider;
  const model = configuration?.llmModel;
  const keyName = PROVIDER_KEY_BY_NAME[provider];
  const models = provider ? getLLMModelOptions(provider) : [];
  return Boolean(
    keyName
    && typeof model === "string"
    && models.includes(model)
    && typeof settings?.[keyName] === "string"
    && settings[keyName].trim(),
  );
}

function requireConnectionToken(connection) {
  const token = typeof connection?.credentials?.accessToken === "string"
    ? connection.credentials.accessToken.trim()
    : "";
  if (!token) throw routeError("The LINE connection is not available.", 404);
  return token;
}

function trustedHttpsBase(value) {
  try {
    const url = new URL(String(value ?? ""));
    if (url.protocol !== "https:") throw new Error("not HTTPS");
    return url.origin;
  } catch {
    throw routeError("LINE support setup is unavailable.", 503);
  }
}

function toWebhookKey(value) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    throw routeError("LINE support setup is unavailable.", 503);
  }
  const key = Buffer.from(value).toString("base64url");
  if (!key) throw routeError("LINE support setup is unavailable.", 503);
  return key;
}

function sameWebhookUrl(left, right) {
  try {
    return new URL(left).toString() === new URL(right).toString();
  } catch {
    return false;
  }
}

function requireOwner(ownerEmail) {
  const owner = normalizeEmail(ownerEmail);
  if (!owner) throw routeError("Authentication is required.", 401);
  return owner;
}

function requireConnectionId(value) {
  const id = optionalConnectionId(value);
  if (!id) throw routeError("The LINE connection is not available.", 404);
  return id;
}

function optionalConnectionId(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function setupError() {
  const error = routeError("LINE support setup could not be completed.", 502);
  error.retryable = true;
  error.setupRetryable = true;
  return error;
}

function webhookProvisionBusyError() {
  const error = routeError("LINE support setup is already in progress.", 409);
  error.retryable = true;
  error.setupRetryable = true;
  return error;
}

function webhookProvisionConflictError() {
  const error = routeError("LINE support setup changed. Retry readiness.", 409);
  error.retryable = true;
  error.setupRetryable = true;
  return error;
}

function providerTestError() {
  const error = routeError("AI provider test failed.", 502);
  error.retryable = true;
  return error;
}

function providerTestBusyError() {
  return routeError("AI provider test is already in progress.", 409);
}

function configurationChangedError() {
  return routeError("Support configuration changed. Refresh readiness and try again.", 409);
}

function normalizeProviderTestTimeout(value) {
  return Number.isInteger(value) && value > 0 && value <= 60_000
    ? value
    : DEFAULT_PROVIDER_TEST_TIMEOUT_MS;
}

function routeError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}
