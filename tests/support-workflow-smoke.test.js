import assert from "node:assert/strict";
import test from "node:test";

import { createSupportWorkflowSmokeHandler } from "../src/lib/support/routes/support-workflow-smoke-handler.js";

test("workflow smoke requires owner, same origin, and an explicit feature flag", async () => {
  const calls = [];
  const handler = createSupportWorkflowSmokeHandler({
    requireOwner: async () => "owner@example.com",
    requireSameOrigin: () => calls.push("origin"),
    enabled: true,
    startWorkflow: async (workflow, args) => calls.push([workflow.name, args]),
  });
  const response = await handler(new Request("https://app.example/api/support/workflow-smoke", {
    method: "POST", headers: { origin: "https://app.example" },
  }));
  assert.equal(response.status, 202);
  assert.equal(calls[0], "origin");
  assert.equal(calls[1][1][0].requestId.length > 10, true);
});

test("workflow smoke is unavailable unless the feature flag is exactly enabled", async () => {
  let ownerChecks = 0;
  let originChecks = 0;
  let starts = 0;
  const handler = createSupportWorkflowSmokeHandler({
    requireOwner: async () => { ownerChecks += 1; return "owner@example.com"; },
    requireSameOrigin: () => { originChecks += 1; },
    enabled: false,
    startWorkflow: async () => { starts += 1; },
  });

  const response = await handler(new Request("https://app.example/api/support/workflow-smoke", {
    method: "POST", headers: { origin: "https://app.example" },
  }));

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "Not found." });
  assert.deepEqual({ ownerChecks, originChecks, starts }, { ownerChecks: 0, originChecks: 0, starts: 0 });
});

test("workflow smoke reports only that the workflow started", async () => {
  const handler = createSupportWorkflowSmokeHandler({
    requireOwner: async () => "owner@example.com",
    requireSameOrigin: () => {},
    enabled: true,
    startWorkflow: async () => ({ requestId: "private-workflow-result", status: "ok" }),
  });

  const response = await handler(new Request("https://app.example/api/support/workflow-smoke", {
    method: "POST", headers: { origin: "https://app.example" },
  }));

  const body = await response.json();
  assert.equal(response.status, 202);
  assert.deepEqual(body.status, "started");
  assert.equal(body.requestId.length > 10, true);
  assert.equal(JSON.stringify(body).includes("private-workflow-result"), false);
});
