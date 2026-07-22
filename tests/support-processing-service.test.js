import assert from "node:assert/strict";
import { test } from "node:test";

import { createSupportDecisionService } from "../src/lib/support/decisions/support-decision-service.js";
import { createSupportProcessingService } from "../src/lib/support/support-processing-service.js";

const IDS = Object.freeze({ eventId: "event-1", connectionId: "connection-1", conversationId: "conversation-1" });
const NOW = new Date("2026-07-20T00:00:00.000Z");

test("buildTurn exposes only internal batch metadata to durable workflow state", async () => {
  const calls = [];
  const service = createSupportProcessingService({
    repository: {
      acquireConversationClaim: async (input) => ({ acquired: true, claimId: "claim-1", windowStart: input.now }),
      buildClaimedTurn: async (input) => {
        calls.push(input);
        return { inboundMessageId: "message-1", customerTexts: ["first", "second"] };
      },
    },
  });

  const claim = await service.acquireClaim({ ...IDS, now: NOW });
  const turn = await service.buildTurn({ ...IDS, claimId: claim.claimId, cutoff: new Date(NOW.getTime() + 3_000) });

  assert.deepEqual(claim, { acquired: true, claimId: "claim-1", windowStart: NOW });
  assert.deepEqual(turn, { inboundMessageId: "message-1" });
  assert.deepEqual(calls, [{ ...IDS, claimId: "claim-1", cutoff: new Date(NOW.getTime() + 3_000) }]);
});

test("the eleventh AI turn in five minutes persists a rate-limit handoff without an LLM call", async () => {
  let decisionCalls = 0;
  const handoffs = [];
  const service = createSupportProcessingService({
    repository: {
      loadCurrentProcessingContext: async () => ({
        supportState: "enabled", conversationStatus: "ai_active", aiTurnsInLastFiveMinutes: 10,
      }),
      persistHandoff: async (input) => handoffs.push(input),
    },
    decisionService: { decide: async () => { decisionCalls += 1; return { action: "reply" }; } },
  });

  const result = await service.decideAndPersist({ ...IDS, claimId: "claim-1", inboundMessageId: "message-1", customerTexts: ["question"], now: NOW });

  assert.deepEqual(result, { status: "waiting_human", handoffReasonCode: "rate_limit" });
  assert.equal(decisionCalls, 0);
  assert.deepEqual(handoffs, [{ ...IDS, claimId: "claim-1", inboundMessageId: "message-1", reasonCode: "rate_limit", now: NOW }]);
});

test("decision persistence loads current protected context and atomically creates one immutable Push outbox record", async () => {
  const persisted = [];
  const service = createSupportProcessingService({
    repository: {
      loadCurrentProcessingContext: async (ids) => ({
        ...ids,
        supportState: "enabled",
        conversationStatus: "ai_active",
        aiTurnsInLastFiveMinutes: 0,
        configuration: { brandName: "Acme", assistantName: "Ava", replyTone: "friendly", llmProvider: "openai", llmModel: "gpt-test" },
        settings: { openAiApiKey: "private-key" },
        faqs: [{ id: "faq-1", question: "How do I reset?", answer: "Use reset.", category: "account", keywords: ["reset"], enabled: true, priority: 0 }],
        customerTexts: ["How do I reset?"],
        messages: [{ senderType: "customer", text: "How do I reset?" }],
        recipient: "U-private",
      }),
      persistDecisionAndOutbound: async (input) => { persisted.push(input); return { decisionId: "decision-1", deliveryId: "delivery-1" }; },
    },
    decisionService: { decide: async ({ faqs, settings }) => {
      assert.equal(settings.openAiApiKey, "private-key");
      assert.deepEqual(faqs.map(({ id }) => id), ["faq-1"]);
      return { action: "reply", answer: "Use reset.", category: "account", handoffReasonCode: null, knowledgeSourceIds: ["faq-1"] };
    } },
  });

  const result = await service.decideAndPersist({
    ...IDS, claimId: "claim-1", eventClaimId: "event-claim", inboundMessageId: "message-1",
    cutoff: new Date(NOW.getTime() + 3_000), now: NOW,
  });

  assert.deepEqual(result, { status: "pending_delivery", deliveryId: "delivery-1" });
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].canonicalBody, '{"to":"U-private","messages":[{"type":"text","text":"Use reset.\\n\\n以上說明是否解決您的問題？若沒有其他問題，我可以為您結案。"}]}');
  assert.deepEqual(persisted[0].decision, {
    action: "reply",
    answer: "Use reset.\n\n以上說明是否解決您的問題？若沒有其他問題，我可以為您結案。",
    category: "account",
    handoffReasonCode: null,
    knowledgeSourceIds: ["faq-1"],
    conversationDisposition: "ask_close_confirmation",
  });
});

