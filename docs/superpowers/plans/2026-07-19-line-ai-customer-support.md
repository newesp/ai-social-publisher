# LINE AI Customer Support MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add owner-scoped LINE AI customer support with FAQ-grounded replies, durable Vercel Workflow processing, automatic handoff, an in-app human inbox, and undoable state transitions.

**Architecture:** Keep support as a bounded module in the existing Next.js application. Public LINE webhooks resolve an opaque connection key, verify the untouched request body, persist an idempotent event, and start a Workflow using internal IDs only; Workflow steps load protected data, batch messages, retrieve FAQs, request a structured decision from the owner-selected Gemini or OpenAI model, and deliver through a LINE channel adapter. Authenticated support APIs and UI remain scoped by normalized `ownerEmail`.

**Tech Stack:** Next.js App Router and React, Mantine, NextAuth, Drizzle ORM with Turso/libSQL, Node `crypto`, existing Gemini/OpenAI services, LINE Messaging API, Vercel Workflow SDK, Node built-in test runner.

## Global Constraints

- The MVP remains personal-tenant only: every authenticated repository operation is scoped by normalized `ownerEmail` and the selected connection or conversation ID.
- Only one-to-one LINE text receives AI interpretation. Group/multi-person content is ignored; non-text one-to-one events retain safe metadata and hand off.
- The selected LLM provider is `google` or `openai`; the selected model must come from `getLLMModelOptions(provider)`.
- AI replies require evidence from at most five enabled FAQ records. Missing or invalid evidence hands off.
- Automatic handoff covers explicit human requests, refund/payment/personal-data risk, insufficient knowledge, non-text input, exhausted LLM retries, and ten AI turns per customer per five minutes.
- Workflow arguments contain internal event, connection, conversation, or transition IDs only. They never contain raw message text, LINE user IDs, credentials, Channel Secrets, access tokens, or reply tokens.
- Store LINE user IDs and reply tokens with existing AES-256-GCM helpers; use a domain-separated keyed HMAC for customer lookup and SHA-256 for high-entropy webhook-key lookup.
- Message text retention is 30 days. Never store chain-of-thought, unrestricted provider responses, raw provider error bodies, or secrets in logs.
- Automated replies prefer LINE Reply API; human messages and safe reply-token fallback use Push API with a stable `X-Line-Retry-Key`.
- Return-to-AI and resolve are server-side ten-second transitions. Navigation, refresh, and other conversations cannot cancel them; a new inbound message cancels only the same conversation's pending transition.
- Browser polling is 15 seconds only while visible. No Redis, realtime sockets, vector database, attachments preview, organization roles, or Meta DM implementation belongs in this MVP.
- No live LINE, LLM, Turso production migration, Workflow deployment, or real-message test runs without explicit authorization for the exact test resource and action.
- The Vercel Hobby validation remains personal and non-commercial. Reassess quotas and terms before commercial operation.

## File Structure

- `src/lib/support/identity-crypto.js`: customer HMAC, encrypted external identifier, reply-token encryption, and webhook-key hashing.
- `src/lib/support/support-repository.js`: all support tables, owner-scoped reads, idempotent writes, claims, transitions, and retention queries.
- `src/lib/support/support-store.js`: input validation and safe domain objects over the repository.
- `src/lib/support/knowledge/faq-retrieval.js`: deterministic manual FAQ retrieval.
- `src/lib/support/decisions/support-decision-service.js`: fixed safety prompt, structured-output validation, handoff rules, and bounded provider retries.
- `src/lib/support/channel-adapters/line-support-adapter.js`: LINE signature, webhook setup/test, Reply, and Push operations.
- `src/lib/support/workflows/*.js`: smoke, inbound conversation, and delayed-transition Workflows and steps.
- `src/lib/support/routes/*.js`: authenticated settings/inbox handlers and the public webhook handler.
- `src/app/api/support/**/route.js`, `src/app/api/webhooks/line/[webhookKey]/route.js`: thin Next.js adapters.
- `src/app/support/page.js`, `src/components/support/*.js`: settings, FAQ editor, queue, thread, drawer, composer, and global undo UI.
- `drizzle/0004_line_ai_customer_support.sql`, `src/lib/db/schema.js`: support tables, constraints, and indexes.
- `scripts/apply-support-schema.mjs`: explicit backup-gated migration and verification.
- `tests/support-*.test.js`: isolated domain, repository, route, Workflow, and source-level UI tests.

## Milestone 1 — Safe Foundation and Configuration

### Task 1: Prove the Workflow SDK with a side-effect-free smoke

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `next.config.js`
- Modify: `.env.example`
- Create: `src/lib/support/workflows/support-workflow-smoke.js`
- Create: `src/lib/support/routes/support-workflow-smoke-handler.js`
- Create: `src/app/api/support/workflow-smoke/route.js`
- Test: `tests/support-workflow-smoke.test.js`

**Interfaces:**
- Produces `supportWorkflowSmoke({ requestId }) -> { requestId, status: "ok" }`.
- Produces `createSupportWorkflowSmokeHandler({ requireOwner, requireSameOrigin, startWorkflow, enabled })`.
- The route returns `202 { requestId, status: "started" }` and exposes no Workflow result.

- [ ] **Step 1: Write the failing smoke-handler tests**

```js
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
```

- [ ] **Step 2: Run the focused test and verify the missing module failure**

Run: `node --test tests/support-workflow-smoke.test.js`

Expected: FAIL because `support-workflow-smoke-handler.js` does not exist.

- [ ] **Step 3: Install and configure Workflow SDK**

Run: `npm install workflow`

Expected: `workflow` is recorded in `package.json` and `package-lock.json`.

