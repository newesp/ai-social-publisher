import assert from "node:assert/strict";
import { test } from "node:test";

import { createLineMessageWorkflow } from "../src/lib/support/workflows/line-message-workflow.js";

const IDS = Object.freeze({ eventId: "event-1", connectionId: "connection-1", conversationId: "conversation-1" });
const START = new Date("2026-07-20T00:00:00.000Z");

test("messages inside one three-second workflow window become one AI turn", async () => {
  const calls = [];
  const workflow = createLineMessageWorkflow({
    eventStore: claimedEventStore(),
    processingService: {
      acquireClaim: async () => ({ acquired: true, claimId: "conversation-claim", windowStart: START }),
      buildTurn: async (input) => {
        calls.push({ name: "build", input });
        return { inboundMessageId: "message-1", customerTexts: ["first", "second"] };
      },
      decideAndPersist: async (input) => { calls.push({ name: "decide", input }); return { status: "pending_delivery", deliveryId: "delivery-1" }; },
      deliver: async (input) => { calls.push({ name: "deliver", input }); return { status: "sent" }; },
      releaseClaim: async (input) => { calls.push({ name: "release", input }); },
      findFollowUp: async () => null,
    },
    sleepImpl: async (duration) => { assert.equal(duration, "3s"); },
    now: () => START,
  });

  const result = await workflow(IDS);

  assert.deepEqual(result, { status: "sent" });
  assert.deepEqual(calls[0], { name: "build", input: { ...IDS, claimId: "conversation-claim", cutoff: new Date(START.getTime() + 3_000) } });
  assert.deepEqual(calls[1].input.customerTexts, ["first", "second"]);
  assert.deepEqual(calls[2], { name: "deliver", input: { deliveryId: "delivery-1", now: START } });
  assert.equal(calls.filter(({ name }) => name === "decide").length, 1);
});

test("a concurrent workflow relinquishes its event claim without creating a second turn", async () => {
  const eventStore = claimedEventStore();
  const resolved = [];
  const workflow = createLineMessageWorkflow({
    eventStore,
    processingService: {
      acquireClaim: async () => ({ acquired: false }),
      resolveCompetingEvent: async (input) => { resolved.push(input); return { status: "processed" }; },
      releaseClaim: async () => { throw new Error("must not release an unowned conversation claim"); },
    },
    sleepImpl: async () => { throw new Error("must not sleep"); },
    now: () => START,
  });

  assert.deepEqual(await workflow(IDS), { status: "already_processing" });
  assert.deepEqual(resolved, [{ ...IDS, claimId: "event-claim", now: START }]);
  assert.equal(eventStore.released.length, 0);
  assert.equal(eventStore.completed.length, 1);
});

test("the workflow renews both fences after batching and uses current attempt times after sleep", async () => {
  const eventStore = claimedEventStore();
  const renewals = [];
  const calls = [];
  const afterBatch = new Date(START.getTime() + 3_100);
  const attemptAt = new Date(START.getTime() + 3_200);
  const times = [START, afterBatch, afterBatch, attemptAt, attemptAt];
  const workflow = createLineMessageWorkflow({
    eventStore,
    processingService: {
      acquireClaim: async () => ({ acquired: true, claimId: "conversation-claim", windowStart: START }),
      renewClaim: async (input) => { renewals.push(input); return true; },
      buildTurn: async () => ({ inboundMessageId: "message-1", customerTexts: ["first"] }),
      decideAndPersist: async (input) => { calls.push({ name: "decide", now: input.now }); return { status: "pending_delivery", deliveryId: "delivery-1" }; },
      deliver: async (input) => { calls.push({ name: "deliver", now: input.now }); return { status: "sent" }; },
      releaseClaim: async () => {}, findFollowUp: async () => null,
    },
    sleepImpl: async () => {},
    now: () => times.shift(),
  });

  assert.deepEqual(await workflow(IDS), { status: "sent" });
  assert.equal(eventStore.renewed.length >= 2, true);
  assert.equal(renewals.length >= 2, true);
  assert.deepEqual(calls, [{ name: "decide", now: afterBatch }, { name: "deliver", now: attemptAt }]);
});

test("a remaining unprocessed message starts one durable follow-up after the conversation claim is released", async () => {
  const starts = [];
  const workflow = createLineMessageWorkflow({
    eventStore: claimedEventStore(),
    processingService: {
      acquireClaim: async () => ({ acquired: true, claimId: "conversation-claim", windowStart: START }),
      buildTurn: async () => null,
      releaseClaim: async () => {},
      findFollowUp: async () => ({ eventId: "event-2", connectionId: IDS.connectionId, conversationId: IDS.conversationId }),
    },
    sleepImpl: async () => {},
    startWorkflow: async (input) => starts.push(input),
  });

  assert.deepEqual(await workflow(IDS), { status: "no_messages" });
  assert.deepEqual(starts, [{ eventId: "event-2", connectionId: IDS.connectionId, conversationId: IDS.conversationId }]);
});

test("the winning batch resolves every competing event it consumed before follow-up scheduling", async () => {
  const resolved = [];
  const workflow = createLineMessageWorkflow({
    eventStore: claimedEventStore(),
    processingService: {
      acquireClaim: async () => ({ acquired: true, claimId: "conversation-claim", windowStart: START }),
      buildTurn: async () => ({ inboundMessageId: "message-1", customerTexts: ["first", "second"] }),
      resolveBatchedEvents: async (input) => { resolved.push(input); },
      decideAndPersist: async () => ({ status: "waiting_human" }),
      releaseClaim: async () => {}, findFollowUp: async () => null,
    },
    sleepImpl: async () => {}, now: () => START,
  });

  assert.deepEqual(await workflow(IDS), { status: "waiting_human" });
  assert.deepEqual(resolved, [{ ...IDS, cutoff: new Date(START.getTime() + 3_000) }]);
});

test("a retryable Push delivery waits for its persisted retry time and reuses the same outbox delivery", async () => {
  const deliveryCalls = [];
  const sleeps = [];
  const retryAt = new Date(START.getTime() + 1_000);
  const times = [START, START, START, START, retryAt, retryAt, retryAt];
  const workflow = createLineMessageWorkflow({
    eventStore: claimedEventStore(),
    processingService: {
      acquireClaim: async () => ({ acquired: true, claimId: "conversation-claim", windowStart: START }),
      buildTurn: async () => ({ inboundMessageId: "message-1", customerTexts: ["first"] }),
      decideAndPersist: async () => ({ status: "pending_delivery", deliveryId: "delivery-1" }),
      deliver: async (input) => {
        deliveryCalls.push(input);
        return deliveryCalls.length === 1
          ? { status: "retryable", retryAt }
          : { status: "sent" };
      },
      releaseClaim: async () => {}, findFollowUp: async () => null,
    },
    sleepImpl: async (duration) => { sleeps.push(duration); },
    now: () => times.shift(),
  });

  assert.deepEqual(await workflow(IDS), { status: "sent" });
  assert.deepEqual(sleeps, ["3s", "1s"]);
  assert.deepEqual(deliveryCalls, [
    { deliveryId: "delivery-1", now: START },
    { deliveryId: "delivery-1", now: new Date(START.getTime() + 1_000) },
  ]);
});

function claimedEventStore() {
  return {
    completed: [], released: [], renewed: [],
    async claimEventProcessing() { return { claimed: true, claimId: "event-claim" }; },
    async renewEventProcessing(input) { this.renewed.push(input); return true; },
    async markEventProcessed(input) { this.completed.push(input); return true; },
    async releaseEventProcessing(input) { this.released.push(input); return true; },
  };
}
