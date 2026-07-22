import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";

import { createLineSupportAdapter } from "../src/lib/support/channel-adapters/line-support-adapter.js";
import { hashWebhookKey } from "../src/lib/support/identity-crypto.js";
import { createLineWebhookHandler } from "../src/lib/support/routes/line-webhook-handler.js";
import {
  createLineMessageWorkflow,
} from "../src/lib/support/workflows/line-message-workflow.js";

const CHANNEL_SECRET = "test-channel-secret";
const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";

test("the workflow prerequisite passes only safe internal identifiers to its processing hook", async () => {
  const input = {
    eventId: "evt-user-1",
    connectionId: CONNECTION_ID,
    conversationId: "conversation-1",
  };
  const processed = [];
  const workflow = createLineMessageWorkflow({
    eventStore: createWorkflowProcessingStore(),
    processEvent: async (value) => { processed.push(value); },
  });

  assert.deepEqual(await workflow(input), { status: "processed" });
  assert.deepEqual(processed, [input]);
});

test("duplicate durable workflow runs grant one event-processing right and invoke one downstream hook", async () => {
  const store = createWorkflowProcessingStore();
  const processed = [];
  const workflow = createLineMessageWorkflow({
    eventStore: store,
    processEvent: async (input) => { processed.push(input); },
  });
  const input = { eventId: "evt-workflow-1", connectionId: CONNECTION_ID, conversationId: "conversation-1" };

  const results = await Promise.all([workflow(input), workflow(input)]);

  assert.deepEqual(results.map(({ status }) => status).sort(), ["duplicate", "processed"]);
  assert.deepEqual(processed, [input]);
  assert.equal(store.completed, true);
});

test("a failed first durable claim releases for retry and a completed event cannot be processed again", async () => {
  const store = createWorkflowProcessingStore();
  let failuresRemaining = 1;
  const processed = [];
  const workflow = createLineMessageWorkflow({
    eventStore: store,
    processEvent: async (input) => {
      if (failuresRemaining > 0) {
        failuresRemaining -= 1;
        throw new Error("safe controlled failure");
      }
      processed.push(input);
    },
  });
  const input = { eventId: "evt-workflow-retry", connectionId: CONNECTION_ID, conversationId: "conversation-2" };

  await assert.rejects(workflow(input), /safe controlled failure/);
  assert.equal(store.completed, false);
  assert.equal(store.claimed, false);
  assert.equal((await workflow(input)).status, "processed");
  assert.equal((await workflow(input)).status, "duplicate");
  assert.deepEqual(processed, [input]);
});

test("a valid user message persists once and starts one workflow with internal identifiers only", async () => {
  const harness = createHarness();
  const request = signedRequest({ events: [userEvent()] });

  const initialResponse = await harness.handler(request, "opaque-key");
  assert.equal(await initialResponse.text(), '{"ok":true}');
  assert.equal(initialResponse.status, 200);
  assert.equal(harness.store.userEvents.length, 1);
  assert.deepEqual(harness.startCalls, [{
    eventId: "evt-user-1",
    connectionId: CONNECTION_ID,
    conversationId: "conversation-1",
  }]);
  assert.equal(JSON.stringify(harness.startCalls).includes("private-user-id"), false);
  assert.equal(JSON.stringify(harness.startCalls).includes("private reply token"), false);

  assert.equal((await harness.handler(signedRequest({ events: [userEvent()] }), "opaque-key")).status, 200);
  assert.equal(harness.startCalls.length, 1);
});

test("a profile display name is persisted with a verified user event, but a lookup failure is non-blocking", async () => {
  const harness = createHarness({
    findConnection: async () => ({ id: CONNECTION_ID, ownerEmail: "owner@example.com", channelSecret: CHANNEL_SECRET, accessToken: "line-access-token" }),
    lineAdapter: {
      getUserProfile: async () => ({ displayName: "Leo Lin" }),
    },
  });

  assert.equal((await harness.handler(signedRequest({ events: [userEvent()] }), "opaque-key")).status, 200);
  assert.equal(harness.store.userEvents[0].customerDisplayName, "Leo Lin");
});

test("an invalid webhook key reads no body and persists nothing", async () => {
  const harness = createHarness({ findConnection: async () => null });
  const request = signedRequest({ events: [userEvent()] });
  let reads = 0;
  request.text = async () => { reads += 1; return "private body"; };

  const response = await harness.handler(request, "unknown-key");

  assert.equal(response.status, 404);
  assert.equal(reads, 0);
  assert.equal(harness.store.userEvents.length, 0);
  assert.equal(harness.startCalls.length, 0);
});