```js
import { withWorkflow } from "workflow/next";

const nextConfig = {};

export default withWorkflow(nextConfig);
```

Add `SUPPORT_WORKFLOW_SMOKE_ENABLED=false` to `.env.example`. The handler returns `404` unless its value is exactly `true`.

- [ ] **Step 4: Implement the harmless Workflow and protected trigger**

```js
export async function supportWorkflowSmoke({ requestId }) {
  "use workflow";
  return runSmokeStep(requestId);
}

async function runSmokeStep(requestId) {
  "use step";
  return { requestId, status: "ok" };
}
```

The Next.js route imports `start` from `workflow/api`, requires `requireSettingsAccess()`, applies `requireSameOrigin(request)`, and calls `await start(supportWorkflowSmoke, [{ requestId }])`.

- [ ] **Step 5: Run local verification**

Run: `node --test tests/support-workflow-smoke.test.js && npm test && npm run build`

Expected: focused and full tests PASS; Next.js build recognizes the Workflow directives.

- [ ] **Step 6: Commit the local smoke**

```bash
git add package.json package-lock.json next.config.js .env.example src/lib/support/workflows/support-workflow-smoke.js src/lib/support/routes/support-workflow-smoke-handler.js src/app/api/support/workflow-smoke/route.js tests/support-workflow-smoke.test.js
git commit -m "chore: add support workflow smoke"
```

- [ ] **Step 7: Stop at the external verification gate**

After explicit deployment authorization, set `SUPPORT_WORKFLOW_SMOKE_ENABLED=true`, deploy, trigger once, confirm the run and step in Vercel Workflows, inject one controlled retryable step failure, inspect usage, then set the flag back to `false`. Do not begin LINE or LLM side effects until this gate passes.

### Task 2: Add the support schema and verified migration

**Files:**
- Create: `drizzle/0004_line_ai_customer_support.sql`
- Modify: `drizzle/meta/_journal.json`
- Modify: `src/lib/db/schema.js`
- Create: `scripts/apply-support-schema.mjs`
- Modify: `package.json`
- Test: `tests/support-schema.test.js`
- Test: `tests/support-migration-entrypoint.test.js`

**Interfaces:**
- Exports `supportConfigurations`, `supportFaqs`, `supportConversations`, `supportMessages`, `supportAiDecisions`, `supportWebhookEvents`, and `supportConversationTransitions`.
- Produces `runSupportSchemaMigration({ directExecution, env, migrateSchema })`.

- [ ] **Step 1: Write failing schema and migration-entrypoint tests**

```js
test("support migration creates tenant, idempotency, claim, and transition indexes", async () => {
  const sql = await readFile("drizzle/0004_line_ai_customer_support.sql", "utf8");
  for (const name of [
    "support_configurations_connection_unique",
    "support_faqs_owner_enabled_idx",
    "support_conversations_owner_status_updated_idx",
    "support_conversations_customer_unique",
    "support_messages_conversation_created_idx",
    "support_messages_idempotency_unique",
    "support_webhook_events_connection_event_unique",
    "support_transitions_conversation_created_idx",
  ]) assert.match(sql, new RegExp(name));
});
```

- [ ] **Step 2: Run tests and confirm missing migration failure**

Run: `node --test tests/support-schema.test.js tests/support-migration-entrypoint.test.js`

Expected: FAIL because migration `0004` and its entrypoint do not exist.

- [ ] **Step 3: Add exact table fields and constraints**

Use text UUID primary keys for all support tables. Include these non-obvious fields:

```js
supportConfigurations: {
  ownerEmail, platformConnectionId, brandName, assistantName, replyTone,
  llmProvider, llmModel, supportState, webhookKeyHash, webhookVerifiedAt,
  redeliveryAcknowledgedAt, nativeRepliesDisabledAcknowledgedAt,
  providerTestedAt, version, createdAt, updatedAt
}
supportConversations: {
  ownerEmail, platformConnectionId, platform, customerLookupKey,
  encryptedCustomerExternalId, status, handoffReasonCode, unreadCount,
  pendingTransitionId,
  pendingAction, pendingActionEffectiveAt, processingClaimId,
  processingClaimExpiresAt, version, lastInboundAt, lastOutboundAt,
  createdAt, updatedAt
}
supportMessages: {
  conversationId, direction, senderType, messageType, textContent,
  safeMetadataJson, providerMessageId, deliveryStatus, idempotencyKey,
  sentAt, failedAt, safeErrorCode, processedAt, createdAt
}
```

`supportWebhookEvents` contains connection/event IDs, source type, processing status, encrypted reply token, safe error code, and timestamps. `supportAiDecisions` contains action, category, reason code, answer message, FAQ IDs JSON, provider/model, prompt version, token usage, and latency. `supportConversationTransitions` contains the expected version and all requested/effective/cancelled/committed timestamps.

- [ ] **Step 4: Implement backup-gated migration verification**

`apply-support-schema.mjs` requires `SUPPORT_MIGRATION_BACKUP_CONFIRMED=YES`, `TURSO_DATABASE_URL`, and `TURSO_AUTH_TOKEN`; it runs Drizzle migration, verifies all seven tables and named indexes, and rejects duplicate active customer rows.

- [ ] **Step 5: Run schema verification**

Run: `node --test tests/support-schema.test.js tests/support-migration-entrypoint.test.js && npm test`

Expected: PASS; direct execution without backup acknowledgement fails before opening a database.

- [ ] **Step 6: Commit**

```bash
git add drizzle src/lib/db/schema.js scripts/apply-support-schema.mjs package.json tests/support-schema.test.js tests/support-migration-entrypoint.test.js
git commit -m "feat: add LINE support database schema"
```

