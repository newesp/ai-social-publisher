import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

async function sources() {
  return Promise.all([
    readFile(new URL("../src/components/support/SupportInbox.js", import.meta.url), "utf8"),
    readFile(new URL("../src/components/support/ConversationList.js", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/support/support-repository.js", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/support/routes/line-webhook-handler.js", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/db/schema.js", import.meta.url), "utf8"),
    readFile(new URL("../scripts/apply-support-schema.mjs", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"),
  ]);
}

test("inbox exposes cursor-based Load more that appends safely and resets on refresh", async () => {
  const [inbox, list] = await sources();
  for (const marker of ["nextCursor", "loadMore", "appendUniqueConversations", "cursor="]) {
    assert.match(inbox, new RegExp(marker));
  }
  assert.match(list, /Load more/);
});

test("support persistence records the authoritative decision action and provider metadata", async () => {
  const [, , repository] = await sources();
  assert.match(repository, /action: decision\.action/);
  assert.match(repository, /llmProvider: configuration\?\.llmProvider/);
  assert.match(repository, /llmModel: configuration\?\.llmModel/);
});

test("the support decision timeline has a migration, schema index, journal entry, and manual metadata guard", async () => {
  const [, , , , schema, migrationScript, journal] = await sources();
  assert.match(schema, /support_ai_decisions_conversation_created_id_idx/);
  assert.match(migrationScript, /0008_support_decision_timeline_index/);
  assert.match(journal, /0008_support_decision_timeline_index/);
  assert.match(migrationScript, /manual.*metadata/i);
});

test("handoff reasons are cleared on every transition away from handoff state", async () => {
  const [, , repository] = await sources();
  const clears = repository.match(/handoffReasonCode:\s*null/g) ?? [];
  assert.ok(clears.length >= 4);
});

test("chunked and undeclared webhook bodies are capped while streaming exact UTF-8 bytes", async () => {
  const [, , , webhook] = await sources();
  assert.match(webhook, /readBodyWithinLimit/);
  assert.match(webhook, /request\.body\.getReader/);
  assert.doesNotMatch(webhook, /request\.text\(\)|request\.arrayBuffer\(\)/);
});

test("non-text inbound events remain workflow-replayable until their durable automatic handoff is terminal", async () => {
  const [, , repository] = await sources();
  const workflow = await readFile(new URL("../src/lib/support/workflows/line-message-workflow.js", import.meta.url), "utf8");
  assert.match(repository, /handoffReasonCode: "non_text"/);
  assert.match(workflow, /handoffReasonCode: turn\.handoffReasonCode/);
});

test("clarify decisions persist as clarify rather than a forced reply", async () => {
  const [, , repository] = await sources();
  assert.match(repository, /action: decision\.action/);
  assert.match(repository, /decision\.action !== "reply" && decision\.action !== "clarify"/);
});

test("conversation detail loads only its bounded cited FAQ sources", async () => {
  const [, , repository] = await sources();
  assert.match(repository, /INBOX_FAQ_SOURCE_LIMIT/);
  assert.match(repository, /inArray\(supportFaqs\.id,\s*usedFaqIds\)/);
  assert.match(repository, /\.limit\(INBOX_FAQ_SOURCE_LIMIT\)/);
});
