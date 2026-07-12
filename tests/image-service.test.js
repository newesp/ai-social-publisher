import assert from "node:assert/strict";
import { test } from "node:test";

import { generateGeminiImage } from "../src/lib/ai/image-service.js";

test("generates Gemini images with the interactions endpoint payload", async () => {
  const calls = [];
  const result = await generateGeminiImage({
    prompt: "Create a picture of a nano banana dish",
    settings: { googleAiApiKey: "google-key" },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        json: async () => ({ output: [{ type: "image", image: "base64-image" }] }),
        text: async () => "",
      };
    },
  });

  assert.equal(result, "data:image/png;base64,base64-image");
  assert.equal(calls[0].url, "https://generativelanguage.googleapis.com/v1beta/interactions");
  assert.equal(calls[0].options.headers["x-goog-api-key"], "google-key");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    model: "gemini-2.5-flash-lite",
    input: [{ type: "text", text: "Create a picture of a nano banana dish" }],
  });
});

test("uses the requested Gemini image model", async () => {
  const calls = [];
  await generateGeminiImage({
    prompt: "Create a product image",
    imageModel: "gemini-3.5-flash",
    settings: { googleAiApiKey: "google-key" },
    fetchImpl: async (_url, options) => {
      calls.push(options);
      return { ok: true, json: async () => ({ output: [{ type: "image", image: "base64-image" }] }), text: async () => "" };
    },
  });

  assert.equal(JSON.parse(calls[0].body).model, "gemini-3.5-flash");
});

test("returns Gemini image output as a data URL", async () => {
  const result = await generateGeminiImage({
    prompt: "Create a product image",
    settings: { googleAiApiKey: "google-key" },
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ output: [{ type: "image", image: "base64-image" }] }),
      text: async () => "",
    }),
  });

  assert.equal(result, "data:image/png;base64,base64-image");
});

test("returns Gemini image data from interaction steps", async () => {
  const result = await generateGeminiImage({
    prompt: "Create a product image",
    settings: { googleAiApiKey: "google-key" },
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        steps: [
          { type: "thought", signature: "ignored" },
          {
            type: "model_output",
            content: {
              type: "image",
              inline_data: {
                mime_type: "image/png",
                data: "step-base64-image",
              },
            },
          },
        ],
      }),
      text: async () => "",
    }),
  });

  assert.equal(result, "data:image/png;base64,step-base64-image");
});

test("returns Gemini image data from direct step content data", async () => {
  const result = await generateGeminiImage({
    prompt: "Create a product image",
    settings: { googleAiApiKey: "google-key" },
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        steps: [
          {
            type: "model_output",
            content: [
              {
                type: "image",
                mime_type: "image/png",
                data: "direct-step-base64-image",
              },
            ],
          },
        ],
      }),
      text: async () => "",
    }),
  });

  assert.equal(result, "data:image/png;base64,direct-step-base64-image");
});