### Task 3: Implement owner-scoped support configuration and FAQ storage

**Files:**
- Create: `src/lib/support/identity-crypto.js`
- Create: `src/lib/support/support-repository.js`
- Create: `src/lib/support/support-store.js`
- Create: `src/lib/support/routes/support-settings-route-handlers.js`
- Create: `src/app/api/support/configuration/route.js`
- Create: `src/app/api/support/faqs/route.js`
- Create: `src/app/api/support/faqs/[id]/route.js`
- Test: `tests/support-identity-crypto.test.js`
- Test: `tests/support-repository.test.js`
- Test: `tests/support-store.test.js`
- Test: `tests/support-settings-routes.test.js`

**Interfaces:**
- `createSupportRepository(db)` exposes configuration, FAQ, conversation, message, event, decision, claim, transition, and cleanup methods; every authenticated method accepts `ownerEmail` first.
- `createSupportStore({ repository, encryptionKey, modelOptions })` exposes `getConfiguration`, `updateConfiguration`, `listFaqs`, `createFaq`, `updateFaq`, and `deleteFaq`.
- `hashWebhookKey(key)`, `customerLookupKey(connectionId, externalId, encryptionKey)`, `encryptExternalId`, and `decryptExternalId`.

- [ ] **Step 1: Write failing owner-isolation, crypto, and CRUD tests**

```js
test("FAQ mutation requires both owner and FAQ id", async () => {
  await store.createFaq("owner@example.com", { question: "Q", answer: "A", category: "general", keywords: ["q"] });
  await assert.rejects(
    store.updateFaq("other@example.com", faq.id, { answer: "stolen" }),
    (error) => error.status === 404,
  );
});

test("customer lookup is stable but external identifiers are encrypted", () => {
  assert.equal(customerLookupKey("line-1", "U123", key), customerLookupKey("line-1", "U123", key));
  assert.notEqual(customerLookupKey("line-2", "U123", key), customerLookupKey("line-1", "U123", key));
  assert.equal(encryptExternalId("U123", key).includes("U123"), false);
});
```

- [ ] **Step 2: Run focused tests and verify missing module failures**

Run: `node --test tests/support-identity-crypto.test.js tests/support-repository.test.js tests/support-store.test.js tests/support-settings-routes.test.js`

Expected: FAIL resolving the new support modules.

- [ ] **Step 3: Implement validation and safe domain output**

Configuration accepts only:

```js
{
  platformConnectionId: "uuid",
  brandName: "1..80 chars",
  assistantName: "1..40 chars",
  replyTone: "friendly | professional | concise",
  llmProvider: "google | openai",
  llmModel: "member of getLLMModelOptions(llmProvider)",
  redeliveryAcknowledged: true,
  nativeRepliesDisabledAcknowledged: true
}
```

FAQ question and answer are required and capped at 500 and 4,000 characters; category is capped at 80 characters; keywords are a deduplicated array of at most 20 strings, each at most 80 characters; priority is an integer from `-100` to `100`.

- [ ] **Step 4: Implement owner-scoped routes**

Use `requireSettingsAccess()` for configuration and FAQ reads/writes. Apply `requireSameOrigin()` to every POST, PUT, PATCH, and DELETE. Return only configuration/readiness fields and FAQ content belonging to the owner; never return webhook hashes or connection credentials.

- [ ] **Step 5: Run focused and full tests**

Run: `node --test tests/support-*.test.js && npm test`

Expected: PASS, including cross-owner `404`, same-origin `403`, validation `400`, and safe `500` responses.

- [ ] **Step 6: Commit**

```bash
git add src/lib/support src/app/api/support/configuration src/app/api/support/faqs tests/support-identity-crypto.test.js tests/support-repository.test.js tests/support-store.test.js tests/support-settings-routes.test.js
git commit -m "feat: add support settings and FAQ storage"
```

## Milestone 2 — LINE Ingestion and FAQ-Grounded Automation

### Task 4: Provision LINE webhook and compute readiness

**Files:**
- Create: `src/lib/support/channel-adapters/line-support-adapter.js`
- Create: `src/lib/support/support-onboarding-service.js`
- Modify: `src/lib/platform-connections/platform-connection-route-handlers.js`
- Modify: `src/components/SettingsPanel.js`
- Create: `src/components/support/SupportSettingsPanel.js`
- Create: `src/components/support/FaqManager.js`
- Create: `src/components/support/SupportReadinessPanel.js`
- Create: `src/app/api/support/configuration/test-provider/route.js`
- Create: `src/app/api/support/configuration/state/route.js`
- Test: `tests/line-support-adapter.test.js`
- Test: `tests/support-onboarding-service.test.js`
- Modify: `tests/platform-connection-routes.test.js`
- Modify: `tests/settings-panel.test.js`

**Interfaces:**
- `createLineSupportAdapter({ fetchImpl, requestTimeoutMs })` exposes `verifySignature`, `configureWebhook`, `testWebhook`, `getWebhookStatus`, `replyText`, and `pushText`.
- `createSupportOnboardingService({ connections, supportStore, settingsStore, lineAdapter, generateTextImpl, env, randomBytes })` exposes `provisionLineWebhook(ownerEmail, connectionId)`, `getReadiness(ownerEmail, connectionId)`, `testAiProvider(ownerEmail, connectionId)`, and `setSupportEnabled(ownerEmail, connectionId, enabled)`.

- [ ] **Step 1: Write failing adapter and onboarding tests**