test("the raw body is read once and verified before any JSON parsing", async () => {
  const harness = createHarness();
  const rawBody = "{ not json";
  const request = signedRawRequest(rawBody);
  let reads = 0;
  request.text = async () => { reads += 1; return rawBody; };

  const response = await harness.handler(request, "opaque-key");

  assert.equal(response.status, 400);
  assert.equal(reads, 0);
  assert.equal(harness.verifiedBodies[0], rawBody);
  assert.equal(harness.store.userEvents.length, 0);
});

test("oversized webhook bodies are rejected before signature verification or persistence", async () => {
  const harness = createHarness();
  const declaredOversized = signedRawRequest("{}");
  declaredOversized.headers.set("content-length", "1000001");
  let reads = 0;
  declaredOversized.text = async () => { reads += 1; return "{}"; };

  assert.equal((await harness.handler(declaredOversized, "opaque-key")).status, 413);
  assert.equal(reads, 0);

  const actualOversized = signedRawRequest("x".repeat(1_000_001));
  assert.equal((await harness.handler(actualOversized, "opaque-key")).status, 413);
  assert.equal(harness.verifiedBodies.length, 0);
  assert.equal(harness.store.userEvents.length, 0);
});

test("verified webhook deliveries cap the number of events processed", async () => {
  const harness = createHarness();
  const events = Array.from({ length: 101 }, (_, index) => userEvent({ webhookEventId: `evt-${index}` }));

  assert.equal((await harness.handler(signedRequest({ events }), "opaque-key")).status, 400);
  assert.equal(harness.store.userEvents.length, 0);
  assert.equal(harness.startCalls.length, 0);
});

test("an invalid signature persists nothing and starts no workflow", async () => {
  const harness = createHarness();
  const response = await harness.handler(unsignedRequest({ events: [userEvent()] }), "opaque-key");

  assert.equal(response.status, 401);
  assert.equal(harness.store.userEvents.length, 0);
  assert.equal(harness.startCalls.length, 0);
});

test("a verified event with an unusable Unix-millisecond timestamp is rejected before persistence", async () => {
  const harness = createHarness();
  const response = await harness.handler(signedRequest({
    events: [userEvent({ timestamp: 100_000_000_000_000_000_000 })],
  }), "opaque-key");

  assert.equal(response.status, 400);
  assert.equal(harness.store.userEvents.length, 0);
  assert.equal(harness.startCalls.length, 0);
});

test("LINE timestamps require positive safe Unix milliseconds within the Date range", async () => {
  const maximumUnixMilliseconds = 8_640_000_000_000_000;
  const valid = createHarness();
  assert.equal((await valid.handler(signedRequest({
    events: [userEvent({ timestamp: maximumUnixMilliseconds })],
  }), "opaque-key")).status, 200);

  for (const timestamp of [0, -1, 1.5, maximumUnixMilliseconds + 1]) {
    const harness = createHarness();
    const response = await harness.handler(signedRequest({ events: [userEvent({ timestamp })] }), "opaque-key");
    assert.equal(response.status, 400);
    assert.equal(harness.store.userEvents.length, 0);
  }
});

test("a verified malformed payload and an empty verification event list have fixed responses", async () => {
  const harness = createHarness();

  assert.equal((await harness.handler(signedRawRequest("{ nope"), "opaque-key")).status, 400);
  assert.equal((await harness.handler(signedRequest({ events: [] }), "opaque-key")).status, 200);
  assert.equal(harness.store.userEvents.length, 0);
  assert.equal(harness.startCalls.length, 0);
});

test("group and room events are recorded only as ignored safe identities", async () => {
  const harness = createHarness();
  const group = {
    ...userEvent({ webhookEventId: "evt-group-1" }),
    source: { type: "group", groupId: "private group", userId: "private user" },
  };
  const room = {
    ...userEvent({ webhookEventId: "evt-room-1" }),
    source: { type: "room", roomId: "private room", userId: "private user" },
  };

  assert.equal((await harness.handler(signedRequest({ events: [group, room] }), "opaque-key")).status, 200);
  assert.deepEqual(harness.store.ignoredEvents, [
    { connectionId: CONNECTION_ID, eventId: "evt-group-1", sourceType: "group" },
    { connectionId: CONNECTION_ID, eventId: "evt-room-1", sourceType: "room" },
  ]);
  assert.equal(JSON.stringify(harness.store.ignoredEvents).includes("private"), false);
  assert.equal(harness.startCalls.length, 0);
});

