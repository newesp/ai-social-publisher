import assert from "node:assert/strict";
import { test } from "node:test";

import { publishTargets } from "../src/lib/platforms/publish-service.js";

test("publishes only active Meta and LINE targets", async () => {
  const calls = [];
  const result = await publishTargets({
    targets: [
      { platform: "meta", publishPayload: { message: "Meta text" } },
      { platform: "instagram", publishPayload: { caption: "IG text" } },
      { platform: "line", publishPayload: { text: "LINE text" } },
    ],
    settings: {
      metaPageId: "page-id",
      metaPageAccessToken: "meta-token",
      lineChannelAccessToken: "line-token",
    },
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
        publishPayload: {
          text: "LINE AI text",
          imageUrl: "https://blob.vercel-storage.com/generated.jpg",
        },
      },
    ],
    settings: { lineChannelAccessToken: "line-token" },
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
        publishPayload: {
          message: "Meta AI text",
          imageUrl: "https://blob.vercel-storage.com/generated.jpg",
        },
      },
    ],
    settings: {
      metaPageId: "page-id",
      metaPageAccessToken: "meta-token",
    },
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
    targets: [{ platform: "line", publishPayload: { text: "LINE text" } }],
    settings: {},
    fetchImpl: async () => {
      throw new Error("fetch should not be called");
    },
  });

  assert.deepEqual(result, [
    {
      platform: "line",
      status: "failed",
      error: "LINE_CHANNEL_ACCESS_TOKEN is required.",
    },
  ]);
});
