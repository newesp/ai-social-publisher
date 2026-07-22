import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";

import { createLineSupportAdapter } from "../src/lib/support/channel-adapters/line-support-adapter.js";

test("verifies the LINE signature against the untouched UTF-8 body", () => {
  const adapter = createLineSupportAdapter({ fetchImpl: async () => new Response("{}") });
  const channelSecret = "channel-secret";
  const rawBody = '{"message":"你好","spacing":"kept  exactly"}';
  const signature = crypto.createHmac("sha256", channelSecret).update(rawBody, "utf8").digest("base64");

  assert.equal(adapter.verifySignature({ channelSecret, rawBody, signature }), true);
  assert.equal(adapter.verifySignature({
    channelSecret,
    rawBody: '{"message":"你好","spacing":"kept exactly"}',
    signature,
  }), false);
  assert.equal(adapter.verifySignature({ channelSecret, rawBody, signature: "not-base64" }), false);
  assert.equal(adapter.verifySignature({ channelSecret, rawBody, signature: `${signature}$junk` }), false);
});

test("configures, tests, and reads webhook status with documented LINE request shapes", async () => {
  const calls = [];
  const adapter = createLineSupportAdapter({
    fetchImpl: async (url, options = {}) => {
      calls.push({
        method: options.method ?? "GET",
        path: new URL(url).pathname,
        authorization: options.headers?.Authorization,
        contentType: options.headers?.["Content-Type"],
        body: options.body ? JSON.parse(options.body) : null,
      });
      const path = new URL(url).pathname;
      if (path.endsWith("/test")) {
        return jsonResponse({
          success: true,
          timestamp: "2026-07-19T00:00:00.000Z",
          statusCode: 200,
          reason: "OK",
          detail: "200",
        });
      }
      if ((options.method ?? "GET") === "GET") {
        return jsonResponse({
          endpoint: "https://app.example/api/webhooks/line/opaque-key",
          active: true,
        });
      }
      return jsonResponse({});
    },
  });

  await adapter.configureWebhook({
    accessToken: "line-access-token",
    webhookUrl: "https://app.example/api/webhooks/line/opaque-key",
  });
  const testResult = await adapter.testWebhook({ accessToken: "line-access-token" });
  const status = await adapter.getWebhookStatus({ accessToken: "line-access-token" });

  assert.deepEqual(calls, [
    {
      method: "PUT",
      path: "/v2/bot/channel/webhook/endpoint",
      authorization: "Bearer line-access-token",
      contentType: "application/json",
      body: { endpoint: "https://app.example/api/webhooks/line/opaque-key" },
    },
    {
      method: "POST",
      path: "/v2/bot/channel/webhook/test",
      authorization: "Bearer line-access-token",
      contentType: "application/json",
      body: {},
    },
    {
      method: "GET",
      path: "/v2/bot/channel/webhook/endpoint",
      authorization: "Bearer line-access-token",
      contentType: "application/json",
      body: null,
    },
  ]);
  assert.deepEqual(testResult, { success: true, statusCode: 200 });
  assert.deepEqual(status, {
    endpoint: "https://app.example/api/webhooks/line/opaque-key",
    active: true,
  });
});

test("gets a LINE user's display name without exposing the provider response", async () => {
  const adapter = createLineSupportAdapter({
    fetchImpl: async () => jsonResponse({ displayName: "Leo Lin", userId: "U-private" }),
  });

  assert.deepEqual(await adapter.getUserProfile({ accessToken: "line-access-token", userId: "U-private" }), {
    displayName: "Leo Lin",
  });
});

test("sends reply and push text with bounded inputs and retry-key support", async () => {
  const calls = [];
  const adapter = createLineSupportAdapter({
    fetchImpl: async (url, options = {}) => {
      calls.push({
        path: new URL(url).pathname,
        method: options.method,
        authorization: options.headers?.Authorization,
        retryKey: options.headers?.["X-Line-Retry-Key"] ?? null,
        body: JSON.parse(options.body),
      });
      return jsonResponse({ sentMessages: [{ id: "provider-message-id", quoteToken: "quote-token" }] });
    },
  });

  assert.deepEqual(await adapter.replyText({
    accessToken: "line-access-token",
    replyToken: "reply-token",
    text: "您好",
  }), { delivered: true });
  assert.deepEqual(await adapter.pushText({
    accessToken: "line-access-token",
    to: "customer-id",
    text: "後續訊息",
    retryKey: "11111111-1111-4111-8111-111111111111",
  }), { delivered: true });

  assert.deepEqual(calls, [
    {
      path: "/v2/bot/message/reply",
      method: "POST",
      authorization: "Bearer line-access-token",
      retryKey: null,
      body: {
        replyToken: "reply-token",
        messages: [{ type: "text", text: "您好" }],
      },
    },
    {
      path: "/v2/bot/message/push",
      method: "POST",
      authorization: "Bearer line-access-token",
      retryKey: "11111111-1111-4111-8111-111111111111",
      body: {
        to: "customer-id",
        messages: [{ type: "text", text: "後續訊息" }],
      },
    },
  ]);
});

test("sends a stored canonical Push payload byte-for-byte and preserves LINE acceptance headers", async () => {
  const canonicalBody = "{\"to\":\"customer-id\",\"messages\":[{\"type\":\"text\",\"text\":\"kept  exactly\"}]}";
  const calls = [];
  const adapter = createLineSupportAdapter({
    fetchImpl: async (_url, options) => {
      calls.push(options);
      return new Response("", {
        status: 409,
        headers: { "x-line-accepted-request-id": "accepted-request-id" },
      });
    },
  });

  const result = await adapter.pushCanonical({
    accessToken: "line-access-token",
    canonicalBody,
    retryKey: "11111111-1111-4111-8111-111111111111",
  });

  assert.equal(calls[0].body, canonicalBody);
  assert.equal(calls[0].headers["X-Line-Retry-Key"], "11111111-1111-4111-8111-111111111111");
  assert.deepEqual(result, {
    status: 409,
    headers: { "x-line-accepted-request-id": "accepted-request-id" },
  });
});

test("provider errors and deadlines expose only a fixed retryable adapter error", async () => {
  const providerBody = "private provider body with line-access-token";
  const failing = createLineSupportAdapter({
    fetchImpl: async () => jsonResponse({ message: providerBody }, { status: 500 }),
  });

  await assert.rejects(
    failing.configureWebhook({
      accessToken: "line-access-token",
      webhookUrl: "https://app.example/api/webhooks/line/opaque-key",
    }),
    (error) => {
      assert.equal(error.status, 502);
      assert.equal(error.retryable, true);
      assert.equal(error.message, "LINE support request failed.");
      assert.equal(JSON.stringify(error).includes("line-access-token"), false);
      assert.equal(JSON.stringify(error).includes(providerBody), false);
      return true;
    },
  );

  const stalled = createLineSupportAdapter({
    requestTimeoutMs: 5,
    fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("private stalled transport body")), { once: true });
    }),
  });

  await assert.rejects(
    stalled.getWebhookStatus({ accessToken: "line-access-token" }),
    (error) => error.status === 502
      && error.retryable === true
      && error.message === "LINE support request failed."
      && !JSON.stringify(error).includes("private stalled transport body"),
  );
});

function jsonResponse(body, { status = 200 } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