```js
test("provision stores only the hash and configures the generated HTTPS URL", async () => {
  const result = await service.provisionLineWebhook("owner@example.com", "connection-1");
  assert.match(result.webhookUrl, /^https:\/\/app\.example\/api\/webhooks\/line\/[A-Za-z0-9_-]+$/);
  assert.equal(repository.configuration.webhookKeyHash.includes(result.webhookUrl.split("/").at(-1)), false);
  assert.deepEqual(providerCalls.map(({ method, path }) => [method, path]), [
    ["PUT", "/v2/bot/channel/webhook/endpoint"],
    ["POST", "/v2/bot/channel/webhook/test"],
    ["GET", "/v2/bot/channel/webhook/endpoint"],
  ]);
});
```

- [ ] **Step 2: Run focused tests and verify failure**

Run: `node --test tests/line-support-adapter.test.js tests/support-onboarding-service.test.js`

Expected: FAIL because the adapter and onboarding service do not exist.

- [ ] **Step 3: Implement LINE operations with bounded, redacted errors**

Use `PUT /v2/bot/channel/webhook/endpoint`, `POST /v2/bot/channel/webhook/test`, and `GET /v2/bot/channel/webhook/endpoint`. Use `NEXTAUTH_URL` as the trusted base URL and reject support provisioning unless it is HTTPS. Signature verification uses HMAC-SHA256 over the untouched UTF-8 body and a timing-safe comparison.

- [ ] **Step 4: Attach provisioning to successful LINE connection**

After `line.connect()` returns its internal connection, invoke onboarding and return safe connection plus readiness. If LINE connection succeeds but webhook setup fails, retain the connection, mark support disabled with a safe setup error, and let the owner retry provisioning without reconnecting.

- [ ] **Step 5: Render the approved setup instructions and readiness gate**

Add a **客服** settings tab containing the structured brand/assistant/tone/provider/model form, FAQ table/editor CRUD, the readiness panel, and explicit save/error/loading states. Show a post-connection disclosure with these ordered actions: Messaging API tab, enable **Use webhook**, enable **Webhook redelivery**, open Official Account Manager response settings, disable greeting messages, disable auto-reply messages, return and run readiness check. Display LINE connection and AI support state separately.

The **Test AI provider** button alone may spend provider quota: it loads the owner-selected provider key and model, makes one fixed minimal text request, stores `providerTestedAt` on success, and returns only a safe status. Page load performs static key/model checks without a provider call. `POST /api/support/configuration/state` enables support only when LINE is active, provider key/model is present, at least one FAQ is enabled, webhook test and active status pass, and both acknowledgements are saved; disabling is always allowed.

- [ ] **Step 6: Run adapter, route, settings, and full tests**

Run: `node --test tests/line-support-adapter.test.js tests/support-onboarding-service.test.js tests/platform-connection-routes.test.js tests/settings-panel.test.js && npm test`

Expected: PASS with no token, secret, webhook hash, or provider error body in responses.

- [ ] **Step 7: Commit**

```bash
git add src/lib/support/channel-adapters src/lib/support/support-onboarding-service.js src/lib/platform-connections/platform-connection-route-handlers.js src/components/SettingsPanel.js src/components/support src/app/api/support/configuration tests
git commit -m "feat: provision LINE support webhooks"
```

### Task 5: Ingest, verify, deduplicate, and persist LINE webhook events

**Files:**
- Create: `src/lib/support/routes/line-webhook-handler.js`
- Create: `src/app/api/webhooks/line/[webhookKey]/route.js`
- Test: `tests/support-line-webhook.test.js`
- Modify: `tests/support-repository.test.js`

**Interfaces:**
- `createLineWebhookHandler({ findConnection, lineAdapter, eventStore, startWorkflow, respond })`.
- Starts `lineMessageWorkflow` with one object: `{ eventId, connectionId, conversationId }`.

- [ ] **Step 1: Write failing raw-body and deduplication tests**

```js
test("valid duplicate webhook returns 200 and starts no second workflow", async () => {
  const request = signedLineRequest(payloadWithEventId("evt-1"));
  assert.equal((await handler(request, "opaque-key")).status, 200);
  assert.equal((await handler(request, "opaque-key")).status, 200);
  assert.equal(startCalls.length, 1);
});

test("invalid signature stores nothing and calls no model or workflow", async () => {
  const response = await handler(unsignedRequest(payloadWithText("private")), "opaque-key");
  assert.equal(response.status, 401);
  assert.equal(repository.events.length, 0);
  assert.equal(startCalls.length, 0);
});
```

- [ ] **Step 2: Run focused tests and verify missing handler failure**

Run: `node --test tests/support-line-webhook.test.js`

Expected: FAIL resolving `line-webhook-handler.js`.

- [ ] **Step 3: Implement strict ingestion order**

The handler must execute in this order: hash webhook key, load active LINE connection and configuration, call `request.text()` once, verify `x-line-signature`, parse JSON, return `200` for `events: []`, then process events. A unique `(platform_connection_id, webhook_event_id)` insert decides whether Workflow starts.

For `source.type === "user"`, encrypt `source.userId`, derive customer HMAC, upsert the conversation, cancel only that conversation's pending transition, and store text or safe non-text metadata. For group/room sources, store only event ID, source type, ignored status, and timestamps.

- [ ] **Step 4: Implement failure contracts**

Invalid key returns `404`; invalid signature returns `401`; malformed verified JSON returns `400`; database failure returns `503`; duplicates and ignored group events return `200`. None of these responses includes owner, customer, credentials, event body, or raw exception text.

- [ ] **Step 5: Run webhook and repository tests**

Run: `node --test tests/support-line-webhook.test.js tests/support-repository.test.js && npm test`

