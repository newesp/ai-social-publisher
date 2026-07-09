import assert from "node:assert/strict";
import { test } from "node:test";

import { buildGeneratedResponse } from "../src/lib/ai/generated-response.js";

test("keeps generated text when image generation fails", async () => {
  const response = await buildGeneratedResponse({
    body: {
      productName: "Alpha CRM",
      productFeatures: "Saves team time",
      platforms: ["meta"],
      llmProvider: "google",
      imageProvider: "google",
    },
    settings: { googleAiApiKey: "google-key" },
    generateTargets: async () => [{ platform: "meta", content: "Meta generated", hashtags: [] }],
    generateImage: async () => {
      throw new Error("Gemini image quota exceeded.");
    },
  });

  assert.equal(response.imageUrl, null);
  assert.equal(response.imageError, "Gemini image quota exceeded.");
  assert.equal(response.targets[0].content, "Meta generated");
});
