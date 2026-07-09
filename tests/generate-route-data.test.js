import assert from "node:assert/strict";
import { test } from "node:test";

import { buildGeneratedResponse } from "../src/lib/ai/generated-response.js";

test("builds generated response with editable targets and uploaded image URL", async () => {
  const response = await buildGeneratedResponse({
    body: {
      productName: "Alpha CRM",
      productFeatures: "Saves team time",
      platforms: ["meta", "line"],
      llmProvider: "google",
      imageProvider: "google",
    },
    settings: { googleAiApiKey: "google-key" },
    generateTargets: async () => [
      { platform: "meta", content: "Meta generated", hashtags: [] },
      { platform: "line", content: "LINE generated", hashtags: [] },
    ],
    generateImage: async () => "data:image/png;base64,abc123",
    uploadImage: async ({ imageUrl }) => {
      assert.equal(imageUrl, "data:image/png;base64,abc123");
      return "https://blob.vercel-storage.com/generated.png";
    },
  });

  assert.equal(response.imageUrl, "https://blob.vercel-storage.com/generated.png");
  assert.equal(response.imageError, null);
  assert.equal(response.targets[0].content, "Meta generated");
  assert.equal(response.previews.meta.preview.message, "Meta generated");
  assert.equal(response.previews.meta.preview.imageUrl, response.imageUrl);
});
