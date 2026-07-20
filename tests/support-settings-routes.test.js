import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { requireSameOrigin } from "../src/lib/platform-connections/platform-connection-route-handlers.js";
import { routeErrorResponse } from "../src/lib/auth/route-guards.js";
import { createSupportSettingsRouteHandlers } from "../src/lib/support/routes/support-settings-route-handlers.js";

test("configuration and FAQ handlers pass only the authenticated owner to lazy store operations", async () => {
  const calls = [];
  const store = {
    async getConfiguration(owner) { calls.push(["getConfiguration", owner]); return { brandName: "Acme" }; },
    async updateConfigurationForActiveDefault(owner, body) {
      calls.push(["updateConfigurationForActiveDefault", owner, body]);
      return { brandName: body.brandName };
    },
    async listFaqs(owner) { calls.push(["listFaqs", owner]); return []; },
    async createFaq(owner, body) { calls.push(["createFaq", owner, body]); return { id: "faq-1", ...body }; },
    async updateFaq(owner, id, body) { calls.push(["updateFaq", owner, id, body]); return { id, ...body }; },
    async deleteFaq(owner, id) { calls.push(["deleteFaq", owner, id]); return { id }; },
  };
  const handlers = createSupportSettingsRouteHandlers({
    requireOwner: async () => "owner@example.com",
    requireSameOrigin: () => calls.push(["origin"]),
    getStore: async () => { calls.push(["store"]); return store; },
  });

  await handlers.getConfiguration();
  await handlers.updateConfiguration(jsonRequest("PUT", { brandName: "Updated" }));
  await handlers.listFaqs();
  await handlers.createFaq(jsonRequest("POST", { question: "Q", answer: "A" }));
  await handlers.updateFaq(jsonRequest("PATCH", { answer: "Updated" }), "faq-1");
  const deleted = await handlers.deleteFaq(jsonRequest("DELETE"), "faq-1");

  assert.equal(deleted.status, 204);
  assert.deepEqual(calls, [
    ["store"], ["getConfiguration", "owner@example.com"],
    ["origin"], ["store"], ["updateConfigurationForActiveDefault", "owner@example.com", { brandName: "Updated" }],
    ["store"], ["listFaqs", "owner@example.com"],
    ["origin"], ["store"], ["createFaq", "owner@example.com", { question: "Q", answer: "A" }],
    ["origin"], ["store"], ["updateFaq", "owner@example.com", "faq-1", { answer: "Updated" }],
    ["origin"], ["store"], ["deleteFaq", "owner@example.com", "faq-1"],
  ]);
});

test("configuration responses and writes use only the browser allowlist", async () => {
  const writes = [];
  const internalConfiguration = {
    id: "configuration-1",
    ownerEmail: "owner@example.com",
    platformConnectionId: "connection-1",
    brandName: "Acme",
    assistantName: "Ada",
    replyTone: "friendly",
    llmProvider: "google",
    llmModel: "gemini-3.1-flash-lite",
    redeliveryAcknowledged: true,
    nativeRepliesDisabledAcknowledged: true,
    supportState: "enabled",
    webhookVerified: true,
    providerTested: true,
    webhookKeyHash: "private-hash",
    version: 7,
    createdAt: new Date("2026-07-19T00:00:00.000Z"),
    updatedAt: new Date("2026-07-19T00:00:00.000Z"),
  };
  const browserInput = {
    brandName: "Updated",
    assistantName: "Ada",
    replyTone: "professional",
    llmProvider: "openai",
    llmModel: "gpt-4o",
    redeliveryAcknowledged: true,
    nativeRepliesDisabledAcknowledged: true,
  };
  const handlers = createSupportSettingsRouteHandlers({
    requireOwner: async () => "owner@example.com",
    requireSameOrigin: () => {},
    getStore: async () => ({
      async getConfiguration() {
        return internalConfiguration;
      },
      async updateConfigurationForActiveDefault(owner, input) {
        writes.push([owner, input]);
        return { ...internalConfiguration, ...input };
      },
    }),
  });

  const loaded = await handlers.getConfiguration();
  assert.deepEqual(await loaded.json(), {
    configuration: {
      brandName: "Acme",
      assistantName: "Ada",
      replyTone: "friendly",
      llmProvider: "google",
      llmModel: "gemini-3.1-flash-lite",
      redeliveryAcknowledged: true,
      nativeRepliesDisabledAcknowledged: true,
    },
  });

  const updated = await handlers.updateConfiguration(jsonRequest("PUT", browserInput));
  assert.deepEqual(await updated.json(), {
    configuration: browserInput,
  });
  assert.deepEqual(writes, [["owner@example.com", browserInput]]);
});

