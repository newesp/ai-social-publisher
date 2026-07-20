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
  const workflow = createLineMessageWorkflow({
    eventStore,
    processingService: {
      acquireClaim: async () => ({ acquired: false }),
      releaseClaim: async () => { throw new Error("must not release an unowned conversation claim"); },
    },
    sleepImpl: async () => { throw new Error("must not sleep"); },
  });

  assert.deepEqual(await workflow(IDS), { status: "already_processing" });
  assert.deepEqual(eventStore.released, [{ eventId: IDS.eventId, connectionId: IDS.connectionId, claimId: "event-claim" }]);
  assert.equal(eventStore.completed.length, 0);
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

test("a retryable Push delivery waits for its persisted retry time and reuses the same outbox delivery", async () => {
  const deliveryCalls = [];
  const sleeps = [];
  const workflow = createLineMessageWorkflow({
    eventStore: claimedEventStore(),
    processingService: {
      acquireClaim: async () => ({ acquired: true, claimId: "conversation-claim", windowStart: START }),
      buildTurn: async () => ({ inboundMessageId: "message-1", customerTexts: ["first"] }),
      decideAndPersist: async () => ({ status: "pending_delivery", deliveryId: "delivery-1" }),
      deliver: async (input) => {
        deliveryCalls.push(input);
        return deliveryCalls.length === 1
          ? { status: "retryable", retryAt: new Date(START.getTime() + 1_000) }
          : { status: "sent" };
      },
      releaseClaim: async () => {}, findFollowUp: async () => null,
    },
    sleepImpl: async (duration) => { sleeps.push(duration); },
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
    completed: [], released: [],
    async claimEventProcessing() { return { claimed: true, claimId: "event-claim" }; },
    async markEventProcessed(input) { this.completed.push(input); return true; },
    async releaseEventProcessing(input) { this.released.push(input); return true; },
  };
}
