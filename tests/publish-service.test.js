import assert from "node:assert/strict";
import { test } from "node:test";

import { publishTargets } from "../src/lib/platforms/publish-service.js";

test("publishes only active Meta and LINE targets", async () => {
  const calls = [];
  const result = await publishTargets({
    targets: [
      { platform: "meta", platformConnectionId: "meta-1", publishPayload: { message: "Meta text" } },
      { platform: "instagram", publishPayload: { caption: "IG text" } },
      { platform: "line", platformConnectionId: "line-1", publishPayload: { text: "LINE text" } },
    ],
    connections: [
      { id: "meta-1", platform: "meta", credentials: { pageId: "page-id", pageAccessToken: "meta-token" } },
      { id: "line-1", platform: "line", credentials: { accessToken: "line-token" } },
    ],
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        json: async () => ({ id: "external-id" }),
        text: async () => "",
      };
    },
  });

  assert.deepEqual(
    result.map((item) => item.platform),
    ["meta", "line"],
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://graph.facebook.com/v25.0/page-id/feed");
  assert.equal(calls[1].url, "https://api.line.me/v2/bot/message/broadcast");
});

test("publishes LINE text and image in one broadcast call", async () => {
  const calls = [];
  const result = await publishTargets({
    targets: [
      {
        platform: "line",
        platformConnectionId: "line-1",
        publishPayload: {
          text: "LINE AI text",
          imageUrl: "https://blob.vercel-storage.com/generated.jpg",
        },
      },
    ],
    connections: [{ id: "line-1", platform: "line", credentials: { accessToken: "line-token" } }],
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        json: async () => ({}),
        text: async () => "",
      };
    },
  });

  assert.deepEqual(result, [{ platform: "line", status: "published", externalId: null }]);
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    messages: [
      { type: "text", text: "LINE AI text" },
      {
        type: "image",
        originalContentUrl: "https://blob.vercel-storage.com/generated.jpg",
        previewImageUrl: "https://blob.vercel-storage.com/generated.jpg",
      },
    ],
  });
});

test("publishes Meta image posts through the Page Photos API", async () => {
  const calls = [];
  await publishTargets({
    targets: [
      {
        platform: "meta",
        platformConnectionId: "meta-1",
        publishPayload: {
          message: "Meta AI text",
          imageUrl: "https://blob.vercel-storage.com/generated.jpg",
        },
      },
    ],
    connections: [{ id: "meta-1", platform: "meta", credentials: { pageId: "page-id", pageAccessToken: "meta-token" } }],
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        json: async () => ({ id: "photo-id" }),
        text: async () => "",
      };
    },
  });

  assert.equal(calls[0].url, "https://graph.facebook.com/v25.0/page-id/photos");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    caption: "Meta AI text",
    url: "https://blob.vercel-storage.com/generated.jpg",
    access_token: "meta-token",
  });
});

test("returns failed platform status when required credentials are missing", async () => {
  const result = await publishTargets({
    targets: [{ platform: "line", platformConnectionId: "line-1", publishPayload: { text: "LINE text" } }],
    connections: [{ id: "line-1", platform: "line", credentials: {} }],
    fetchImpl: async () => {
      throw new Error("fetch should not be called");
    },
  });

  assert.deepEqual(result, [
    {
      platform: "line",
      status: "failed",
      error: "The selected platform connection needs to be reconnected.",
    },
  ]);
});

test("uses the credential set paired with each immutable target", async () => {
  const calls = [];
  await publishTargets({
    targets: [
      { platform: "meta", platformConnectionId: "meta-b", publishPayload: { message: "Meta B" } },
      { platform: "line", platformConnectionId: "line-a", publishPayload: { text: "LINE A" } },
    ],
    connections: [
      { id: "line-a", platform: "line", credentials: { accessToken: "line-token-a" } },
      { id: "meta-b", platform: "meta", credentials: { pageId: "page-b", pageAccessToken: "meta-token-b" } },
    ],
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, json: async () => ({ id: "external" }), text: async () => "" };
    },
  });

  assert.equal(calls[0].url, "https://graph.facebook.com/v25.0/page-b/feed");
  assert.equal(JSON.parse(calls[0].options.body).access_token, "meta-token-b");
  assert.equal(calls[1].options.headers.Authorization, "Bearer line-token-a");
});

