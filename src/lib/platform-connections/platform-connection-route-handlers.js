import { createDbClient } from "../db/index.js";

import { createMetaOAuthService } from "./meta-oauth-service.js";
import { createLineChannelService } from "./line-channel-service.js";
import { createOAuthTransactionStore } from "./oauth-transaction-store.js";
import { createPlatformConnectionStore } from "./platform-connection-store.js";
import { createPlatformConnectionsRepository } from "./platform-connections-repository.js";
import { fetchWithDeadline } from "./connection-lifecycle.js";

export function createPlatformConnectionRouteHandlers({ requireOwner, getServices = () => getPlatformConnectionServices(), fetchImpl = fetch, requestTimeoutMs = 10_000, respond = (body, init) => Response.json(body, init), redirect = (url) => Response.redirect(url, 302) }) {
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
      const { line } = await getServices();
      const body = requireLineConnectBody(request, await jsonBody(request));
      return respond({ connection: toAvailability(await line.connect(ownerEmail, body)) }, { status: 201 });
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
  return { connections, transactions, meta: createMetaOAuthService({ env, transactions, connections }), line: createLineChannelService({ connections }) };
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

function toCallbackRedirect(requestUrl, result) {
  const target = new URL(toSettingsPath(result?.returnPath), requestUrl);
  target.searchParams.set("meta", result?.status === "select_page" ? "select" : "reconnect");
  if (result?.status === "select_page") {
    target.searchParams.set("transactionId", String(result.transactionId));
  }
  return target.toString();
}

function toAvailability(connection) { return { platform: connection.platform, state: connection.state, displayName: connection.displayName, expiresAt: connection.expiresAt ?? null }; }
function toSafePage(page) { return { id: String(page?.id ?? ""), name: String(page?.name ?? "") }; }
function toSettingsPath(value) { const path = String(value ?? "").trim(); return path === "/settings" || path.startsWith("/settings?") || path.startsWith("/settings/") ? path : "/settings"; }
function requireManagedPlatform(value) { const platform = String(value ?? "").trim().toLowerCase(); if (platform !== "meta" && platform !== "line") throw routeError("Publishing platform not found.", 404); return platform; }
function routeError(message, status) { const error = new Error(message); error.status = status; return error; }
