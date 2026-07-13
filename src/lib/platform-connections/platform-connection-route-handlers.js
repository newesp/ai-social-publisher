import { createDbClient } from "../db/index.js";

import { createMetaOAuthService } from "./meta-oauth-service.js";
import { createOAuthTransactionStore } from "./oauth-transaction-store.js";
import { createPlatformConnectionStore } from "./platform-connection-store.js";
import { createPlatformConnectionsRepository } from "./platform-connections-repository.js";

export function createPlatformConnectionRouteHandlers({ requireOwner, getServices = () => getPlatformConnectionServices(), respond = (body, init) => Response.json(body, init), redirect = (url) => Response.redirect(url, 302) }) {
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
        const result = await meta.completeCallback(new URL(request.url).searchParams, ownerEmail);
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
  };
}

export function getPlatformConnectionServices(env = process.env) {
  const repository = createPlatformConnectionsRepository(createDbClient(env));
  const options = { repository, encryptionKey: env.SETTINGS_ENCRYPTION_KEY };
  const connections = createPlatformConnectionStore(options);
  const transactions = createOAuthTransactionStore(options);
  return { connections, transactions, meta: createMetaOAuthService({ env, transactions, connections }) };
}

export function requireSameOrigin(request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) throw routeError("Invalid request origin.", 403);
}

async function jsonBody(request) {
  try { return await request.json(); } catch { throw routeError("A JSON request body is required.", 400); }
}

function toCallbackRedirect(requestUrl, result) {
  const target = new URL(toSettingsPath(result?.returnPath), requestUrl);
  target.searchParams.set("meta", result?.status === "select_page" ? "select" : "reconnect");
  if (result?.status === "select_page") {
    target.searchParams.set("transactionId", String(result.transactionId));
    target.searchParams.set("pages", JSON.stringify(Array.isArray(result.pages) ? result.pages.map(toSafePage) : []));
  }
  return target.toString();
}

function toAvailability(connection) { return { platform: connection.platform, state: connection.state, displayName: connection.displayName, expiresAt: connection.expiresAt ?? null }; }
function toSafePage(page) { return { id: String(page?.id ?? ""), name: String(page?.name ?? "") }; }
function toSettingsPath(value) { const path = String(value ?? "").trim(); return path === "/settings" || path.startsWith("/settings?") || path.startsWith("/settings/") ? path : "/settings"; }
function routeError(message, status) { const error = new Error(message); error.status = status; return error; }
