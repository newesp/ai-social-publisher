import crypto from "node:crypto";

import { fetchWithDeadline } from "../../platform-connections/connection-lifecycle.js";

const LINE_API_BASE = "https://api.line.me";
const PROVIDER_ERROR_MESSAGE = "LINE support request failed.";
const MAX_WEBHOOK_URL_LENGTH = 500;
const MAX_TEXT_LENGTH = 5_000;

export function createLineSupportAdapter({
  fetchImpl = fetch,
  requestTimeoutMs = 10_000,
} = {}) {
  return {
    verifySignature({ channelSecret, rawBody, signature }) {
      const secret = cryptographicText(channelSecret);
      const body = rawBodyBytes(rawBody);
      const supplied = decodeSignature(signature);
      if (!secret || !body || !supplied) return false;

      const expected = crypto.createHmac("sha256", secret).update(body).digest();
      return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
    },

    async configureWebhook({ accessToken, webhookUrl }) {
      await providerRequest(fetchImpl, requestTimeoutMs, "/v2/bot/channel/webhook/endpoint", {
        method: "PUT",
        headers: providerHeaders(accessToken),
        body: JSON.stringify({ endpoint: requireWebhookUrl(webhookUrl) }),
      });
      return { configured: true };
    },

    async testWebhook({ accessToken, webhookUrl } = {}) {
      const body = webhookUrl == null ? {} : { endpoint: requireWebhookUrl(webhookUrl) };
      const result = await providerRequest(fetchImpl, requestTimeoutMs, "/v2/bot/channel/webhook/test", {
        method: "POST",
        headers: providerHeaders(accessToken),
        body: JSON.stringify(body),
      }, { parseJson: true });
      return {
        success: result?.success === true,
        statusCode: Number.isFinite(result?.statusCode) ? result.statusCode : null,
      };
    },

    async getWebhookStatus({ accessToken }) {
      const result = await providerRequest(fetchImpl, requestTimeoutMs, "/v2/bot/channel/webhook/endpoint", {
        method: "GET",
        headers: providerHeaders(accessToken),
      }, { parseJson: true });
      return {
        endpoint: typeof result?.endpoint === "string" ? result.endpoint : "",
        active: result?.active === true,
      };
    },

    async replyText({ accessToken, replyToken, text }) {
      await providerRequest(fetchImpl, requestTimeoutMs, "/v2/bot/message/reply", {
        method: "POST",
        headers: providerHeaders(accessToken),
        body: JSON.stringify({
          replyToken: requireText(replyToken, "LINE reply token"),
          messages: [textMessage(text)],
        }),
      });
      return { delivered: true };
    },

    async pushText({ accessToken, to, text, retryKey }) {
      const headers = providerHeaders(accessToken);
      if (retryKey != null) headers["X-Line-Retry-Key"] = requireText(retryKey, "LINE retry key");
      await providerRequest(fetchImpl, requestTimeoutMs, "/v2/bot/message/push", {
        method: "POST",
        headers,
        body: JSON.stringify({
          to: requireText(to, "LINE recipient"),
          messages: [textMessage(text)],
        }),
      });
      return { delivered: true };
    },
  };
}

async function providerRequest(fetchImpl, timeoutMs, path, options, { parseJson = false } = {}) {
  try {
    const result = await fetchWithDeadline(
      fetchImpl,
      `${LINE_API_BASE}${path}`,
      options,
      timeoutMs,
      async (response, signal) => {
        let body = null;
        try {
          if (parseJson && response?.ok) body = await response.json();
          else if (typeof response?.arrayBuffer === "function") await response.arrayBuffer();
          else if (typeof response?.text === "function") await response.text();
        } catch (error) {
          if (signal.aborted || response?.ok) throw error;
        }
        return { ok: response?.ok === true, body };
      },
    );
    if (!result.ok) throw providerError();
    return result.body;
  } catch {
    throw providerError();
  }
}

function providerHeaders(accessToken) {
  return {
    Authorization: `Bearer ${requireText(accessToken, "LINE access token")}`,
    "Content-Type": "application/json",
  };
}

function textMessage(value) {
  const text = requireText(value, "LINE message");
  if (text.length > MAX_TEXT_LENGTH) throw inputError("LINE message is too long.");
  return { type: "text", text };
}

function requireWebhookUrl(value) {
  let url;
  try {
    url = new URL(requireText(value, "LINE webhook URL"));
  } catch {
    throw inputError("LINE webhook URL must use HTTPS.");
  }
  if (url.protocol !== "https:" || url.toString().length > MAX_WEBHOOK_URL_LENGTH) {
    throw inputError("LINE webhook URL must use HTTPS.");
  }
  return url.toString();
}

function requireText(value, label) {
  if (typeof value !== "string") throw inputError(`${label} is required.`);
  const text = value.trim();
  if (!text) throw inputError(`${label} is required.`);
  return text;
}

function cryptographicText(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function rawBodyBytes(value) {
  if (typeof value === "string") return Buffer.from(value, "utf8");
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.from(value);
  return null;
}

function decodeSignature(value) {
  if (typeof value !== "string") return null;
  const signature = value.trim();
  if (!/^[A-Za-z0-9+/]{43}=$/.test(signature)) return null;
  try {
    const decoded = Buffer.from(signature, "base64");
    return decoded.length === 32 && decoded.toString("base64") === signature ? decoded : null;
  } catch {
    return null;
  }
}

function inputError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function providerError() {
  const error = new Error(PROVIDER_ERROR_MESSAGE);
  error.status = 502;
  error.retryable = true;
  return error;
}
