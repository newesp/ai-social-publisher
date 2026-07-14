import assert from "node:assert/strict";
import { test } from "node:test";

import { generatePlatformTargets, generateText } from "../src/lib/ai/llm-service.js";

test("separates system instructions from untrusted input for both providers", async () => {
  for (const llmProvider of ["openai", "google"]) {
    let requestBody;
    await generateText({
      llmProvider,
      settings: { openAiApiKey: "openai-key", googleAiApiKey: "google-key" },
      systemPrompt: "Trusted instruction",
      prompt: "Untrusted post text",
      fetchImpl: async (_url, options) => {
        requestBody = JSON.parse(options.body);
        return { ok: true, json: async () => ({ output_text: "{}" }), text: async () => "" };
      },
    });

    assert.equal(requestBody.input, "Untrusted post text");
    assert.equal(
      llmProvider === "openai" ? requestBody.instructions : requestBody.system_instruction,
      "Trusted instruction",
    );
  }
});

test("generates active platform targets with OpenAI responses", async () => {
  const calls = [];
  const targets = await generatePlatformTargets({
    llmProvider: "openai",
    settings: { openAiApiKey: "openai-key" },
    input: {
      productName: "Demo",
      productFeatures: "Fast posting",
      platforms: ["meta", "instagram", "line"],
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        json: async () => ({ output_text: "Generated content" }),
        text: async () => "",
      };
    },
  });

  assert.deepEqual(
    targets.map((target) => target.platform),
    ["meta", "line"],
  );
  assert.equal(targets[0].content, "Generated content");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://api.openai.com/v1/responses");
});

test("generates active platform targets with Gemini responses", async () => {
  const calls = [];
  const targets = await generatePlatformTargets({
    llmProvider: "google",
    settings: { googleAiApiKey: "google-key" },
    input: {
      productName: "Demo",
      productFeatures: "Fast posting",
      platforms: ["meta"],
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        json: async () => ({ output: "Gemini content" }),
        text: async () => "",
      };
    },
  });

  assert.deepEqual(targets, [
    {
      platform: "meta",
      content: "Gemini content",
      hashtags: [],
    },
  ]);
  assert.equal(calls[0].url, "https://generativelanguage.googleapis.com/v1beta/interactions");
  assert.equal(calls[0].options.headers["x-goog-api-key"], "google-key");
  assert.equal(JSON.parse(calls[0].options.body).model, "gemini-3.1-flash-lite");
});

test("uses the requested LLM model in provider requests", async () => {
  const calls = [];
  await generatePlatformTargets({
    llmProvider: "google",
    llmModel: "gemini-3.5-flash",
    settings: { googleAiApiKey: "google-key" },
    input: { platforms: ["meta"] },
    fetchImpl: async (_url, options) => {
      calls.push(options);
      return { ok: true, json: async () => ({ output: "Generated content" }), text: async () => "" };
    },
  });

  assert.equal(JSON.parse(calls[0].body).model, "gemini-3.5-flash");
});

test("fails fast when provider credentials are missing", async () => {
  await assert.rejects(
    () =>
      generatePlatformTargets({
        llmProvider: "openai",
        settings: {},
        input: { platforms: ["meta"] },
        fetchImpl: async () => {
          throw new Error("fetch should not be called");
        },
      }),
    /OPENAI_API_KEY is required/,
  );
});

test("wraps provider network failures with an actionable message", async () => {
  await assert.rejects(
    () =>
      generatePlatformTargets({
        llmProvider: "google",
        settings: { googleAiApiKey: "google-key" },
        input: { platforms: ["meta"], productName: "Demo" },
        fetchImpl: async () => {
          throw new TypeError("fetch failed");
        },
      }),
    /Gemini API request failed: fetch failed/,
  );
});

test("reads Gemini interactions text from model output steps", async () => {
  const targets = await generatePlatformTargets({
    llmProvider: "google",
    settings: { googleAiApiKey: "google-key" },
    input: { productName: "Alpha CRM", productFeatures: "Saves time", platforms: ["meta"] },
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        steps: [
          { type: "thought", signature: "ignored" },
          { type: "model_output", content: [{ type: "text", text: "Step generated text" }] },
        ],
      }),
      text: async () => "",
    }),
  });

  assert.equal(targets[0].content, "Step generated text");
});