test("a return-policy question uses grounded FAQ guidance without claiming an operational action", async () => {
  const persisted = [];
  const context = {
    supportState: "enabled",
    conversationStatus: "ai_active",
    aiTurnsInLastFiveMinutes: 0,
    configuration: { llmProvider: "google", llmModel: "gemini-test" },
    settings: { googleAiApiKey: "private-key" },
    recipient: "U-private",
    customerTexts: ["我買了移動式冷氣，想退貨"],
    messages: [{ senderType: "customer", text: "我買了移動式冷氣，想退貨" }],
    faqs: [{
      id: "return-policy",
      question: "網購退換貨基本原則：收到商品隔天想退貨",
      answer: "請先確認收貨時間、商品是否拆封組裝，以及外箱與配件是否完整。",
      internalNotes: "客服內部判斷步驟，不得傳給客戶。",
      category: "退換貨",
      keywords: ["移動式冷氣", "退貨"],
      enabled: true,
      priority: 0,
    }],
  };
  const decisionService = createSupportDecisionService({
    generateTextImpl: async ({ prompt }) => {
      assert.equal(prompt.includes("return-policy"), true);
      assert.equal(prompt.includes("客服內部判斷步驟"), false);
      return JSON.stringify({
        action: "reply",
        answer: "可以協助您確認退貨資格，請問商品是否已拆封或組裝？",
        category: "退換貨",
        handoffReasonCode: null,
        knowledgeSourceIds: ["return-policy"],
      });
    },
  });
  const service = createSupportProcessingService({
    now: () => NOW,
    repository: {
      loadCurrentProcessingContext: async () => context,
      persistDecisionAndOutbound: async (input) => {
        persisted.push(input);
        return { deliveryId: "delivery-return-policy" };
      },
    },
    decisionService,
  });

  const result = await service.decideAndPersist({
    ...IDS,
    claimId: "claim-1",
    eventClaimId: "event-claim",
    inboundMessageId: "message-1",
    now: NOW,
  });

  assert.deepEqual(result, { status: "pending_delivery", deliveryId: "delivery-return-policy" });
  assert.deepEqual(persisted[0].decision.knowledgeSourceIds, ["return-policy"]);
  assert.equal(persisted[0].decision.conversationDisposition, "ask_close_confirmation");
});

test("a grounded clarification is persisted and delivered as an AI turn", async () => {
  const persisted = [];
  const context = {
    supportState: "enabled", conversationStatus: "ai_active", aiTurnsInLastFiveMinutes: 0,
    configuration: { llmProvider: "openai", llmModel: "gpt-test" },
    settings: { openAiApiKey: "private-key" },
    faqs: [{ id: "faq-1", question: "Which account do you mean?", answer: "Use reset.", category: "account", keywords: ["account"] }],
    customerTexts: ["account help"], messages: [{ senderType: "customer", text: "account help" }],
    recipient: "U-private",
  };
  const service = createSupportProcessingService({
    repository: {
      loadCurrentProcessingContext: async () => context,
      persistDecisionAndOutbound: async (value) => {
        persisted.push(value);
        return { deliveryId: "delivery-clarify" };
      },
    },
    decisionService: {
      decide: async () => ({
        action: "clarify", answer: "Which account do you mean?", category: "account",
        handoffReasonCode: null, knowledgeSourceIds: ["faq-1"],
      }),
    },
  });

  assert.deepEqual(await service.decideAndPersist({
    ...IDS, claimId: "claim-1", eventClaimId: "event-claim",
    inboundMessageId: "message-1", now: NOW,
  }), { status: "pending_delivery", deliveryId: "delivery-clarify" });
  assert.equal(persisted[0].decision.action, "clarify");
});

test("a customer confirmation after an AI close prompt sends a final reply and resolves only after delivery", async () => {
  const persisted = [];
  const service = createSupportProcessingService({
    now: () => NOW,
    repository: {
      loadCurrentProcessingContext: async () => ({
        supportState: "enabled",
        conversationStatus: "ai_active",
        aiTurnsInLastFiveMinutes: 0,
        aiClosureConfirmationMessageId: "close-prompt-message",
        aiClosureConfirmationExpiresAt: new Date(NOW.getTime() + 60_000),
        configuration: { llmProvider: "openai", llmModel: "gpt-test" },
        settings: { openAiApiKey: "private-key" },
        recipient: "U-private",
        customerTexts: ["我還沒買，只是先詢問，沒問題"],
        messages: [{ senderType: "customer", text: "我還沒買，只是先詢問，沒問題" }],
        faqs: [],
      }),
      persistDecisionAndOutbound: async (input) => {
        persisted.push(input);
        return { deliveryId: "delivery-close" };
      },
    },
    decisionService: { decide: async () => { throw new Error("should not call LLM"); } },
  });

  assert.deepEqual(await service.decideAndPersist({
    ...IDS, claimId: "claim-1", eventClaimId: "event-claim", inboundMessageId: "message-1", now: NOW,
  }), { status: "pending_delivery", deliveryId: "delivery-close" });
  assert.equal(persisted[0].decision.conversationDisposition, "resolve_after_delivery");
  assert.deepEqual(persisted[0].decision.knowledgeSourceIds, []);
  assert.match(persisted[0].decision.answer, /這次對話已為您結案/);
});

