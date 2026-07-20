import assert from "node:assert/strict";
import { test } from "node:test";

import { createLineOutboundDeliveryService } from "../src/lib/support/outbox/line-outbound-delivery-service.js";

const DELIVERY_ID = "11111111-1111-4111-8111-111111111111";
const RETRY_KEY = "22222222-2222-4222-8222-222222222222";
const BODY = "{\"to\":\"private-user-id\",\"messages\":[{\"type\":\"text\",\"text\":\"您好\"}]}";
const NOW = new Date("2026-07-20T00:00:00.000Z");

test("timeout and 5xx retry the identical persisted LINE Push body and UUID retry key", async () => {
  const store = createDeliveryStore();
  const calls = [];
  const service = createLineOutboundDeliveryService({
    outboxStore: store,
    sendPush: async (request) => {
      calls.push(request);
      if (calls.length === 1) throw new Error("private network timeout");
      return { status: 503, headers: {} };
    },
    baseRetryDelayMs: 1_000,
  });

  const first = await service.attemptDelivery({ deliveryId: DELIVERY_ID, now: NOW });
  const second = await service.attemptDelivery({ deliveryId: DELIVERY_ID, now: first.retryAt });

  assert.deepEqual(first, { status: "retryable", retryAt: new Date(NOW.getTime() + 1_000) });
  assert.deepEqual(second, { status: "retryable", retryAt: new Date(NOW.getTime() + 3_000) });
  assert.deepEqual(calls, [
    { retryKey: RETRY_KEY, body: BODY },
    { retryKey: RETRY_KEY, body: BODY },
  ]);
  assert.equal(store.attempts.every(({ retryKey, body }) => retryKey === RETRY_KEY && body === BODY), true);
});

test("2xx and 409 with LINE accepted request ID are terminal sent outcomes", async () => {
  for (const response of [
    { status: 200, headers: { "x-line-accepted-request-id": "accepted-200" } },
    { status: 409, headers: { "x-line-accepted-request-id": "accepted-409" } },
  ]) {
    const store = createDeliveryStore();
    const service = createLineOutboundDeliveryService({
      outboxStore: store,
      sendPush: async () => response,
    });

    assert.deepEqual(await service.attemptDelivery({ deliveryId: DELIVERY_ID, now: NOW }), {
      status: "sent",
      acceptedRequestId: response.headers["x-line-accepted-request-id"],
    });
    assert.equal(store.status, "sent");
  }
});

test("other 4xx outcomes are terminal failures without an automatic retry", async () => {
  const store = createDeliveryStore();
  const service = createLineOutboundDeliveryService({
    outboxStore: store,
    sendPush: async () => ({ status: 400, headers: {} }),
  });

  assert.deepEqual(await service.attemptDelivery({ deliveryId: DELIVERY_ID, now: NOW }), { status: "failed" });
  assert.equal(store.status, "failed");
  assert.equal(store.retryableWrites, 0);
});

test("a delivery that remains unknown for 24 hours is marked for human review without a new retry key", async () => {
  const store = createDeliveryStore({ firstAttemptAt: NOW });
  const service = createLineOutboundDeliveryService({
    outboxStore: store,
    sendPush: async () => { throw new Error("must not send after review threshold"); },
  });

  assert.deepEqual(await service.attemptDelivery({
    deliveryId: DELIVERY_ID,
    now: new Date(NOW.getTime() + (24 * 60 * 60 * 1_000) + 1),
  }), { status: "human_review" });
  assert.equal(store.status, "human_review");
  assert.equal(store.retryKey, RETRY_KEY);
});

function createDeliveryStore({ firstAttemptAt = null } = {}) {
  let claimId = null;
  let attemptCount = 0;
  return {
    status: "pending",
    retryKey: RETRY_KEY,
    attempts: [],
    retryableWrites: 0,
    async claimDelivery({ deliveryId, now }) {
      assert.equal(deliveryId, DELIVERY_ID);
      if (firstAttemptAt && now.getTime() - firstAttemptAt.getTime() > 24 * 60 * 60 * 1_000) {
        this.status = "human_review";
        return { claimed: false, status: "human_review" };
      }
      if (this.status !== "pending" && this.status !== "retryable") return { claimed: false, status: this.status };
      attemptCount += 1;
      claimId = `claim-${attemptCount}`;
      this.status = "sending";
      this.attempts.push({ retryKey: RETRY_KEY, body: BODY });
      return { claimed: true, claimId, retryKey: RETRY_KEY, canonicalBody: BODY, attemptCount };
    },
    async markDeliverySent({ claimId: suppliedClaimId }) {
      assert.equal(suppliedClaimId, claimId);
      this.status = "sent";
      return true;
    },
    async markDeliveryRetryable({ claimId: suppliedClaimId }) {
      assert.equal(suppliedClaimId, claimId);
      this.status = "retryable";
      this.retryableWrites += 1;
      return true;
    },
    async markDeliveryFailed({ claimId: suppliedClaimId }) {
      assert.equal(suppliedClaimId, claimId);
      this.status = "failed";
      return true;
    },
  };
}
