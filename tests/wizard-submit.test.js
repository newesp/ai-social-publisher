import assert from "node:assert/strict";
import test from "node:test";

import { isSuccessfulPostResult, submitCheckedPost } from "../src/lib/wizard/wizard-submit.js";

const INPUT = {
  form: {
    productName: "新品",
    productFeatures: "特色",
    llmProvider: "google",
    llmModel: "gemini-selected",
    mode: "now",
  },
  targets: [{ platform: "meta", content: "熱列上市" }],
  imageUrl: null,
};

test("stops before the posts API when proofreading finds typos", async () => {
  const calls = [];
  const result = await submitCheckedPost({
    ...INPUT,
    fetchImpl: async (url, options) => {
      calls.push([url, JSON.parse(options.body)]);
      return jsonResponse({ issues: [{ platform: "meta", original: "熱列", suggestion: "熱烈", reason: "錯字" }] });
    },
  });

  assert.equal(result.status, "issues");
  assert.equal(result.issues.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "/api/proofread");
  assert.deepEqual(calls[0][1], {
    llmProvider: "google",
    llmModel: "gemini-selected",
    targets: INPUT.targets,
  });
});

test("creates the post only after proofreading returns no issues", async () => {
  const calls = [];
  const result = await submitCheckedPost({
    ...INPUT,
    fetchImpl: async (url, options) => {
      calls.push(url);
      if (url === "/api/proofread") return jsonResponse({ issues: [] });
      return jsonResponse({ post: { id: 7, status: "scheduled", targets: [] } });
    },
  });

  assert.deepEqual(calls, ["/api/proofread", "/api/posts"]);
  assert.deepEqual(result, { status: "submitted", post: { id: 7, status: "scheduled", targets: [] } });
});

test("does not publish when proofreading fails", async () => {
  let postCalls = 0;
  await assert.rejects(
    () => submitCheckedPost({
      ...INPUT,
      fetchImpl: async (url) => {
        if (url === "/api/posts") postCalls += 1;
        return jsonResponse({ error: "AI 錯字檢查失敗，請稍後再試。" }, false);
      },
    }),
    /AI 錯字檢查失敗/,
  );
  assert.equal(postCalls, 0);
});

test("only scheduled and fully published posts are successful reset states", () => {
  assert.equal(isSuccessfulPostResult({ status: "scheduled" }), true);
  assert.equal(isSuccessfulPostResult({ status: "published" }), true);
  assert.equal(isSuccessfulPostResult({ status: "partial_failed" }), false);
  assert.equal(isSuccessfulPostResult({ status: "failed" }), false);
});

function jsonResponse(body, ok = true) {
  return {
    ok,
    async json() { return body; },
  };
}
