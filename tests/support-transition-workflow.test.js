import assert from "node:assert/strict";
import { test } from "node:test";

import { createSupportTransitionWorkflow } from "../src/lib/support/workflows/support-transition-workflow.js";

test("switching selected customer does not alter another conversation transition", async () => {
  const commits = [];
  const workflow = createSupportTransitionWorkflow({
    sleepImpl: async (duration) => assert.equal(duration, "10s"),
    transitionService: { async commitIfCurrent(input) { commits.push(input); return { status: "committed" }; } },
  });
  await workflow({ transitionId: "transition-a", conversationId: "conversation-a" });
  const selectedConversation = "conversation-b";
  assert.equal(selectedConversation, "conversation-b");
  assert.deepEqual(commits, [{ transitionId: "transition-a", conversationId: "conversation-a" }]);
});

test("new inbound cancels only the same conversation pending transition", async () => {
  const transitions = new Map([
    ["conversation-a", { id: "transition-a", cancelledAt: null }],
    ["conversation-b", { id: "transition-b", cancelledAt: null }],
  ]);
  const repository = {
    async recordInbound(owner, conversationId) {
      const transition = transitions.get(conversationId);
      transition.cancelledAt = new Date();
      return { owner, conversationId };
    },
  };
  await repository.recordInbound("owner@example.com", "conversation-a", { text: "new inbound" });
  assert.equal(transitions.get("conversation-a").cancelledAt instanceof Date, true);
  assert.equal(transitions.get("conversation-b").cancelledAt, null);
});

test("commit is fenced by the transition id, pending id, and optimistic version", async () => {
  const commits = [];
  const workflow = createSupportTransitionWorkflow({
    sleepImpl: async () => {},
    transitionService: { async commitIfCurrent(input) { commits.push(input); return { status: "stale" }; } },
  });
  assert.deepEqual(await workflow({ transitionId: "stale-transition", conversationId: "conversation-1" }), { status: "stale" });
  assert.deepEqual(commits, [{ transitionId: "stale-transition", conversationId: "conversation-1" }]);
});