test("every mutation rejects cross-origin requests before lazy store initialization", async () => {
  let stores = 0;
  const handlers = createSupportSettingsRouteHandlers({
    requireOwner: async () => "owner@example.com",
    requireSameOrigin,
    getStore: async () => { stores += 1; return {}; },
  });
  const mutationCalls = [
    () => handlers.updateConfiguration(crossOriginRequest("PUT", {})),
    () => handlers.createFaq(crossOriginRequest("POST", {})),
    () => handlers.updateFaq(crossOriginRequest("PUT", {}), "faq-1"),
    () => handlers.updateFaq(crossOriginRequest("PATCH", {}), "faq-1"),
    () => handlers.deleteFaq(crossOriginRequest("DELETE"), "faq-1"),
  ];

  for (const call of mutationCalls) {
    await assert.rejects(call(), (error) => error.status === 403);
  }
  assert.equal(stores, 0);
});

test("authentication runs before same-origin checks and service initialization", async () => {
  const calls = [];
  const handlers = createSupportSettingsRouteHandlers({
    requireOwner: async () => {
      calls.push("owner");
      const error = new Error("Authentication is required.");
      error.status = 401;
      throw error;
    },
    requireSameOrigin: () => calls.push("origin"),
    getStore: async () => { calls.push("store"); return {}; },
  });

  await assert.rejects(handlers.createFaq(jsonRequest("POST", {})), (error) => error.status === 401);
  assert.deepEqual(calls, ["owner"]);
});

test("malformed JSON is a safe 400 without calling the store method", async () => {
  let called = false;
  const handlers = createSupportSettingsRouteHandlers({
    requireOwner: async () => "owner@example.com",
    requireSameOrigin: () => {},
    getStore: async () => ({
      async createFaq() {
        called = true;
      },
    }),
  });
  const request = new Request("http://localhost/api/support/faqs", {
    method: "POST",
    headers: { origin: "http://localhost", "content-type": "application/json" },
    body: "{",
  });

  await assert.rejects(handlers.createFaq(request), (error) => (
    error.status === 400 && error.message === "A JSON request body is required."
  ));
  assert.equal(called, false);
});

test("unexpected support failures return a generic 500 without owner or credential data", async () => {
  const response = routeErrorResponse(
    new Error("failed for owner@example.com with encrypted-credential"),
    { json: (body, init) => Response.json(body, init) },
  );

  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "Request failed." });
});

test("support validation failures remain safe 400 responses", async () => {
  const error = new Error("FAQ enabled must be a boolean.");
  error.status = 400;
  const response = routeErrorResponse(error, {
    json: (body, init) => Response.json(body, init),
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "FAQ enabled must be a boolean." });
});

test("thin support routes use settings access, generic error responses, and lazy store creation", async () => {
  const sources = await Promise.all([
    routeSource("../src/app/api/support/configuration/route.js"),
    routeSource("../src/app/api/support/faqs/route.js"),
    routeSource("../src/app/api/support/faqs/[id]/route.js"),
  ]);

  for (const source of sources) {
    assert.match(source, /requireSettingsAccess/);
    assert.match(source, /routeErrorResponse/);
    assert.match(source, /getStore:\s*getSupportStore/);
    assert.doesNotMatch(source, /getSupportStore\(\)/);
  }
});

function jsonRequest(method, body) {
  return new Request("http://localhost/api/support/faqs", {
    method,
    headers: { origin: "http://localhost", "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function crossOriginRequest(method, body) {
  return new Request("http://localhost/api/support/faqs", {
    method,
    headers: { origin: "https://attacker.example", "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function routeSource(path) {
  return readFile(new URL(path, import.meta.url), "utf8");
}
