import { createDbClient } from "../db/index.js";
import { generateText } from "../ai/llm-service.js";
import { getUserSettingsStore } from "../settings/settings-store.js";
import { createLineSupportAdapter } from "../support/channel-adapters/line-support-adapter.js";
import {
  createSupportOnboardingService,
  toSafeSupportReadiness,
} from "../support/support-onboarding-service.js";
import { getSupportStore } from "../support/support-store.js";

import { createMetaOAuthService } from "./meta-oauth-service.js";
import { createLineChannelService } from "./line-channel-service.js";
import { createOAuthTransactionStore } from "./oauth-transaction-store.js";
import { createPlatformConnectionStore } from "./platform-connection-store.js";
import { createPlatformConnectionsRepository } from "./platform-connections-repository.js";
import { fetchWithDeadline } from "./connection-lifecycle.js";

const supportProviderTestFlights = new Map();

export function createPlatformConnectionRouteHandlers({ requireOwner, getServices = () => getPlatformConnectionServices(), fetchImpl = fetch, requestTimeoutMs = 10_000, respond = (body, init) => Response.json(body, init), redirect = (url, status = 302) => Response.redirect(url, status) }) {
  return {
    async GET() {
      const ownerEmail = await requireOwner();
      const { connections } = await getServices();
      return respond({ connections: (await connections.listAvailability(ownerEmail)).map(toAvailability) });
    },
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
    async completeMeta(request) {
      const ownerEmail = await requireOwner();
      try {
        const { meta } = await getServices();
        const result = await meta.completeCallback(ownerEmail, new URL(request.url).searchParams);
        return redirect(toCallbackRedirect(request.url, result));
      } catch {
        return redirect(toCallbackRedirect(request.url, { status: "reconnect", returnPath: "/settings" }));
      }
    },
    async selectMeta(request) {
      const ownerEmail = await requireOwner();
      requireSameOrigin(request);
      const { meta } = await getServices();
      const body = await jsonBody(request);
      return respond({ connection: toAvailability(await meta.selectPage(ownerEmail, body.transactionId, body.pageId)) });
    },
    async connectLine(request) {
      const ownerEmail = await requireOwner();
      requireSameOrigin(request);
      const { line, connections, onboarding } = await getServices();
      const body = requireLineConnectBody(request, await jsonBody(request));
      const connection = await line.connect(ownerEmail, body);
      let internalConnection = null;
      try {
        internalConnection = await connections.getDefault(ownerEmail, "line");
        if (!internalConnection?.id) throw new Error("LINE connection lookup failed.");
        const setup = await onboarding.provisionLineWebhook(ownerEmail, internalConnection.id);
        return respond({
          connection: toAvailability(connection),
          supportSetup: {
            status: setup?.setupStatus === "verified" ? "verified" : "needs_action",
            retryable: setup?.setupStatus !== "verified",
          },
          readiness: toSafeSupportReadiness(setup?.readiness),
        }, { status: 201 });
      } catch {
        let readiness = unavailableReadiness(connection);
        if (internalConnection?.id) {
          try {
            await onboarding.setSupportEnabled(ownerEmail, internalConnection.id, false);
          } catch {
            // The connection remains valid even when support-state persistence cannot be confirmed.
          }
          try {
            readiness = await onboarding.getReadiness(ownerEmail, internalConnection.id);
          } catch {
            // Return a bounded fallback rather than provider or storage details.
          }
        }
        return respond({
          connection: toAvailability(connection),
          supportSetup: { status: "retryable", retryable: true },
          readiness: toSafeSupportReadiness(readiness),
        }, { status: 201 });
      }
    },
    async getMetaPending(request) {
      const ownerEmail = await requireOwner();
      const { meta } = await getServices();
      const transactionId = new URL(request.url).searchParams.get("transactionId");
      return respond({ pages: (await meta.getPendingPages(ownerEmail, transactionId)).map(toSafePage) });
    },
    async disconnectPlatform(request, platform) {
      const ownerEmail = await requireOwner();
      requireSameOrigin(request);
      const safePlatform = requireManagedPlatform(platform);
      const { connections } = await getServices();
      const result = await connections.disconnectDefault(ownerEmail, safePlatform);
      if (result.status === "blocked") {
        return respond({ error: "Cancel or wait for pending posts before disconnecting this platform." }, { status: 409 });
      }
      if (result.status !== "disconnected") return respond({ connection: null });
      if (safePlatform === "meta") {
        return respond({ connection: null, notice: "You can separately revoke app access in Meta." });
      }
      const accessToken = String(result.credentials?.accessToken ?? "").trim();
      if (!accessToken) return respond({ connection: null });
      try {
        const response = await fetchWithDeadline(fetchImpl, "https://api.line.me/v2/oauth/revoke", {
          method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ access_token: accessToken }),
        }, requestTimeoutMs, async (providerResponse, signal) => {
          try {
            if (typeof providerResponse.arrayBuffer === "function") await providerResponse.arrayBuffer();
            else if (typeof providerResponse.json === "function") await providerResponse.json();
          } catch (error) { if (signal.aborted) throw error; }
          return providerResponse;
        });
        if (!response?.ok) throw new Error("revoke failed");
        return respond({ connection: null });
      } catch {
        return respond({ connection: null, warning: "LINE was disconnected locally, but token revocation could not be confirmed." });
      }
    },
  };
}

