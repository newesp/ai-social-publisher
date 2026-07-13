import crypto from "node:crypto";

const TOKEN_URL = "https://api.line.me/v2/oauth/accessToken";
const BOT_INFO_URL = "https://api.line.me/v2/bot/info";
const ROTATE_WITHIN_MS = 72 * 60 * 60 * 1000;
const CONNECTION_ERROR = "LINE connection could not be completed.";
const RECONNECT_ERROR = "LINE connection needs to be reconnected.";
const RENEWAL_WARNING = "LINE token renewal failed; the current token is still being used.";
const RENEWAL_IN_PROGRESS_WARNING = "LINE token renewal is in progress; the current token is still being used.";
const RENEWAL_IN_PROGRESS_ERROR = "LINE token renewal is in progress. Please retry shortly.";
const LEASE_MS = 2 * 60 * 1000;
const sharedRenewals = new Map();

export function createLineChannelService({ fetchImpl = fetch, connections, now = () => new Date(), renewalFlights = sharedRenewals }) {
  return {
    async connect(ownerEmail, input) {
      const owner = normalizeOwner(ownerEmail);
      const { channelId, channelSecret } = requireChannelCredentials(input);
      const issued = await issueAndVerify(fetchImpl, { channelId, channelSecret }, currentTime(now));
      const connection = await connections.replaceDefault(owner, {
        platform: "line",
        displayName: issued.officialAccountName,
        credentials: issued.credentials,
        expiresAt: issued.expiresAt,
      });
      return toAvailability(connection);
    },

    async ensureUsable(ownerEmail, connectionId) {
      const owner = normalizeOwner(ownerEmail);
      const id = requireConnectionId(connectionId);
      const key = `${owner}:${id}`;
      if (renewalFlights.has(key)) return renewalFlights.get(key);
      const operation = ensureUsableWithLease({ owner, id, connections, fetchImpl, now });
      renewalFlights.set(key, operation);
      try { return await operation; } finally { renewalFlights.delete(key); }
    },
  };
}

async function ensureUsableWithLease({ owner, id, connections, fetchImpl, now }) {
  const connection = await connections.getById(owner, id);
  requireUsableLineConnection(connection);
  const time = currentTime(now);
  if (hasMoreThanRotationWindow(connection.expiresAt, time)) return connection;

  const leaseId = crypto.randomUUID();
  const acquired = await connections.acquireRenewalLease(owner, connection.id, leaseId, new Date(time.getTime() + LEASE_MS), time);
  if (!acquired) {
    const current = await connections.getById(owner, connection.id);
    requireUsableLineConnection(current);
    if (isValidAt(current.expiresAt, time)) return { ...current, warning: RENEWAL_IN_PROGRESS_WARNING };
    throw routeError(RENEWAL_IN_PROGRESS_ERROR, 503);
  }

  try {
    const issued = await issueAndVerify(fetchImpl, requireStoredCredentials(connection.credentials), time);
    const updated = await connections.completeRenewalLease(owner, connection.id, leaseId, issued.credentials);
    if (updated) return updated;

    const winner = await connections.getById(owner, connection.id);
    requireUsableLineConnection(winner);
    if (isValidAt(winner.expiresAt, time)) return winner;
  } catch {
    try { await connections.releaseRenewalLease(owner, connection.id, leaseId); } catch { /* The short lease expires independently. */ }
    if (isValidAt(connection.expiresAt, time)) return { ...connection, warning: RENEWAL_WARNING };
  }

  await connections.markNeedsReconnect(owner, connection.id);
  throw routeError(RECONNECT_ERROR, 409);
}

async function issueAndVerify(fetchImpl, { channelId, channelSecret }, now) {
  const body = new URLSearchParams({ grant_type: "client_credentials", client_id: channelId, client_secret: channelSecret });
  const issued = await providerJson(fetchImpl, TOKEN_URL, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body,
  });
  const accessToken = String(issued?.access_token ?? "").trim();
  const expiresIn = Number(issued?.expires_in);
  if (!accessToken || !Number.isFinite(expiresIn) || expiresIn <= 0) throw lineError();
  const profile = await providerJson(fetchImpl, BOT_INFO_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
  const officialAccountName = typeof profile?.displayName === "string" ? profile.displayName.trim() : "";
  const botUserId = typeof profile?.userId === "string" ? profile.userId.trim() : "";
  if (!officialAccountName || !botUserId) throw lineError();
  const expiresAt = new Date(now.getTime() + expiresIn * 1000);
  return {
    officialAccountName,
    expiresAt,
    credentials: {
      channelId, channelSecret, accessToken, expiresAt: expiresAt.toISOString(), officialAccountName,
      botUserId,
    },
  };
}

async function providerJson(fetchImpl, url, options) {
  let response;
  try { response = await fetchImpl(url, options); } catch { throw lineError(); }
  if (!response?.ok) throw lineError();
  try { return await response.json(); } catch { throw lineError(); }
}

function requireChannelCredentials(input) {
  const channelId = typeof input?.channelId === "string" ? input.channelId.trim() : "";
  const channelSecret = typeof input?.channelSecret === "string" ? input.channelSecret.trim() : "";
  if (!channelId || !channelSecret || isMasked(channelId) || isMasked(channelSecret)) throw routeError("A LINE Channel ID and Channel Secret are required.", 400);
  return { channelId, channelSecret };
}
function requireStoredCredentials(credentials) {
  const channelId = String(credentials?.channelId ?? "").trim();
  const channelSecret = String(credentials?.channelSecret ?? "").trim();
  if (!channelId || !channelSecret) throw lineError();
  return { channelId, channelSecret };
}
function requireUsableLineConnection(connection) {
  if (!connection || connection.platform !== "line" || !["active", "archived"].includes(connection.state)) throw routeError("The LINE connection is not available.", 404);
  return connection;
}
function normalizeOwner(value) { const owner = String(value ?? "").trim().toLowerCase(); if (!owner) throw routeError("The LINE connection is not available.", 404); return owner; }
function requireConnectionId(value) { const id = String(value ?? "").trim(); if (!id) throw routeError("The LINE connection is not available.", 404); return id; }
function currentTime(now) { const value = typeof now === "function" ? now() : now; const date = value instanceof Date ? value : new Date(value); if (Number.isNaN(date.getTime())) throw lineError(); return date; }
function hasMoreThanRotationWindow(expiresAt, now) { return toDate(expiresAt)?.getTime() > now.getTime() + ROTATE_WITHIN_MS; }
function isValidAt(expiresAt, now) { return toDate(expiresAt)?.getTime() > now.getTime(); }
function toDate(value) { if (value == null) return null; const date = value instanceof Date ? value : new Date(value); return Number.isNaN(date.getTime()) ? null : date; }
function isMasked(value) { return /^\*+$/.test(value); }
function toAvailability(connection) { return { platform: connection.platform, state: connection.state, displayName: connection.displayName, expiresAt: connection.expiresAt ?? null }; }
function lineError() { return routeError(CONNECTION_ERROR, 502); }
function routeError(message, status) { const error = new Error(message); error.status = status; return error; }
