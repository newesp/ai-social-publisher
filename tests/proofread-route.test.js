import assert from "node:assert/strict";
import test from "node:test";

import { createProofreadRouteHandler } from "../src/lib/settings/proofread-route-handler.js";

test("proofread route uses only the signed-in owner's settings", async () => {
  const calls = [];
  const handler = createProofreadRouteHandler({
    requireOwner: async () => "owner@example.com",
    store: {
      async read(ownerEmail) {
        calls.push(["read", ownerEmail]);
        return { googleAiApiKey: "owner-secret" };
      },
    },
    proofread: async ({ body, settings }) => {
      calls.push(["proofread", body.llmModel, settings.googleAiApiKey]);
      return { issues: [] };
    },
  });

  const response = await handler(new Request("http://localhost/api/proofread", {
    method: "POST",
    body: JSON.stringify({
      llmProvider: "google",
      llmModel: "gemini-3.1-flash-lite",
      targets: [{ platform: "meta", content: "待校對文案" }],
    }),
  }));

  assert.deepEqual(await response.json(), { issues: [] });
  assert.deepEqual(calls, [
    ["read", "owner@example.com"],
    ["proofread", "gemini-3.1-flash-lite", "owner-secret"],
  ]);
});

test("proofread route returns a safe Chinese error without provider secrets", async () => {
  const handler = createProofreadRouteHandler({
    requireOwner: async () => "owner@example.com",
    store: { async read() { return { googleAiApiKey: "owner-secret" }; } },
    proofread: async () => {
      throw new Error("owner@example.com failed with owner-secret");
    },
  });

  const response = await handler(new Request("http://localhost/api/proofread", {
    method: "POST",
    body: JSON.stringify({
      llmProvider: "google",
      llmModel: "gemini-3.1-flash-lite",
      targets: [{ platform: "meta", content: "待校對文案" }],
    }),
  }));
  const result = await response.json();

  assert.equal(response.status, 400);
  assert.deepEqual(result, { error: "AI 錯字檢查失敗，請稍後再試。" });
  assert.doesNotMatch(JSON.stringify(result), /owner@example\.com|owner-secret/);
});

test("proofread route rejects unsupported models, platforms, and oversized content before provider use", async () => {
  let proofreadCalls = 0;
  const handler = createProofreadRouteHandler({
    requireOwner: async () => "owner@example.com",
    store: { async read() { return { googleAiApiKey: "owner-secret" }; } },
    proofread: async () => { proofreadCalls += 1; return { issues: [] }; },
  });

  for (const body of [
    { llmProvider: "google", llmModel: "unsupported", targets: [{ platform: "meta", content: "文案" }] },
    { llmProvider: "google", llmModel: "gemini-3.1-flash-lite", targets: [{ platform: "other", content: "文案" }] },
    { llmProvider: "google", llmModel: "gemini-3.1-flash-lite", targets: [{ platform: "meta", content: "文".repeat(5001) }] },
  ]) {
    const response = await handler(new Request("http://localhost/api/proofread", {
      method: "POST",
      body: JSON.stringify(body),
    }));
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "AI 錯字檢查失敗，請稍後再試。" });
  }
  assert.equal(proofreadCalls, 0);
});
