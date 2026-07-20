import assert from "node:assert/strict";
import { test } from "node:test";

import { createSupportInboxRouteHandlers } from "../src/lib/support/routes/support-inbox-route-handlers.js";

test("conversation detail rejects another owner's conversation", async () => {
  const handlers = createSupportInboxRouteHandlers({
    requireOwner: async () => "owner@example.com",
    getStore: async () => ({
      async getConversation(owner, id) {
        assert.equal(owner, "owner@example.com");
        assert.equal(id, "other-owner-conversation");
        return null;
      },
    }),
  });

  const response = await handlers.getConversation(new Request("http://localhost"), "other-owner-conversation");
  assert.equal(response.status, 404);
  assert.equal(JSON.stringify(await response.json()).includes("U-line-user"), false);
});

test("list, detail, and read calls use only the normalized authenticated owner", async () => {
  const calls = [];
  const handlers = createSupportInboxRouteHandlers({
    requireOwner: async () => "OWNER@EXAMPLE.COM",
    requireSameOrigin: () => calls.push(["origin"]),
    getStore: async () => ({
      async listConversations(owner, options) { calls.push(["list", owner, options]); return { conversations: [], nextCursor: null }; },
      async getConversation(owner, id) { calls.push(["detail", owner, id]); return { id, messages: [] }; },
      async markConversationRead(owner, id) { calls.push(["read", owner, id]); return { id, unreadCount: 0 }; },
    }),
  });

  const list = await handlers.listConversations(new Request("http://localhost/api/support/conversations?status=waiting_human&cursor=page-2"));
  assert.deepEqual(await list.json(), { conversations: [], nextCursor: null, attentionCount: 0 });
  await handlers.getConversation(new Request("http://localhost"), "conversation-1");
  const read = await handlers.markConversationRead(new Request("http://localhost", { method: "POST", headers: { origin: "http://localhost" } }), "conversation-1");

  assert.deepEqual(await read.json(), { conversation: { id: "conversation-1", unreadCount: 0 } });
  assert.deepEqual(calls, [
    ["list", "owner@example.com", { status: "waiting_human", cursor: "page-2" }],
    ["detail", "owner@example.com", "conversation-1"],
    ["origin"], ["read", "owner@example.com", "conversation-1"],
  ]);
});

test("browser responses exclude customer identifiers, owner email, and provider data", async () => {
  const handlers = createSupportInboxRouteHandlers({
    requireOwner: async () => "owner@example.com",
    getStore: async () => ({
      async listConversations() {
        return { conversations: [{ id: "conversation-1", customerExternalId: "U-line-user", ownerEmail: "owner@example.com", token: "secret" }], nextCursor: null };
      },
      async getConversation() {
        return { id: "conversation-1", messages: [], customerExternalId: "U-line-user", ownerEmail: "owner@example.com", rawProviderError: "private" };
      },
    }),
  });
  const list = await handlers.listConversations(new Request("http://localhost"));
  const detail = await handlers.getConversation(new Request("http://localhost"), "conversation-1");
  const body = JSON.stringify({ list: await list.json(), detail: await detail.json() });

  for (const forbidden of ["U-line-user", "owner@example.com", "secret", "private"]) assert.equal(body.includes(forbidden), false);
});

test("list returns a safe attention total independent of the paginated summaries", async () => {
  const handlers = createSupportInboxRouteHandlers({
    requireOwner: async () => "owner@example.com",
    getStore: async () => ({
      async listConversations() {
        return { conversations: [{ id: "conversation-1", customerLabel: "Customer" }], nextCursor: "next-page", attentionCount: 37 };
      },
    }),
  });

  const response = await handlers.listConversations(new Request("http://localhost/api/support/conversations"));
  assert.deepEqual(await response.json(), {
    conversations: [{
      id: "conversation-1", customerLabel: "Customer", status: "", unreadCount: 0,
      handoffReason: null, lastMessagePreview: null, deliveryFailed: false,
      lastInboundAt: null, lastOutboundAt: null, updatedAt: null, pendingTransition: null,
    }],
    nextCursor: "next-page",
    attentionCount: 37,
  });
});
