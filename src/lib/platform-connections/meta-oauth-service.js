const GRAPH_API_URL = "https://graph.facebook.com/v25.0";
const AUTHORIZATION_URL = "https://www.facebook.com/v25.0/dialog/oauth";
const SCOPES = ["pages_show_list", "pages_read_engagement", "pages_manage_posts"];
const TRANSACTION_ERROR = "OAuth transaction is expired or already used.";
const META_ERROR = "Meta connection could not be completed.";

export function createMetaOAuthService({ env = process.env, fetchImpl = fetch, transactions, connections, now = () => new Date() }) {
  return {
    async start(ownerEmail, returnPath) {
      const owner = normalizeOwner(ownerEmail);
      const config = requireConfig(env);
      const safeReturnPath = toSettingsPath(returnPath);
      const transaction = await transactions.create(owner, "meta", { phase: "authorization", returnPath: safeReturnPath }, safeReturnPath, currentTime(now));
      const url = new URL(AUTHORIZATION_URL);
      url.searchParams.set("client_id", config.appId);
      url.searchParams.set("redirect_uri", config.redirectUri);
      url.searchParams.set("state", transaction.id);
      url.searchParams.set("scope", SCOPES.join(","));
      return { authorizeUrl: url.toString() };
    },

    async completeCallback(ownerEmail, searchParams) {
      const owner = normalizeOwner(ownerEmail);
      const state = requireValue(readParam(searchParams, "state"), TRANSACTION_ERROR);
      const pending = await transactions.consume(owner, state, currentTime(now));
      if (pending?.phase !== "authorization") throw transactionError();
      const returnPath = toSettingsPath(pending.returnPath);
      if (readParam(searchParams, "error")) return { status: "reconnect", returnPath };

      const code = readParam(searchParams, "code");
      if (!code) return { status: "reconnect", returnPath };

      const config = requireConfig(env);
      const shortLivedToken = await exchangeCode(fetchImpl, config, code);
      const longLivedToken = await exchangeLongLivedToken(fetchImpl, config, shortLivedToken);
      const pages = await listPages(fetchImpl, longLivedToken);
      const expiresAt = expiresAtFrom(longLivedToken.expires_in, currentTime(now));
      const selection = await transactions.create(owner, "meta", {
        phase: "page_selection",
        returnPath,
        longLivedUserAccessToken: longLivedToken.access_token,
        expiresAt: expiresAt?.toISOString() ?? null,
        pages,
      }, returnPath, currentTime(now));

      return { status: "select_page", transactionId: selection.id, returnPath, pages: pages.map(toSafePage) };
    },

    async getPendingPages(ownerEmail, transactionId) {
      const pending = await transactions.read(normalizeOwner(ownerEmail), requireValue(transactionId, TRANSACTION_ERROR), currentTime(now));
      if (pending?.phase !== "page_selection" || !Array.isArray(pending.pages)) throw transactionError();
      return pending.pages.map(toSafePage);
    },

    async selectPage(ownerEmail, transactionId, pageId) {
      const owner = normalizeOwner(ownerEmail);
      const pending = await transactions.consume(owner, requireValue(transactionId, TRANSACTION_ERROR), currentTime(now));
      if (pending?.phase !== "page_selection" || !Array.isArray(pending.pages)) throw transactionError();
      const page = pending.pages.find((candidate) => candidate.id === String(pageId ?? "").trim());
      if (!page) throw routeError("The selected Meta Page is not available.", 400);

      const connection = await connections.replaceDefault(owner, {
        platform: "meta",
        displayName: page.name,
        credentials: {
          pageId: page.id,
          pageName: page.name,
          pageAccessToken: page.accessToken,
          longLivedUserAccessToken: pending.longLivedUserAccessToken,
          userTokenExpiresAt: pending.expiresAt ?? null,
        },
        expiresAt: parseExpiresAt(pending.expiresAt),
      });
      return toAvailability(connection);
    },
  };
}

