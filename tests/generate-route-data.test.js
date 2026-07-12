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
      llmModel: "gemini-3.1-flash-image",
      imageProvider: "google",
      imageModel: "gemini-3.5-flash",
    },
    settings: { googleAiApiKey: "google-key" },
    generateTargets: async ({ llmModel }) => {
      assert.equal(llmModel, "gemini-3.1-flash-image");
      return [
      { platform: "meta", content: "Meta generated", hashtags: [] },
      { platform: "line", content: "LINE generated", hashtags: [] },
      ];
    },
    generateImage: async ({ imageModel }) => {
      assert.equal(imageModel, "gemini-3.5-flash");
      return "data:image/png;base64,abc123";
    },
    uploadImage: async ({ imageUrl }) => {
      assert.equal(imageUrl, "data:image/png;base64,abc123");
      return "https://blob.vercel-storage.com/generated.png";
    },
  });

  assert.equal(response.imageUrl, "https://blob.vercel-storage.com/generated.png");
  assert.equal(response.imageError, null);
  assert.equal(response.llmModel, "gemini-3.1-flash-image");
  assert.equal(response.imageModel, "gemini-3.5-flash");
  assert.equal(response.targets[0].content, "Meta generated");
  assert.equal(response.previews.meta.preview.message, "Meta generated");
  assert.equal(response.previews.meta.preview.imageUrl, response.imageUrl);
});
