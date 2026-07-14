import assert from "node:assert/strict";
import test from "node:test";

import { buildProofreadPrompt, buildProofreadSystemPrompt, proofreadTargets } from "../src/lib/ai/proofread-service.js";

const TARGETS = [
  { platform: "meta", content: "新品現正熱列上市" },
  { platform: "line", content: "歡迎洽詢" },
];

test("proofreads all final target content with the selected Gemini LLM", async () => {
  const calls = [];
  const result = await proofreadTargets({
    llmProvider: "google",
    llmModel: "gemini-3.1-flash-lite",
    settings: { googleAiApiKey: "google-secret" },
    targets: TARGETS,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return okJson({ output: JSON.stringify({ issues: [{
        platform: "meta",
        original: "熱列",
        suggestion: "熱烈",
        reason: "同音錯字",
      }] }) });
    },
  });

  assert.deepEqual(result, { issues: [{
    platform: "meta",
    original: "熱列",
    suggestion: "熱烈",
    reason: "同音錯字",
  }] });
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.model, "gemini-3.1-flash-lite");
  assert.match(body.input, /新品現正熱列上市/);
  assert.match(body.system_instruction, /只檢查錯字/);
});

test("accepts fenced OpenAI JSON and drops no-op suggestions", async () => {
  const result = await proofreadTargets({
    llmProvider: "openai",
    llmModel: "gpt-4o",
    settings: { openAiApiKey: "openai-secret" },
    targets: TARGETS,
    fetchImpl: async () => okJson({
      output_text: "```json\n{\"issues\":[{\"platform\":\"line\",\"original\":\"洽詢\",\"suggestion\":\"洽詢\",\"reason\":\"無需修正\"}]}\n```",
    }),
  });

  assert.deepEqual(result.issues, []);
});

test("fails closed when any issue has an invalid shape or unrelated original text", async () => {
  for (const issue of [
    { platform: "other", original: "熱列", suggestion: "熱烈", reason: "錯字" },
    { platform: "meta", original: "不存在", suggestion: "存在", reason: "錯字" },
    { platform: "meta", original: "熱列", suggestion: "熱烈" },
  ]) {
    await assert.rejects(
      () => proofreadTargets({
        settings: { googleAiApiKey: "google-secret" },
        targets: TARGETS,
        fetchImpl: async () => okJson({ output: JSON.stringify({ issues: [issue] }) }),
      }),
      /AI 校對回應格式錯誤/,
    );
  }
});

test("rejects malformed proofread output instead of treating it as clean", async () => {
  await assert.rejects(
    () => proofreadTargets({
      settings: { googleAiApiKey: "google-secret" },
      targets: TARGETS,
      fetchImpl: async () => okJson({ output: "沒有錯字" }),
    }),
    /AI 校對回應格式錯誤/,
  );
});

test("proofread prompt preserves proper nouns and requests strict JSON", () => {
  const systemPrompt = buildProofreadSystemPrompt();
  const prompt = buildProofreadPrompt(TARGETS);
  assert.match(systemPrompt, /LINE/);
  assert.match(systemPrompt, /JSON/);
  assert.equal(prompt, JSON.stringify(TARGETS));
});

function okJson(body) {
  return {
    ok: true,
    async json() { return body; },
    async text() { return JSON.stringify(body); },
  };
}