async function exchangeCode(fetchImpl, config, code) {
  const url = new URL(`${GRAPH_API_URL}/oauth/access_token`);
  url.searchParams.set("client_id", config.appId);
  url.searchParams.set("client_secret", config.appSecret);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("code", code);
  return requireToken(await readProviderJson(fetchImpl, url), "access_token");
}

async function exchangeLongLivedToken(fetchImpl, config, shortLivedToken) {
  const url = new URL(`${GRAPH_API_URL}/oauth/access_token`);
  url.searchParams.set("grant_type", "fb_exchange_token");
  url.searchParams.set("client_id", config.appId);
  url.searchParams.set("client_secret", config.appSecret);
  url.searchParams.set("fb_exchange_token", shortLivedToken.access_token);
  return requireToken(await readProviderJson(fetchImpl, url), "access_token");
}

async function listPages(fetchImpl, longLivedToken) {
  const url = new URL(`${GRAPH_API_URL}/me/accounts`);
  url.searchParams.set("fields", "id,name,access_token");
  url.searchParams.set("access_token", longLivedToken.access_token);
  const body = await readProviderJson(fetchImpl, url);
  if (!Array.isArray(body?.data)) throw metaError();
  return body.data.map((page) => {
    const id = String(page?.id ?? "").trim();
    const name = String(page?.name ?? "").trim();
    const accessToken = String(page?.access_token ?? "").trim();
    if (!id || !name || !accessToken) throw metaError();
    return { id, name, accessToken };
  });
}

async function readProviderJson(fetchImpl, url) {
  let response;
  try {
    response = await fetchImpl(url.toString());
  } catch {
    throw metaError();
  }
  if (!response?.ok) throw metaError();
  try {
    return await response.json();
  } catch {
    throw metaError();
  }
}

function requireToken(body, name) {
  if (!String(body?.[name] ?? "").trim()) throw metaError();
  return body;
}

function requireConfig(env) {
  const appId = String(env?.META_APP_ID ?? "").trim();
  const appSecret = String(env?.META_APP_SECRET ?? "").trim();
  const redirectUri = String(env?.META_OAUTH_REDIRECT_URI ?? "").trim();
  if (!appId || !appSecret || !redirectUri) throw routeError("Meta connection needs to be configured.", 503);
  try { new URL(redirectUri); } catch { throw routeError("Meta connection needs to be configured.", 503); }
  return { appId, appSecret, redirectUri };
}

function readParam(searchParams, name) { return String(searchParams?.get?.(name) ?? "").trim(); }
function normalizeOwner(value) { const owner = String(value ?? "").trim().toLowerCase(); if (!owner) throw transactionError(); return owner; }
function requireValue(value, message) { const result = String(value ?? "").trim(); if (!result) throw routeError(message, 400); return result; }
function currentTime(now) { const value = typeof now === "function" ? now() : now; const date = value instanceof Date ? value : new Date(value); if (Number.isNaN(date.getTime())) throw metaError(); return date; }
function expiresAtFrom(seconds, now) { const numeric = Number(seconds); return Number.isFinite(numeric) && numeric > 0 ? new Date(now.getTime() + numeric * 1000) : null; }
function parseExpiresAt(value) { if (value == null) return null; const date = new Date(value); return Number.isNaN(date.getTime()) ? null : date; }
function toSafePage(page) { return { id: page.id, name: page.name }; }
function toAvailability(connection) { return { platform: connection.platform, state: connection.state, displayName: connection.displayName, expiresAt: connection.expiresAt ?? null }; }
function toSettingsPath(value) { const path = String(value ?? "").trim(); return path === "/settings" || path.startsWith("/settings?") || path.startsWith("/settings/") ? path : "/settings"; }
function metaError() { return routeError(META_ERROR, 502); }
function transactionError() { return routeError(TRANSACTION_ERROR, 400); }
function routeError(message, status) { const error = new Error(message); error.status = status; return error; }