export function getPlatformConnectionServices(env = process.env) {
  const repository = createPlatformConnectionsRepository(createDbClient(env));
  const options = { repository, encryptionKey: env.SETTINGS_ENCRYPTION_KEY };
  const connections = createPlatformConnectionStore(options);
  const transactions = createOAuthTransactionStore(options);
  const supportStore = getSupportStore(env);
  const settingsStore = getUserSettingsStore(env);
  const lineAdapter = createLineSupportAdapter({});
  const onboarding = createSupportOnboardingService({
    connections,
    supportStore,
    settingsStore,
    lineAdapter,
    generateTextImpl: generateText,
    env,
    providerTestFlights: supportProviderTestFlights,
  });
  return {
    connections,
    transactions,
    supportStore,
    settingsStore,
    onboarding,
    meta: createMetaOAuthService({ env, transactions, connections }),
    line: createLineChannelService({ connections }),
  };
}

export function requireSameOrigin(request) {
  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(request.url).origin) throw routeError("Invalid request origin.", 403);
}

async function jsonBody(request) {
  try { return await request.json(); } catch { throw routeError("A JSON request body is required.", 400); }
}

function requireLineConnectBody(request, body) {
  const contentType = String(request.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
  const keys = body && typeof body === "object" && !Array.isArray(body) ? Object.keys(body) : [];
  if (contentType !== "application/json" || keys.length !== 2 || !keys.includes("channelId") || !keys.includes("channelSecret")) {
    throw routeError("A JSON LINE Channel ID and Channel Secret are required.", 400);
  }
  return body;
}

function requireMetaAuthorizationUrl(value) {
  const url = new URL(String(value ?? ""));
  if (url.protocol !== "https:" || url.hostname !== "www.facebook.com" || !url.pathname.endsWith("/dialog/oauth")) {
    throw routeError("Meta connection could not be started.", 502);
  }
  return url.toString();
}

function toCallbackRedirect(requestUrl, result) {
  const target = new URL(toSettingsPath(result?.returnPath), requestUrl);
  target.searchParams.set("meta", result?.status === "select_page" ? "select" : "reconnect");
  if (result?.status === "select_page") {
    target.searchParams.set("transactionId", String(result.transactionId));
  }
  return target.toString();
}

function toAvailability(connection) { return { platform: connection.platform, state: connection.state, displayName: connection.displayName, expiresAt: connection.expiresAt ?? null }; }
function unavailableReadiness(connection) {
  return {
    status: "needs_attention",
    ready: false,
    supportEnabled: false,
    state: "disabled",
    connection: {
      connected: Boolean(connection),
      active: connection?.platform === "line" && connection?.state === "active",
      displayName: typeof connection?.displayName === "string" ? connection.displayName : "",
    },
    checks: {
      lineActive: connection?.platform === "line" && connection?.state === "active",
      providerConfigured: false,
      providerTested: false,
      enabledFaq: false,
      webhookVerified: false,
      redeliveryAcknowledged: false,
      nativeRepliesDisabledAcknowledged: false,
    },
  };
}
function toSafePage(page) { return { id: String(page?.id ?? ""), name: String(page?.name ?? "") }; }
function toSettingsPath(value) { const path = String(value ?? "").trim(); return path === "/settings" || path.startsWith("/settings?") || path.startsWith("/settings/") ? path : "/settings"; }
function requireManagedPlatform(value) { const platform = String(value ?? "").trim().toLowerCase(); if (platform !== "meta" && platform !== "line") throw routeError("Publishing platform not found.", 404); return platform; }
function routeError(message, status) { const error = new Error(message); error.status = status; return error; }