Expected: PASS for empty verification, redelivery, group exclusion, non-text metadata, transition cancellation, and cross-connection customer separation.

- [ ] **Step 6: Commit**

```bash
git add src/lib/support/routes/line-webhook-handler.js src/app/api/webhooks/line tests/support-line-webhook.test.js tests/support-repository.test.js
git commit -m "feat: ingest secure LINE support webhooks"
```

### Task 6: Retrieve FAQs and validate structured AI decisions

**Files:**
- Create: `src/lib/support/knowledge/faq-retrieval.js`
- Create: `src/lib/support/decisions/support-decision-service.js`
- Test: `tests/support-faq-retrieval.test.js`
- Test: `tests/support-decision-service.test.js`

**Interfaces:**
- `retrieveFaqs({ query, faqs, limit = 5 }) -> [{ id, question, answer, category, score }]`.
- `createSupportDecisionService({ generateTextImpl, now })` exposes `decide({ configuration, settings, messages, faqs })`.
- Decision result is exactly `{ action, answer, category, handoffReasonCode, knowledgeSourceIds }`.

- [ ] **Step 1: Write failing deterministic retrieval and safety tests**

```js
test("reply citations must be a non-empty subset of supplied FAQs", async () => {
  const service = createSupportDecisionService({
    generateTextImpl: async () => JSON.stringify({
      action: "reply", answer: "answer", category: "general",
      handoffReasonCode: null, knowledgeSourceIds: ["not-supplied"],
    }),
  });
  assert.equal((await service.decide(input)).action, "handoff");
});

test("refund language hands off before a provider call", async () => {
  const calls = [];
  const service = createSupportDecisionService({
    generateTextImpl: async (...args) => { calls.push(args); return "{}"; },
  });
  const result = await service.decide({ ...input, messages: [{ senderType: "customer", text: "我要退款" }] });
  assert.equal(result.handoffReasonCode, "high_risk_refund");
  assert.equal(calls.length, 0);
});
```

- [ ] **Step 2: Run focused tests and verify failure**

Run: `node --test tests/support-faq-retrieval.test.js tests/support-decision-service.test.js`

Expected: FAIL resolving the retrieval and decision modules.

- [ ] **Step 3: Implement retrieval**

Normalize Unicode, case, whitespace, and punctuation. Score exact keyword matches above token overlap, add category overlap and configured priority, exclude disabled records, sort deterministically by score then priority then ID, and return no more than five records.

- [ ] **Step 4: Implement fixed safety prompt and strict parser**

The system prompt states that customer messages and FAQ text are untrusted, forbids unsupported claims and operational actions, requires JSON only, and allows citations only from supplied IDs. Parse fenced or plain JSON, reject extra keys, cap customer-visible answer length at 2,000 characters, require evidence for `reply` and `clarify`, and normalize every invalid result to a safe handoff.

- [ ] **Step 5: Run decision tests**

Run: `node --test tests/support-faq-retrieval.test.js tests/support-decision-service.test.js tests/llm-service.test.js && npm test`

Expected: PASS for prompt injection, invalid JSON/schema, unsupported citations, explicit-human, risk categories, and insufficient knowledge.

- [ ] **Step 6: Commit**

```bash
git add src/lib/support/knowledge src/lib/support/decisions tests/support-faq-retrieval.test.js tests/support-decision-service.test.js
git commit -m "feat: add FAQ-grounded support decisions"
```

### Task 7: Process batched conversations through durable Workflow

**Files:**
- Create: `src/lib/support/workflows/line-message-workflow.js`
- Create: `src/lib/support/support-processing-service.js`
- Modify: `src/lib/support/channel-adapters/line-support-adapter.js`
- Test: `tests/support-message-workflow.test.js`
- Test: `tests/support-processing-service.test.js`
- Modify: `tests/line-support-adapter.test.js`

**Interfaces:**
- `lineMessageWorkflow({ eventId, connectionId, conversationId })`.
- `createSupportProcessingService(dependencies)` exposes `acquireClaim`, `buildTurn`, `decideAndPersist`, `deliver`, and `releaseClaim`.
- `lineAdapter.replyText({ accessToken, replyToken, text })`; `lineAdapter.pushText({ accessToken, to, text, retryKey })`.

- [ ] **Step 1: Write failing batching, rate-limit, and delivery tests**

```js
test("messages inside one three-second window become one AI turn", async () => {
  await workflowHarness.receiveAt("00:00:00.000", "請問");
  await workflowHarness.receiveAt("00:00:02.000", "營業時間？");
  await workflowHarness.advanceTo("00:00:03.000");
  assert.deepEqual(decisionCalls[0].customerTexts, ["請問", "營業時間？"]);
  assert.equal(decisionCalls.length, 1);
});

test("the eleventh AI turn in five minutes hands off without an LLM call", async () => {
  repository.seedDecisions(10, { since: "00:00:00.000" });
  const result = await service.decideAndPersist(ids);
  assert.equal(result.handoffReasonCode, "rate_limit");
  assert.equal(generateCalls.length, 0);
});
```

- [ ] **Step 2: Run focused tests and verify failure**

Run: `node --test tests/support-message-workflow.test.js tests/support-processing-service.test.js`

Expected: FAIL resolving the Workflow and processing service.

- [ ] **Step 3: Implement durable orchestration**

```js
import { sleep } from "workflow";

export async function lineMessageWorkflow(input) {
  "use workflow";
  const claim = await acquireConversationClaim(input);
  if (!claim.acquired) return { status: "already_processing" };
  try {
    const windowStartMs = await recordBatchWindowStart(input, claim.claimId);
    await sleep("3s");
    const cutoff = new Date(windowStartMs + 3_000).toISOString();
    const turn = await buildClaimedTurn(input, claim.claimId, cutoff);
    if (!turn) return { status: "no_messages" };
    const delivery = await decidePersistAndDeliver(turn);
    return { status: delivery.status };
  } finally {
    await releaseConversationClaim(input, claim.claimId);
  }
}
```

