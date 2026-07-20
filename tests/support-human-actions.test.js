import assert from "node:assert/strict";
import { test } from "node:test";

import { createSupportHumanActionRouteHandlers } from "../src/lib/support/routes/support-human-action-route-handlers.js";

test("take-over and human Push replies use the authenticated owner, same-origin guard, and stable retry key", async () => {
  const calls = [];
  const handlers = createSupportHumanActionRouteHandlers({
    requireOwner: async () => "OWNER@EXAMPLE.COM",
    requireSameOrigin: () => calls.push(["origin"]),
    getStore: async () => ({
      async takeOver(owner, id, expectedVersion) { calls.push(["take", owner, id, expectedVersion]); return { id, status: "human_active", version: 4 }; },
      async sendHumanMessage(owner, id, input) { calls.push(["send", owner, id, input]); return { id: "message-1", deliveryStatus: "sent", retryKey: "11111111-1111-4111-8111-111111111111" }; },
    }),
  });

  const take = await handlers.takeOver(new Request("http://localhost", { method: "POST", headers: { origin: "http://localhost", "content-type": "application/json" }, body: JSON.stringify({ expectedVersion: 3 }) }), "conversation-1");
  assert.deepEqual(await take.json(), { conversation: { id: "conversation-1", status: "human_active", version: 4 } });
  const sent = await handlers.sendMessage(new Request("http://localhost", { method: "POST", headers: { origin: "http://localhost", "content-type": "application/json" }, body: JSON.stringify({ text: "Thanks", idempotencyKey: "message-key-1" }) }), "conversation-1");
  assert.equal((await sent.json()).message.deliveryStatus, "sent");
  assert.deepEqual(calls, [
    ["origin"], ["take", "owner@example.com", "conversation-1", 3],
    ["origin"], ["send", "owner@example.com", "conversation-1", { text: "Thanks", idempotencyKey: "message-key-1" }],
  ]);
});

test("transition requests and exact undo use server state only and stale undo is a conflict", async () => {
  const calls = [];
  const handlers = createSupportHumanActionRouteHandlers({
    requireOwner: async () => "owner@example.com",
    requireSameOrigin: () => calls.push(["origin"]),
    getStore: async () => ({
      async requestTransition(owner, id, action, expectedVersion) {
        calls.push(["request", owner, id, action, expectedVersion]);
        return { id: "transition-1", conversationId: id, action, effectiveAt: new Date("2026-07-20T00:00:10.000Z") };
      },
      async undoTransition(owner, id, transitionId) { calls.push(["undo", owner, id, transitionId]); return null; },
    }),
  });
  const requested = await handlers.requestTransition(new Request("http://localhost", { method: "POST", headers: { origin: "http://localhost", "content-type": "application/json" }, body: JSON.stringify({ action: "resolve", expectedVersion: 3 }) }), "conversation-1");
  assert.equal(requested.status, 200);
  const undone = await handlers.undoTransition(new Request("http://localhost", { method: "POST", headers: { origin: "http://localhost" } }), "conversation-1", "transition-1");
  assert.equal(undone.status, 409);
  assert.deepEqual(calls, [
    ["origin"], ["request", "owner@example.com", "conversation-1", "resolve", 3],
    ["origin"], ["undo", "owner@example.com", "conversation-1", "transition-1"],
  ]);
});

test("another owner cannot take over, send, request, or undo a conversation", async () => {
  const handlers = createSupportHumanActionRouteHandlers({
    requireOwner: async () => "owner@example.com",
    getStore: async () => ({
      async takeOver() { return null; }, async sendHumanMessage() { return null; },
      async requestTransition() { return null; }, async undoTransition() { return null; },
    }),
  });
  const response = await handlers.takeOver(new Request("http://localhost", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedVersion: 0 }) }), "other-owner");
  assert.equal(response.status, 404);
});