test("non-message user events are deduplicated without creating support conversations", async () => {
  const harness = createHarness();
  const follow = {
    type: "follow",
    webhookEventId: "evt-follow-1",
    timestamp: 1_784_332_800_000,
    source: { type: "user", userId: "private-user-id" },
  };

  assert.equal((await harness.handler(signedRequest({ events: [follow] }), "opaque-key")).status, 200);
  assert.deepEqual(harness.store.ignoredEvents, [{
    connectionId: CONNECTION_ID,
    eventId: "evt-follow-1",
    sourceType: "user_event",
  }]);
  assert.equal(harness.store.userEvents.length, 0);
  assert.equal(harness.startCalls.length, 0);
});

test("text and non-text user events persist their safe message forms and non-text is handoff compatible", async () => {
  const harness = createHarness();
  const text = userEvent();
  const image = userEvent({
    webhookEventId: "evt-image-1",
    replyToken: "second private reply token",
    message: { id: "line-message-2", type: "image", contentProvider: { type: "line" } },
  });

  assert.equal((await harness.handler(signedRequest({ events: [text, image] }), "opaque-key")).status, 200);
  assert.deepEqual(harness.store.userEvents.map(({ message }) => message), [
    { type: "text", text: "private message text", safeMetadata: {} },
    { type: "image", text: null, safeMetadata: { type: "image" }, handoffReasonCode: "non_text" },
  ]);
  assert.equal(harness.startCalls.length, 2);
});

test("persistence failures are bounded and never expose the provider body or start a workflow", async () => {
  const harness = createHarness({
    store: {
      async ingestUserEvent() { throw new Error("private database/provider body"); },
      async recordIgnoredEvent() { throw new Error("private database/provider body"); },
    },
  });
  const response = await harness.handler(signedRequest({ events: [userEvent()] }), "opaque-key");

  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, "Webhook ingestion is temporarily unavailable.");
  assert.equal(harness.startCalls.length, 0);
});

test("a redelivery retries a persisted event after workflow start failure without duplicating persistence", async () => {
  let failuresRemaining = 1;
  const harness = createHarness({
    startWorkflow: async () => {
      if (failuresRemaining > 0) {
        failuresRemaining -= 1;
        throw new Error("temporary workflow outage");
      }
    },
  });

  const first = await harness.handler(signedRequest({ events: [userEvent()] }), "opaque-key");
  const second = await harness.handler(signedRequest({ events: [userEvent()] }), "opaque-key");

  assert.equal(first.status, 503);
  assert.equal(second.status, 200);
  assert.equal(harness.store.userEvents.length, 1);
  assert.equal(harness.startCalls.length, 2);
});

test("a dispatch completion persistence failure is returned as a bounded retryable response", async () => {
  const store = createStore();
  store.markWorkflowDispatched = async () => false;
  const harness = createHarness({ store });

  const response = await harness.handler(signedRequest({ events: [userEvent()] }), "opaque-key");

  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, "Webhook ingestion is temporarily unavailable.");
  assert.equal(harness.startCalls.length, 1);
});

test("concurrent redeliveries claim a retryable event for only one workflow start", async () => {
  let failuresRemaining = 1;
  const harness = createHarness({
    startWorkflow: async () => {
      if (failuresRemaining > 0) {
        failuresRemaining -= 1;
        throw new Error("temporary workflow outage");
      }
    },
  });
  assert.equal((await harness.handler(signedRequest({ events: [userEvent()] }), "opaque-key")).status, 503);

  const responses = await Promise.all([
    harness.handler(signedRequest({ events: [userEvent()] }), "opaque-key"),
    harness.handler(signedRequest({ events: [userEvent()] }), "opaque-key"),
  ]);

  assert.deepEqual(responses.map(({ status }) => status), [200, 200]);
  assert.equal(harness.startCalls.length, 2);
});

test("concurrent duplicate deliveries still start exactly one workflow", async () => {
  const harness = createHarness({ store: createConcurrentStore() });
  const responses = await Promise.all([
    harness.handler(signedRequest({ events: [userEvent()] }), "opaque-key"),
    harness.handler(signedRequest({ events: [userEvent()] }), "opaque-key"),
  ]);

  assert.deepEqual(responses.map(({ status }) => status), [200, 200]);
  assert.equal(harness.startCalls.length, 1);
});

