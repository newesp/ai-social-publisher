import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";

import { createLineSupportAdapter } from "../src/lib/support/channel-adapters/line-support-adapter.js";
import { hashWebhookKey } from "../src/lib/support/identity-crypto.js";
import { createLineWebhookHandler } from "../src/lib/support/routes/line-webhook-handler.js";
import { lineMessageWorkflow } from "../src/lib/support/workflows/line-message-workflow.js";

const CHANNEL_SECRET = "test-channel-secret";
const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";

test("the workflow shell accepts and returns only safe internal identifiers", async () => {
  const input = {
    eventId: "evt-user-1",
    connectionId: CONNECTION_ID,
    conversationId: "conversation-1",
  };

  assert.deepEqual(await lineMessageWorkflow(input), input);
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
  assert.equal(reads, 1);
  assert.equal(harness.verifiedBodies[0], rawBody);
  assert.equal(harness.store.userEvents.length, 0);
});

test("an invalid signature persists nothing and starts no workflow", async () => {
  const harness = createHarness();
  const response = await harness.handler(unsignedRequest({ events: [userEvent()] }), "opaque-key");

  assert.equal(response.status, 401);
  assert.equal(harness.store.userEvents.length, 0);
  assert.equal(harness.startCalls.length, 0);
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

test("concurrent duplicate deliveries still start exactly one workflow", async () => {
  const harness = createHarness({ store: createConcurrentStore() });
  const responses = await Promise.all([
    harness.handler(signedRequest({ events: [userEvent()] }), "opaque-key"),
    harness.handler(signedRequest({ events: [userEvent()] }), "opaque-key"),
  ]);

  assert.deepEqual(responses.map(({ status }) => status), [200, 200]);
  assert.equal(harness.startCalls.length, 1);
});

function createHarness({ findConnection, store = createStore() } = {}) {
  const verifiedBodies = [];
  const adapter = createLineSupportAdapter({ fetchImpl: async () => new Response("{}") });
  const lineAdapter = {
    verifySignature(input) {
      verifiedBodies.push(input.rawBody);
      return adapter.verifySignature(input);
    },
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
      startWorkflow: async (input) => { startCalls.push(input); },
      respond: (body, init) => Response.json(body, init),
    }),
  };
}

function createStore() {
  const seen = new Set();
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
      return { inserted: true, eventId: input.eventId, conversationId: `conversation-${userEvents.length}` };
    },
    async recordIgnoredEvent(input) {
      const key = `${input.connectionId}:${input.eventId}`;
      if (seen.has(key)) return { inserted: false };
      seen.add(key);
      ignoredEvents.push(input);
      return { inserted: true };
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
