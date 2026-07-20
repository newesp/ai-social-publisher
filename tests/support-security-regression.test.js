import assert from "node:assert/strict";
import { test } from "node:test";

import { createSupportInboxRouteHandlers } from "../src/lib/support/routes/support-inbox-route-handlers.js";
import { createSupportRetentionCronRouteHandlers } from "../src/lib/support/retention/support-retention-cron.js";

const PROTECTED_FIXTURES = ["channel-secret", "access-token", "reply-token", "U-customer-id"];

test("support browser and retention-cron responses redact protected fixtures", async () => {
  const inboxHandlers = createSupportInboxRouteHandlers({
    requireOwner: async () => "owner@example.com",
    getStore: async () => ({
      async getConversation() {
        return {
          id: "conversation-1",
          customerLabel: "Customer",
          status: "waiting_human",
          unreadCount: 1,
          version: 3,
          messages: [{
            id: "message-1",
            direction: "inbound",
            senderType: "customer",
            messageType: "text",
            text: "Question",
            deliveryStatus: "sent",
            encryptedReplyToken: "reply-token",
            externalUserId: "U-customer-id",
            accessToken: "access-token",
            channelSecret: "channel-secret",
            createdAt: new Date("2026-07-20T01:00:00.000Z"),
          }],
          decisions: [],
          faqSources: [],
          pendingTransition: null,
        };
      },
    }),
  });
  const cronHandlers = createSupportRetentionCronRouteHandlers({
    createService: () => ({
      async purgeExpiredContent() {
        return { messagesCleared: 1, replyTokensCleared: 1, outboundBodiesCleared: 1, retryToken: "reply-token" };
      },
    }),
    env: { CRON_SECRET: "cron-secret" },
  });

  const outputs = [
    await (await inboxHandlers.getConversation(new Request("https://app.test/api/support/conversations/conversation-1"), "conversation-1")).json(),
    await (await cronHandlers.GET(new Request("https://app.test/api/cron/support-retention", {
      headers: { authorization: "Bearer cron-secret" },
    }))).json(),
  ];

  for (const output of outputs) {
    for (const fixture of PROTECTED_FIXTURES) {
      assert.equal(JSON.stringify(output).includes(fixture), false);
    }
  }
});