function createHarness({ findConnection, store = createStore(), startWorkflow, lineAdapter: extraLineAdapter } = {}) {
  const verifiedBodies = [];
  const adapter = createLineSupportAdapter({ fetchImpl: async () => new Response("{}") });
  const lineAdapter = {
    verifySignature(input) {
      verifiedBodies.push(input.rawBody);
      return adapter.verifySignature(input);
    },
    ...extraLineAdapter,
  };
  const startCalls = [];
  return {
    store,
    startCalls,
    verifiedBodies,
    handler: createLineWebhookHandler({
      findConnection: findConnection ?? (async (keyHash) => keyHash === hashWebhookKey("opaque-key")
        ? { id: CONNECTION_ID, ownerEmail: "owner@example.com", channelSecret: CHANNEL_SECRET }
        : null),
      lineAdapter,
      eventStore: store,
      startWorkflow: async (input) => {
        startCalls.push(input);
        return startWorkflow?.(input);
      },
      respond: (body, init) => Response.json(body, init),
    }),
  };
}

function createStore() {
  const seen = new Set();
  const dispatches = new Map();
  const userEvents = [];
  const ignoredEvents = [];
  return {
    userEvents,
    ignoredEvents,
    async ingestUserEvent(input) {
      const key = `${input.connectionId}:${input.eventId}`;
      if (seen.has(key)) return { inserted: false };
      seen.add(key);
      userEvents.push(input);
      dispatches.set(key, { state: "queued", conversationId: `conversation-${userEvents.length}` });
      return { inserted: true, eventId: input.eventId, conversationId: `conversation-${userEvents.length}` };
    },
    async recordIgnoredEvent(input) {
      const key = `${input.connectionId}:${input.eventId}`;
      if (seen.has(key)) return { inserted: false };
      seen.add(key);
      ignoredEvents.push(input);
      return { inserted: true };
    },
    async claimWorkflowDispatch({ connectionId, eventId }) {
      const dispatch = dispatches.get(`${connectionId}:${eventId}`);
      if (!dispatch || dispatch.state === "dispatching" || dispatch.state === "dispatched") {
        return { claimed: false };
      }
      dispatch.state = "dispatching";
      dispatch.claimId = `claim-${eventId}`;
      return { claimed: true, eventId, connectionId, conversationId: dispatch.conversationId, claimId: dispatch.claimId };
    },
    async markWorkflowDispatched({ connectionId, eventId, claimId }) {
      const dispatch = dispatches.get(`${connectionId}:${eventId}`);
      if (dispatch?.claimId === claimId) {
        dispatch.state = "dispatched";
        return true;
      }
      return false;
    },
    async releaseWorkflowDispatch({ connectionId, eventId, claimId }) {
      const dispatch = dispatches.get(`${connectionId}:${eventId}`);
      if (dispatch?.claimId === claimId) dispatch.state = "retryable";
    },
  };
}

function createConcurrentStore() {
  const store = createStore();
  let locked = false;
  return {
    ...store,
    async ingestUserEvent(input) {
      if (locked) return { inserted: false };
      locked = true;
      await new Promise((resolve) => setTimeout(resolve, 1));
      return store.ingestUserEvent(input);
    },
  };
}

function createWorkflowProcessingStore() {
  let claimed = false;
  let completed = false;
  let claimId = null;
  return {
    get claimed() { return claimed; },
    get completed() { return completed; },
    async claimEventProcessing(input) {
      if (claimed || completed) return { claimed: false };
      claimed = true;
      claimId = `processing-${input.eventId}`;
      return { claimed: true, claimId };
    },
    async markEventProcessed({ claimId: suppliedClaimId }) {
      if (!claimed || suppliedClaimId !== claimId) return false;
      completed = true;
      claimed = false;
      return true;
    },
    async releaseEventProcessing({ claimId: suppliedClaimId }) {
      if (!claimed || suppliedClaimId !== claimId) return false;
      claimed = false;
      return true;
    },
  };
}

function userEvent(overrides = {}) {
  return {
    type: "message",
    webhookEventId: "evt-user-1",
    replyToken: "private reply token",
    timestamp: 1_784_332_800_000,
    source: { type: "user", userId: "private-user-id" },
    message: { id: "line-message-1", type: "text", text: "private message text" },
    ...overrides,
  };
}

function signedRequest(payload) {
  return signedRawRequest(JSON.stringify(payload));
}

function unsignedRequest(payload) {
  return new Request("https://app.example/api/webhooks/line/opaque-key", {
    method: "POST",
    headers: { "x-line-signature": "invalid" },
    body: JSON.stringify(payload),
  });
}

function signedRawRequest(rawBody) {
  return new Request("https://app.example/api/webhooks/line/opaque-key", {
    method: "POST",
    headers: {
      "x-line-signature": crypto.createHmac("sha256", CHANNEL_SECRET).update(rawBody, "utf8").digest("base64"),
    },
    body: rawBody,
  });
}