test("configuration that becomes unready hands off before any provider decision", async () => {
  let decisionCalls = 0;
  const handoffs = [];
  const service = createSupportProcessingService({
    repository: {
      loadCurrentProcessingContext: async () => ({
        supportState: "enabled", conversationStatus: "ai_active", configurationReady: false,
        aiTurnsInLastFiveMinutes: 0,
        configuration: { llmProvider: "openai", llmModel: "gpt-test" }, settings: { openAiApiKey: "private-key" },
        recipient: "U-private", faqs: [], messages: [],
      }),
      persistHandoff: async (input) => handoffs.push(input),
    },
    decisionService: { decide: async () => { decisionCalls += 1; } },
  });

  const result = await service.decideAndPersist({ ...IDS, claimId: "claim-1", inboundMessageId: "message-1", customerTexts: ["question"], now: NOW });

  assert.deepEqual(result, { status: "waiting_human", handoffReasonCode: "configuration_unready" });
  assert.equal(decisionCalls, 0);
  assert.equal(handoffs[0].reasonCode, "configuration_unready");
});

test("a retryable provider result is surfaced so the workflow owns its three durable attempt boundaries", async () => {
  let attempts = 0;
  const handoffs = [];
  const service = createSupportProcessingService({
    repository: {
      loadCurrentProcessingContext: async () => ({
        supportState: "enabled", conversationStatus: "ai_active", aiTurnsInLastFiveMinutes: 0,
        configuration: {}, settings: {}, faqs: [{ id: "faq-1", question: "question", answer: "answer", category: "general", keywords: ["question"], enabled: true }],
        customerTexts: ["question"], messages: [{ senderType: "customer", text: "question" }], recipient: "U-private",
      }),
      persistHandoff: async (input) => handoffs.push(input),
    },
    decisionService: { decide: async () => { attempts += 1; throw Object.assign(new Error("provider timeout"), { retryable: true }); } },
  });

  const result = await service.decideAndPersist({ ...IDS, claimId: "claim-1", inboundMessageId: "message-1", customerTexts: ["question"], now: NOW });

  assert.deepEqual(result, { status: "retryable_provider" });
  assert.equal(attempts, 1);
  assert.equal(handoffs.length, 0);
});

test("readiness is rechecked after a provider result before an outbox can be created", async () => {
  let reads = 0;
  let persisted = 0;
  const handoffs = [];
  const service = createSupportProcessingService({
    repository: {
      loadCurrentProcessingContext: async () => {
        reads += 1;
        return {
          supportState: "enabled", conversationStatus: "ai_active", configurationReady: reads === 1,
          aiTurnsInLastFiveMinutes: 0, configuration: { llmProvider: "openai", llmModel: "gpt-test" },
          settings: { openAiApiKey: "private-key" }, recipient: "U-private", faqs: [{ id: "faq-1", question: "q", answer: "a", category: "general", keywords: ["q"] }], messages: [],
        };
      },
      persistDecisionAndOutbound: async () => { persisted += 1; },
      persistHandoff: async (input) => handoffs.push(input),
    },
    decisionService: { decide: async () => ({ action: "reply", answer: "answer", category: "general", knowledgeSourceIds: ["faq-1"] }) },
  });

  const result = await service.decideAndPersist({ ...IDS, claimId: "claim-1", eventClaimId: "event-claim", inboundMessageId: "message-1", customerTexts: ["q"], now: NOW });

  assert.deepEqual(result, { status: "waiting_human", handoffReasonCode: "configuration_unready" });
  assert.equal(reads, 2);
  assert.equal(persisted, 0);
  assert.equal(handoffs[0].reasonCode, "configuration_unready");
});

test("a stale claimed turn cannot finalize after its conversation fence has been lost", async () => {
  const service = createSupportProcessingService({
    repository: {
      renewConversationClaim: async () => false,
    },
  });

  await assert.rejects(
    service.renewClaim({ ...IDS, claimId: "claim-1", now: NOW }),
    /Conversation processing claim was lost/,
  );
});

test("delivery preserves processing ownership for response-time credential fencing", async () => {
  const calls = [];
  const service = createSupportProcessingService({
    deliveryService: {
      attemptDelivery: async (input) => { calls.push(input); return { status: "sent" }; },
    },
  });

  const input = {
    deliveryId: "delivery-1", eventId: "event-1", eventClaimId: "event-claim",
    connectionId: "connection-1", conversationId: "conversation-1",
    conversationClaimId: "conversation-claim", now: NOW,
  };
  assert.deepEqual(await service.deliver(input), { status: "sent" });
  assert.deepEqual(calls, [input]);
});