Every called function is a `"use step"` function and loads protected data from Turso by ID. Claim expiry is bounded; compare-and-set prevents concurrent turns. After release, if unprocessed messages remain, start a follow-up Workflow with their internal event ID.

- [ ] **Step 4: Implement decision persistence and delivery idempotency**

Load the latest ten customer/AI pairs, selected provider/model, owner settings, and retrieved FAQs. Try the LLM at most three times for retryable failures. Atomically store decision and outbound message before sending. Prefer Reply API; on expired-token `400`, decrypt customer ID and Push with the message UUID as `X-Line-Retry-Key`. Treat Push `409` with `x-line-accepted-request-id` as sent.

**Reliability amendment (user-approved 2026-07-20):** Automated AI replies use the Push API rather than Reply API so every delivery has a stable, hexadecimal UUID `X-Line-Retry-Key` from its immutable outbound-message record. Persist the recipient, exact canonical body, retry key, attempt timestamps, and delivery status before transport; never mutate recipient or body while retrying the same key. Retry only timeout/transport failures and 5xx with bounded exponential backoff during LINE's 24-hour retry-key window. Mark 2xx and 409 with `x-line-accepted-request-id` as sent. Do not automatically retry other 4xx responses. If a pending/unknown delivery exceeds the 24-hour window, mark it for explicit human review; do not silently create a new key or outbound record because the earlier request might already have been accepted. The webhook's connection-scoped official event-ID uniqueness remains a separate inbound deduplication layer, preventing duplicate LLM/outbox creation. The first Workflow step must persistently deduplicate event processing before decision/outbox creation; duplicate Workflow runs may deliver the same immutable outbox record but cannot create a second one.

- [ ] **Step 5: Implement fail-closed outcomes**

If support is disabled, conversation is human-controlled, configuration becomes unready, LLM output remains invalid, credential use is rejected, or provider calls exhaust retries, persist a safe reason and enter `waiting_human`. Credential rejection also marks the platform connection `needs_reconnect`. Never send a second acknowledgement for the same handoff transition.

- [ ] **Step 6: Run Workflow, adapter, and full tests**

Run: `node --test tests/support-message-workflow.test.js tests/support-processing-service.test.js tests/line-support-adapter.test.js && npm test && npm run build`

Expected: PASS for ordering, claims, cutoff boundaries, follow-up turns, ten-turn limit, retries, Reply-to-Push fallback, Push `409`, and idempotency.

- [ ] **Step 7: Commit**

```bash
git add src/lib/support/workflows/line-message-workflow.js src/lib/support/support-processing-service.js src/lib/support/channel-adapters/line-support-adapter.js tests/support-message-workflow.test.js tests/support-processing-service.test.js tests/line-support-adapter.test.js
git commit -m "feat: automate durable LINE support replies"
```

## Milestone 3 — Human Inbox and Recoverable State

### Task 8: Add owner-scoped inbox APIs and responsive read UI

**Files:**
- Create: `src/lib/support/routes/support-inbox-route-handlers.js`
- Create: `src/app/api/support/conversations/route.js`
- Create: `src/app/api/support/conversations/[id]/route.js`
- Create: `src/app/api/support/conversations/[id]/read/route.js`
- Create: `src/app/support/page.js`
- Create: `src/components/support/SupportInbox.js`
- Create: `src/components/support/ConversationList.js`
- Create: `src/components/support/ConversationThread.js`
- Create: `src/components/support/ConversationDetailsDrawer.js`
- Modify: `src/components/AppShellFrame.js`
- Test: `tests/support-inbox-routes.test.js`
- Test: `tests/support-inbox-ui.test.js`

**Interfaces:**
- `GET /api/support/conversations?status=&cursor=` returns safe summaries and the next cursor.
- `GET /api/support/conversations/[id]` returns retained messages, safe decision metadata, FAQ sources, state, and current pending transition.
- `POST /api/support/conversations/[id]/read` atomically sets that owner's unread count to zero.
- `SupportInbox` owns selected-conversation state and polling; server transition state is never stored only in a row component.

- [ ] **Step 1: Write failing API isolation and UI-structure tests**

```js
test("conversation detail rejects another owner's conversation", async () => {
  const response = await handlers.getConversation(request, "other-owner-conversation");
  assert.equal(response.status, 404);
  assert.equal(JSON.stringify(await response.json()).includes("U-line-user"), false);
});

test("inbox contains queue, thread, drawer, visible-tab poll, and mobile back navigation", async () => {
  const source = await readFile("src/components/support/SupportInbox.js", "utf8");
  for (const marker of ["ConversationList", "ConversationThread", "ConversationDetailsDrawer", "visibilitychange", "15000"]) {
    assert.equal(source.includes(marker), true);
  }
});
```

- [ ] **Step 2: Run focused tests and verify missing modules**

Run: `node --test tests/support-inbox-routes.test.js tests/support-inbox-ui.test.js`

Expected: FAIL because inbox routes and components do not exist.

- [ ] **Step 3: Implement safe list and detail APIs**

Sort waiting/unread failures first, then newest inbound. Use opaque cursor pagination. Summary fields are conversation ID, display-safe customer label, status, unread count, handoff reason, last-message preview, delivery failure flag, and timestamps. Detail decrypts no external customer ID into the response; it returns only retained text and safe operational metadata. Opening a conversation calls the owner-scoped read endpoint; a new inbound message increments unread count atomically.

