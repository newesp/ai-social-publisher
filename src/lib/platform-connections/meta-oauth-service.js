import crypto from "node:crypto";

import { authorizationLifecycleError, fetchWithDeadline, permanentConnectionFailureError, retryableLifecycleError } from "./connection-lifecycle.js";

const GRAPH_API_URL = "https://graph.facebook.com/v25.0";
const AUTHORIZATION_URL = "https://www.facebook.com/v25.0/dialog/oauth";
const SCOPES = ["pages_show_list", "pages_read_engagement", "pages_manage_posts"];
const TRANSACTION_ERROR = "OAuth transaction is expired or already used.";
const META_ERROR = "Meta connection could not be completed.";
const META_RECONNECT_ERROR = "Meta connection needs to be reconnected.";
const META_VALIDATION_WARNING = "Meta credential validation is temporarily unavailable; the current Page token is still being used.";
const META_RENEWAL_WARNING = "Meta credential refresh failed; the validated Page token is still being used.";
const META_RENEWAL_IN_PROGRESS = "Meta credential refresh is in progress. Please retry shortly.";
const RENEW_WITHIN_MS = 7 * 24 * 60 * 60 * 1000;
const LEASE_MS = 2 * 60 * 1000;
const sharedRenewals = new Map();

export function createMetaOAuthService({ env = process.env, fetchImpl = fetch, transactions, connections, now = () => new Date(), renewalFlights = sharedRenewals,
  requestTimeoutMs = 10_000, pollAttempts = 3, pollDelay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  return {
    async start(ownerEmail, returnPath) {
      const owner = normalizeOwner(ownerEmail);
      const config = requireConfig(env);
      const safeReturnPath = toSettingsPath(returnPath);
      const time = currentTime(now);
      await transactions.purgeExpired(time);
      const transaction = await transactions.create(owner, "meta", { phase: "authorization", returnPath: safeReturnPath }, safeReturnPath, time);
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
      const id = requireValue(transactionId, TRANSACTION_ERROR);
      const time = currentTime(now);
      const pending = await transactions.read(owner, id, time);
      if (pending?.phase !== "page_selection" || !Array.isArray(pending.pages)) throw transactionError();
      const page = pending.pages.find((candidate) => candidate.id === String(pageId ?? "").trim());
      if (!page) throw routeError("The selected Meta Page is not available.", 400);

      const connection = await connections.replaceDefaultFromOAuth(owner, {
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
      }, id, time);
      if (!connection) throw transactionError();
      return toAvailability(connection);
    },

    async ensureUsable(ownerEmail, connectionId) {
      const owner = normalizeOwner(ownerEmail);
      const id = requireValue(connectionId, "The Meta connection is not available.");
      const key = `${owner}:${id}`;
      if (renewalFlights.has(key)) return renewalFlights.get(key);
      const operation = ensureMetaUsable({ owner, id, env, fetchImpl, connections, now, requestTimeoutMs, pollAttempts, pollDelay });
      renewalFlights.set(key, operation);
      try { return await operation; } finally { renewalFlights.delete(key); }
    },
  };
}

async function ensureMetaUsable({ owner, id, env, fetchImpl, connections, now, requestTimeoutMs, pollAttempts, pollDelay }) {
  const connection = await connections.getById(owner, id);
  requireUsableMetaConnection(connection);
  const time = currentTime(now);
  const validation = await validatePage(fetchImpl, connection.credentials, requestTimeoutMs);
  if (validation === "transient") return { ...connection, warning: META_VALIDATION_WARNING };
  const pageValid = validation === "valid";
  const userExpiry = parseExpiresAt(connection.credentials?.userTokenExpiresAt ?? connection.expiresAt);
  const renewalAppropriate = !pageValid || (userExpiry && userExpiry.getTime() <= time.getTime() + RENEW_WITHIN_MS);
  if (!renewalAppropriate) return connection;
  if (!userExpiry || userExpiry.getTime() <= time.getTime()) {
    if (pageValid) return { ...connection, warning: META_RENEWAL_WARNING };
    await connections.markNeedsReconnect(owner, id);
    throw routeError(META_RECONNECT_ERROR, 409);
  }

  const leaseId = crypto.randomUUID();
  const acquired = await connections.acquireRenewalLease(owner, id, leaseId, new Date(time.getTime() + LEASE_MS), time);
  if (!acquired) {
    const winner = await connections.getById(owner, id);
    requireUsableMetaConnection(winner);
    if (pageValid) return { ...winner, warning: META_RENEWAL_WARNING };
    throw routeError(META_RENEWAL_IN_PROGRESS, 503);
  }

  let ownsLease = true;
  try {
    const config = requireConfig(env);
    const retainedAccessToken = String(connection.credentials?.longLivedUserAccessToken ?? "").trim();
    if (!retainedAccessToken) throw permanentConnectionFailureError();
    const retainedToken = { access_token: retainedAccessToken };
    const renewedUser = await exchangeLongLivedToken(fetchImpl, config, retainedToken, { lifecycle: true, requestTimeoutMs });
    const pages = await listPages(fetchImpl, renewedUser, { lifecycle: true, requestTimeoutMs });
    const page = pages.find((candidate) => candidate.id === String(connection.credentials?.pageId ?? ""));
    if (!page) throw metaError();
    const expiresAt = expiresAtFrom(renewedUser.expires_in, time);
    if (!expiresAt) throw metaError();
    const updated = await connections.completeRenewalLease(owner, id, leaseId, {
      ...connection.credentials,
      pageId: page.id, pageName: page.name, pageAccessToken: page.accessToken,
      longLivedUserAccessToken: renewedUser.access_token, userTokenExpiresAt: expiresAt.toISOString(), expiresAt: expiresAt.toISOString(),
    });
    if (updated) return updated;
    ownsLease = false;
    return observeMetaWinner({ connections, owner, id, original: connection, pollAttempts, pollDelay });
  } catch (error) {
    if (pageValid) return { ...connection, warning: META_RENEWAL_WARNING };
    if (error?.permanentConnectionFailure) throw error;
    if (error?.authorizationRejected) {
      await connections.markNeedsReconnect(owner, id);
      throw routeError(META_RECONNECT_ERROR, 409);
    }
    throw error?.retryable ? error : retryableLifecycleError(META_RENEWAL_IN_PROGRESS);
  } finally {
    if (ownsLease) {
      try { await connections.releaseRenewalLease(owner, id, leaseId); } catch { /* The bounded lease expires independently. */ }
    }
  }
}

async function observeMetaWinner({ connections, owner, id, original, pollAttempts, pollDelay }) {
  for (let attempt = 0; attempt < pollAttempts; attempt += 1) {
    const winner = await connections.getById(owner, id);
    requireUsableMetaConnection(winner);
    if (new Date(winner.updatedAt).getTime() > new Date(original.updatedAt).getTime()
      && winner.credentials?.pageAccessToken !== original.credentials?.pageAccessToken) return winner;
    if (attempt + 1 < pollAttempts) await pollDelay(10 * (attempt + 1));
  }
  throw retryableLifecycleError(META_RENEWAL_IN_PROGRESS);
}

async function validatePage(fetchImpl, credentials, requestTimeoutMs) {
  const pageId = String(credentials?.pageId ?? "").trim();
  const pageAccessToken = String(credentials?.pageAccessToken ?? "").trim();
  if (!pageId || !pageAccessToken) return "rejected";
  let response; let body;
  try {
    const url = new URL(`${GRAPH_API_URL}/${encodeURIComponent(pageId)}`);
    url.searchParams.set("fields", "id");
    ({ response, body } = await fetchWithDeadline(fetchImpl, url.toString(), { headers: { Authorization: `Bearer ${pageAccessToken}` } }, requestTimeoutMs,
      async (providerResponse, signal) => {
        let providerBody = {};
        try { providerBody = await providerResponse.json(); } catch (error) {
          if (signal.aborted || providerResponse?.ok) throw error;
        }
        return { response: providerResponse, body: providerBody };
      }));
  } catch {
    return "transient";
  }
  if (response?.ok) return String(body?.id ?? "") === pageId ? "valid" : "rejected";
  if (response?.status === 401 || Number(body?.error?.code) === 190) return "rejected";
  return "transient";
}

function requireUsableMetaConnection(connection) {
  if (!connection || connection.platform !== "meta" || !["active", "archived"].includes(connection.state)) {
    throw routeError("The Meta connection is not available.", 404);
  }
}

async function exchangeCode(fetchImpl, config, code) {
  const url = new URL(`${GRAPH_API_URL}/oauth/access_token`);
  url.searchParams.set("client_id", config.appId);
  url.searchParams.set("client_secret", config.appSecret);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("code", code);
  return requireToken(await readProviderJson(fetchImpl, url), "access_token");
}

async function exchangeLongLivedToken(fetchImpl, config, shortLivedToken, options) {
  const url = new URL(`${GRAPH_API_URL}/oauth/access_token`);
  url.searchParams.set("grant_type", "fb_exchange_token");
  url.searchParams.set("client_id", config.appId);
  url.searchParams.set("client_secret", config.appSecret);
  url.searchParams.set("fb_exchange_token", shortLivedToken.access_token);
  return requireToken(await readProviderJson(fetchImpl, url, {}, options), "access_token");
}

async function listPages(fetchImpl, longLivedToken, options) {
  const url = new URL(`${GRAPH_API_URL}/me/accounts`);
  url.searchParams.set("fields", "id,name,access_token");
  const body = await readProviderJson(fetchImpl, url, { headers: { Authorization: `Bearer ${longLivedToken.access_token}` } }, options);
  if (!Array.isArray(body?.data)) throw metaError();
  return body.data.map((page) => {
    const id = String(page?.id ?? "").trim();
    const name = String(page?.name ?? "").trim();
    const accessToken = String(page?.access_token ?? "").trim();
    if (!id || !name || !accessToken) throw metaError();
    return { id, name, accessToken };
  });
}

async function readProviderJson(fetchImpl, url, requestOptions = {}, { lifecycle = false, requestTimeoutMs = 10_000 } = {}) {
  let response; let body;
  try {
    ({ response, body } = await fetchWithDeadline(fetchImpl, url.toString(), requestOptions, requestTimeoutMs,
      async (providerResponse, signal) => {
        let providerBody = {};
        try { providerBody = await providerResponse.json(); } catch (error) {
          if (signal.aborted || providerResponse?.ok) throw error;
        }
        return { response: providerResponse, body: providerBody };
      }));
  } catch (error) {
    if (lifecycle) throw error;
    throw metaError();
  }
  if (!response?.ok) {
    if (lifecycle && (response.status === 400 || response.status === 401 || Number(body?.error?.code) === 190)) {
      throw authorizationLifecycleError(META_RECONNECT_ERROR);
    }
    if (lifecycle) throw retryableLifecycleError();
    throw metaError();
  }
  return body;
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