test("marks only the rejected LINE connection as needing reconnect", async () => {
  const marked = [];
  const results = await publishTargets({
    targets: [{ platform: "line", platformConnectionId: "line-a", publishPayload: { text: "LINE A" } }],
    connections: [{
      id: "line-a", platform: "line", credentials: { accessToken: "rejected-token" },
      markNeedsReconnect: async () => { marked.push("line-a"); },
    }],
    fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ message: "token rejected: rejected-token" }) }),
  });

  assert.deepEqual(marked, ["line-a"]);
  assert.deepEqual(results, [{ platform: "line", status: "failed", error: "The selected platform connection needs to be reconnected." }]);
});

test("does not mark a connection for reconnect on transient provider failures", async () => {
  const marked = [];
  const results = await publishTargets({
    targets: [{ platform: "line", platformConnectionId: "line-a", publishPayload: { text: "LINE A" } }],
    connections: [{
      id: "line-a", platform: "line", credentials: { accessToken: "line-token" },
      markNeedsReconnect: async () => { marked.push("line-a"); },
    }],
    fetchImpl: async () => new Response("temporarily unavailable", { status: 503 }),
  });

  assert.deepEqual(marked, []);
  assert.deepEqual(results, [{ platform: "line", status: "failed", error: "line publishing failed.", retryable: true }]);
});

test("treats a provider network failure as retryable without exposing the transport error", async () => {
  const results = await publishTargets({
    targets: [{ platform: "line", platformConnectionId: "line-a", publishPayload: { text: "LINE A" } }],
    connections: [{ id: "line-a", platform: "line", credentials: { accessToken: "line-token" } }],
    fetchImpl: async () => { throw new Error("socket failed for secret endpoint"); },
  });

  assert.deepEqual(results, [{ platform: "line", status: "failed", error: "line publishing failed.", retryable: true }]);
});

test("does not mark Meta or LINE reconnect for ambiguous 403 policy responses", async () => {
  for (const platform of ["meta", "line"]) {
    const marked = [];
    const connection = platform === "meta"
      ? { id: "meta-a", platform, credentials: { pageId: "page", pageAccessToken: "token" }, markNeedsReconnect: async () => marked.push(platform) }
      : { id: "line-a", platform, credentials: { accessToken: "token" }, markNeedsReconnect: async () => marked.push(platform) };
    await publishTargets({
      targets: [{ platform, platformConnectionId: connection.id, publishPayload: platform === "meta" ? { message: "m" } : { text: "m" } }],
      connections: [connection], fetchImpl: async () => new Response(JSON.stringify({ error: { code: 10 } }), {
        status: 403, headers: { "content-type": "application/json" },
      }),
    });
    assert.deepEqual(marked, []);
  }
});

test("marks a text-body 401 credential rejection without exposing its body", async () => {
  const marked = [];
  const results = await publishTargets({
    targets: [{ platform: "line", platformConnectionId: "line-a", publishPayload: { text: "LINE A" } }],
    connections: [{
      id: "line-a", platform: "line", credentials: { accessToken: "line-token" },
      markNeedsReconnect: async () => { marked.push("line-a"); },
    }],
    fetchImpl: async () => new Response("private provider rejection", { status: 401 }),
  });

  assert.deepEqual(marked, ["line-a"]);
  assert.equal(JSON.stringify(results).includes("private provider rejection"), false);
  assert.deepEqual(results, [{ platform: "line", status: "failed", error: "The selected platform connection needs to be reconnected." }]);
});

test("records the provider outcome even when reconnect state persistence fails", async () => {
  const results = await publishTargets({
    targets: [{ platform: "line", platformConnectionId: "line-a", publishPayload: { text: "LINE A" } }],
    connections: [{
      id: "line-a", platform: "line", credentials: { accessToken: "line-token" },
      markNeedsReconnect: async () => { throw new Error("database unavailable"); },
    }],
    fetchImpl: async () => new Response("unauthorized", { status: 401 }),
  });

  assert.deepEqual(results, [{ platform: "line", status: "failed", error: "The selected platform connection needs to be reconnected." }]);
});