- [ ] **Step 4: Implement desktop and mobile layout**

Desktop renders the queue and thread together; the information drawer opens beside the thread. Below Mantine `sm`, render list first, selected thread as a full-width view with a back action, and drawer as a full-width secondary panel. Composer is disabled until `human_active`. Add loading, empty, stale, reconnect, failure, and resolved states without horizontal overflow.

- [ ] **Step 5: Implement bounded polling**

Fetch summaries every 15 seconds only when `document.visibilityState === "visible"`, refresh selected detail after summary changes, pause on hidden tabs, resume immediately on visible, and expose manual refresh. Clear intervals and abort obsolete fetches on unmount or selection change. Show the safe total waiting/unread count on the **客服收件匣** navigation item; no external notification is sent.

- [ ] **Step 6: Run UI/API tests and build**

Run: `node --test tests/support-inbox-routes.test.js tests/support-inbox-ui.test.js && npm test && npm run build`

Expected: PASS; build renders `/support`; source checks show no customer IDs, secrets, or unbounded timers.

- [ ] **Step 7: Commit**

```bash
git add src/lib/support/routes/support-inbox-route-handlers.js src/app/api/support/conversations src/app/support src/components/support src/components/AppShellFrame.js tests/support-inbox-routes.test.js tests/support-inbox-ui.test.js
git commit -m "feat: add LINE support inbox"
```

### Task 9: Add human Push replies and ten-second undoable transitions

**Files:**
- Create: `src/app/api/support/conversations/[id]/take-over/route.js`
- Create: `src/app/api/support/conversations/[id]/messages/route.js`
- Create: `src/app/api/support/conversations/[id]/transitions/route.js`
- Create: `src/app/api/support/conversations/[id]/transitions/[transitionId]/undo/route.js`
- Create: `src/lib/support/workflows/support-transition-workflow.js`
- Create: `src/components/support/GlobalTransitionUndo.js`
- Modify: `src/components/support/SupportInbox.js`
- Modify: `src/components/support/ConversationThread.js`
- Test: `tests/support-human-actions.test.js`
- Test: `tests/support-transition-workflow.test.js`
- Modify: `tests/support-inbox-ui.test.js`

**Interfaces:**
- `POST take-over` moves `waiting_human`, `ai_active`, or pending states to `human_active` with optimistic versioning.
- `POST messages` creates or retries a human outbound message by idempotency key.
- `POST transitions` accepts `{ action: "return_to_ai" | "resolve", expectedVersion }`.
- `POST undo` accepts no conversation state from the browser; path IDs identify the exact transition.

- [ ] **Step 1: Write failing concurrency, undo, and human-delivery tests**

```js
test("switching selected customer does not alter another conversation transition", async () => {
  const transition = await actions.requestTransition(owner, "conversation-a", "resolve", 3);
  await ui.selectConversation("conversation-b");
  await clock.advance(10_000);
  assert.equal((await repository.getConversation(owner, "conversation-a")).status, "resolved");
  assert.equal((await repository.getConversation(owner, "conversation-b")).status, "human_active");
});

test("new inbound cancels only the same conversation pending transition", async () => {
  await seedPending("conversation-a");
  await seedPending("conversation-b");
  await repository.recordInbound(owner, "conversation-a", inbound);
  assert.equal((await getTransition("conversation-a")).cancelledAt instanceof Date, true);
  assert.equal((await getTransition("conversation-b")).cancelledAt, null);
});
```

- [ ] **Step 2: Run focused tests and verify failure**

Run: `node --test tests/support-human-actions.test.js tests/support-transition-workflow.test.js tests/support-inbox-ui.test.js`

Expected: FAIL because human-action routes, Workflow, and global undo do not exist.

- [ ] **Step 3: Implement human reply delivery**

Require owner and same origin, verify `human_active`, insert a `pending` outbound message, decrypt the LINE user ID server-side, and call Push with the message UUID as retry key. Store `sent` on `200` or accepted `409`; otherwise store `failed` plus a safe code. Retry reuses the same message and retry key and never claims success before provider acceptance. Taking over a resolved conversation explicitly reopens it as `human_active`; a new inbound message reopens it for normal classification.

- [ ] **Step 4: Implement transition request, Workflow commit, and undo**

```js
export async function supportTransitionWorkflow({ transitionId, conversationId }) {
  "use workflow";
  await sleep("10s");
  return commitTransitionStep({ transitionId, conversationId });
}

async function commitTransitionStep(input) {
  "use step";
  return getSupportTransitionService().commitIfCurrent(input);
}
```

Request atomically creates the transition and changes conversation status to `return_to_ai_pending` or `resolve_pending`. Commit succeeds only when transition is uncancelled, pending ID matches, and conversation version equals `expectedVersion + 1`. Undo clears only the matching pending transition and restores its recorded `fromStatus`; stale undo returns `409` without mutation.

- [ ] **Step 5: Implement approved interaction behavior**

Return-to-AI requires confirmation before the request. Resolve sends immediately without a modal. Both show a global ten-second undo notice containing the safe customer label, remain available after switching conversations, and reconcile from server state after refresh. AI remains paused while either transition is pending.

- [ ] **Step 6: Run actions, transitions, UI, and full tests**

Run: `node --test tests/support-human-actions.test.js tests/support-transition-workflow.test.js tests/support-inbox-ui.test.js tests/support-line-webhook.test.js && npm test && npm run build`

Expected: PASS for navigation, refresh, stale tabs, stale undo, same-conversation inbound cancellation, recovery after commit, failed sends, and accepted retry keys.

