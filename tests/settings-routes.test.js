import assert from "node:assert/strict";
import { test } from "node:test";

import { createSettingsRouteHandlers } from "../src/lib/settings/settings-route-handlers.js";
import { createGenerateRouteHandler } from "../src/lib/settings/generate-route-handler.js";

test("settings routes pass the session-derived owner to every store operation", async () => {
  const calls = [];
  const handlers = createSettingsRouteHandlers({
    requireOwner: async () => "owner@example.com",
    store: {
      async getMasked(ownerEmail) {
        calls.push(["getMasked", ownerEmail]);
        return { googleAiApiKey: "goo...ret" };
      },
      async update(ownerEmail, updates) {
        calls.push(["update", ownerEmail, updates]);
        return { googleAiApiKey: "google-secret" };
      },
    },
  });

  await handlers.GET();
  await handlers.PUT(new Request("http://localhost/api/settings", {
    method: "PUT",
    body: JSON.stringify({ googleAiApiKey: "new-google-secret" }),
  }));

  assert.deepEqual(calls, [
    ["getMasked", "owner@example.com"],
    ["update", "owner@example.com", { googleAiApiKey: "new-google-secret" }],
    ["getMasked", "owner@example.com"],
  ]);
});

test("generate route reads settings only for the session-derived owner", async () => {
  const calls = [];
  const handler = createGenerateRouteHandler({
    requireOwner: async () => "owner@example.com",
    store: {
      async read(ownerEmail) {
        calls.push(ownerEmail);
        return { googleAiApiKey: "owner-google-secret" };
      },
    },
    buildResponse: async ({ settings }) => ({ usedApiKey: settings.googleAiApiKey }),
  });

  const response = await handler(new Request("http://localhost/api/generate", {
    method: "POST",
    body: JSON.stringify({ productName: "Test" }),
  }));

  assert.equal((await response.json()).usedApiKey, "owner-google-secret");
  assert.deepEqual(calls, ["owner@example.com"]);
});

test("generate route rethrows unexpected failures for the outer generic error handler", async () => {
  const handler = createGenerateRouteHandler({
    requireOwner: async () => "owner@example.com",
    store: {
      async read() {
        return { googleAiApiKey: "owner-google-secret" };
      },
    },
    buildResponse: async () => {
      throw new Error("provider failed with owner-token");
    },
  });

  await assert.rejects(
    handler(new Request("http://localhost/api/generate", {
      method: "POST",
      body: JSON.stringify({ productName: "Test" }),
    })),
    /provider failed with owner-token/,
  );
});

test("settings handlers create the database-backed store only after the owner is authenticated", async () => {
  const calls = [];
  const handlers = createSettingsRouteHandlers({
    requireOwner: async () => {
      calls.push("owner");
      return "owner@example.com";
    },
    getStore: async () => {
      calls.push("store");
      return {
        async getMasked() {
          calls.push("read");
          return {};
        },
      };
    },
  });

  await handlers.GET();

  assert.deepEqual(calls, ["owner", "store", "read"]);
});
