import { filterActivePlatforms } from "./platform-config.js";
import { fetchWithDeadline } from "../platform-connections/connection-lifecycle.js";

const RECONNECT_ERROR = "The selected platform connection needs to be reconnected.";

export async function publishTargets({ targets, connections, fetchImpl = fetch, requestTimeoutMs = 10_000 }) {
  const activePlatforms = new Set(filterActivePlatforms(targets.map((target) => target.platform)));
  const activeTargets = targets.filter((target) => activePlatforms.has(target.platform));
  const results = [];

  for (const target of activeTargets) {
    const connection = (Array.isArray(connections) ? connections : []).find((candidate) => (
      candidate?.id === target.platformConnectionId && candidate?.platform === target.platform
    ));
    try {
      if (!connection) throw new Error(RECONNECT_ERROR);
      if (target.platform === "meta") {
        results.push(await publishMeta(target, connection.credentials, fetchImpl, requestTimeoutMs));
      }
      if (target.platform === "line") {
        results.push(await publishLine(target, connection.credentials, fetchImpl, requestTimeoutMs));
      }
    } catch (error) {
      if (error?.providerRejected) {
        try { await connection?.markNeedsReconnect?.(); } catch { /* Preserve the provider outcome if lifecycle persistence is unavailable. */ }
      }
      const reconnectRequired = error?.providerRejected || error?.message === RECONNECT_ERROR;
      results.push({
        platform: target.platform,
        status: "failed",
        error: reconnectRequired ? RECONNECT_ERROR : `${target.platform} publishing failed.`,
        ...(error?.retryable ? { retryable: true } : {}),
      });
    }
  }

  return results;
}

async function publishMeta(target, credentials, fetchImpl, requestTimeoutMs) {
  const pageId = requireCredential(credentials?.pageId);
  const pageAccessToken = requireCredential(credentials?.pageAccessToken);

  const hasImage = Boolean(target.publishPayload.imageUrl);
  const url = hasImage
    ? `https://graph.facebook.com/v25.0/${pageId}/photos`
    : `https://graph.facebook.com/v25.0/${pageId}/feed`;
  const payload = hasImage
    ? {
        caption: target.publishPayload.message,
        url: target.publishPayload.imageUrl,
        access_token: pageAccessToken,
      }
    : {
        message: target.publishPayload.message,
        access_token: pageAccessToken,
      };

  const { response, body } = await providerResponse(fetchImpl, url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }, requestTimeoutMs);

  return readPlatformResponse("meta", response, body);
}

async function publishLine(target, credentials, fetchImpl, requestTimeoutMs) {
  const accessToken = requireCredential(credentials?.accessToken);

  const { response, body } = await providerResponse(fetchImpl, "https://api.line.me/v2/bot/message/broadcast", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      messages: buildLineMessages(target.publishPayload),
    }),
  }, requestTimeoutMs);

  return readPlatformResponse("line", response, body);
}

function buildLineMessages(publishPayload) {
  const messages = [{ type: "text", text: publishPayload.text }];

  if (publishPayload.imageUrl) {
    messages.push({
      type: "image",
      originalContentUrl: publishPayload.imageUrl,
      previewImageUrl: publishPayload.imageUrl,
    });
  }

  return messages;
}

function readPlatformResponse(platform, response, body) {
  if (!response.ok) {
    const error = new Error(`${platform} publish failed.`);
    error.providerRejected = response.status === 401
      || (platform === "meta" && Number(body?.error?.code) === 190);
    error.retryable = !error.providerRejected && (response.status === 403 || response.status === 429 || response.status >= 500);
    throw error;
  }

  return {
    platform,
    status: "published",
    externalId: body.id ?? null,
  };
}

function requireCredential(value) {
  const credential = String(value ?? "").trim();
  if (!credential) throw new Error(RECONNECT_ERROR);
  return credential;
}

async function providerResponse(fetchImpl, url, options, requestTimeoutMs) {
  return fetchWithDeadline(fetchImpl, url, options, requestTimeoutMs, async (response, signal) => {
    let body = {};
    try { body = await response.json(); } catch (error) {
      if (signal.aborted || response?.ok) throw error;
    }
    return { response, body };
  });
}