- [ ] **Step 7: Commit**

```bash
git add src/app/api/support/conversations src/lib/support/workflows/support-transition-workflow.js src/components/support tests/support-human-actions.test.js tests/support-transition-workflow.test.js tests/support-inbox-ui.test.js tests/support-line-webhook.test.js
git commit -m "feat: add recoverable human support actions"
```

## Milestone 4 — Retention, Operations, and MVP Acceptance

### Task 10: Add retention cleanup, safe observability, and end-to-end acceptance

**Files:**
- Create: `src/lib/support/retention/support-retention-service.js`
- Create: `src/app/api/cron/support-retention/route.js`
- Modify: `vercel.json`
- Modify: `README.md`
- Create: `docs/line-support-runbook.md`
- Test: `tests/support-retention.test.js`
- Test: `tests/support-retention-cron.test.js`
- Create: `tests/support-security-regression.test.js`

**Interfaces:**
- `createSupportRetentionService({ repository, now, batchSize = 100 })` exposes `purgeExpiredContent()`.
- `GET /api/cron/support-retention` requires exact `Bearer ${CRON_SECRET}` and returns safe counts only.

- [ ] **Step 1: Write failing retention and redaction tests**

```js
test("cleanup clears expired content and reply tokens but preserves safe audit state", async () => {
  const result = await service.purgeExpiredContent();
  assert.deepEqual(result, { messagesCleared: 1, replyTokensCleared: 1 });
  assert.equal(expiredMessage.textContent, null);
  assert.equal(expiredEvent.encryptedReplyToken, null);
  assert.equal(expiredMessage.deliveryStatus, "sent");
});

test("support responses and logs contain no protected fixtures", async () => {
  for (const output of collectedOutputs) {
    for (const secret of ["channel-secret", "access-token", "reply-token", "U-customer-id"]) {
      assert.equal(JSON.stringify(output).includes(secret), false);
    }
  }
});
```

- [ ] **Step 2: Run focused tests and verify failure**

Run: `node --test tests/support-retention.test.js tests/support-retention-cron.test.js tests/support-security-regression.test.js`

Expected: FAIL because retention modules and route do not exist.

- [ ] **Step 3: Implement bounded daily cleanup**

Clear message text older than 30 days in batches of 100, clear expired reply-token ciphertext immediately, retain safe timestamps/status/reason codes, and loop only while a full batch was changed. Add `30 1 * * *` for `/api/cron/support-retention` and keep the existing publishing cron unchanged.

- [ ] **Step 4: Document setup and incident recovery**

README links to `docs/line-support-runbook.md`. The runbook covers Workflow smoke gating, backup-gated schema migration, LINE Console steps, readiness meanings, reconnect-required recovery, failed human-send retry, Workflow inspection, usage inspection, disabling support, retention, and the boundary that LINE OA Manager replies are not synchronized.

- [ ] **Step 5: Run complete local verification**

Run: `npm test && npm run check:runtime-config && npm run build && git diff --check`

Expected: all tests PASS, runtime configuration validates with documented variables, build succeeds, and whitespace check is clean.

- [ ] **Step 6: Perform frontend visual QA locally**

At desktop and mobile widths, verify settings instructions, FAQ CRUD states, list/thread/drawer reflow, composer states, long text wrapping, global undo while switching conversations, and no horizontal overflow. Record screenshots or notes in the implementation task; fix every visible clipping, overlap, inaccessible label, or missing feedback state before proceeding.

- [ ] **Step 7: Stop at the live MVP acceptance gate**

Request explicit authorization naming the dedicated test LINE Official Account, test LINE user, deployed URL, selected LLM provider/model, and exact test messages. Then verify Workflow dashboard evidence, automatic webhook setup, one-to-one AI reply, explicit-human handoff, human Push reply, non-text handoff, return/resolve/undo, navigation/refresh independence, database redaction, runtime-log redaction, and Vercel usage. Do not use a real customer account.

- [ ] **Step 8: Run completion review and commit**

Use `pr-readiness`, update stale documentation, rerun the complete verification commands, inspect the final diff for secrets and unrelated files, then:

```bash
git add vercel.json README.md docs/line-support-runbook.md src/lib/support/retention src/app/api/cron/support-retention tests/support-retention.test.js tests/support-retention-cron.test.js tests/support-security-regression.test.js
git commit -m "docs: finalize LINE support MVP operations"
```

## Implementation Order and Review Gates

1. Task 1 must pass the deployed Workflow smoke before Tasks 4–10 may perform external side effects.
2. Task 2 migration is generated and tested locally, but production Turso migration waits for a verified backup and explicit authorization.
3. Tasks 3–7 deliver owner-scoped automated LINE support.
4. Tasks 8–9 deliver human takeover, replies, and recoverable transitions.
5. Task 10 completes retention, documentation, visual QA, and dedicated-account acceptance.
6. Each task receives a spec-conformance review and code-quality review before its commit.

## Primary References

- Design specification: `docs/superpowers/specs/2026-07-19-line-ai-customer-support-design.md`
- Vercel Workflow setup and `start()`: https://vercel.com/kb/guide/how-to-build-a-durable-ai-code-agent-on-vercel
- Vercel Workflows overview: https://vercel.com/workflows
- Vercel Hobby limits: https://vercel.com/docs/plans/hobby
- LINE signature verification: https://developers.line.biz/en/docs/messaging-api/verify-webhook-signature/
- LINE webhook settings and message endpoints: https://developers.line.biz/en/reference/messaging-api/
- LINE webhook redelivery: https://developers.line.biz/en/docs/messaging-api/receiving-messages/
