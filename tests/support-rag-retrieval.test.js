import assert from "node:assert/strict";
import { test } from "node:test";

import { retrieveRagKnowledge } from "../src/lib/support/knowledge/rag-retrieval.js";

test("RAG retrieval matches the production Traditional Chinese return question", () => {
  const results = retrieveRagKnowledge({
    query: "我買了移動式冷氣，想退貨",
    knowledge: [
      {
        id: "return-policy",
        question: "網購退換貨基本原則：收到商品隔天想退貨（無瑕疵 / 純粹不喜歡）",
        answer: "請先確認收貨時間、商品是否拆封組裝，以及外箱與配件是否完整。",
        category: "退換貨",
        keywords: ["移動式冷氣", "退貨"],
        enabled: true,
        priority: 0,
      },
      {
        id: "shipping-policy",
        question: "購買付款方式",
        answer: "配送費依樓層計算。",
        category: "配送",
        keywords: ["配送"],
        enabled: true,
        priority: 100,
      },
    ],
  });

  assert.equal(results[0]?.id, "return-policy");
  assert.equal(results[0]?.customerAnswer.includes("拆封組裝"), true);
  assert.deepEqual(results.map(({ id }) => id), ["return-policy"]);
});
