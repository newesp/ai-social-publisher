import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";

import { createSupportRepository } from "../src/lib/support/support-repository.js";
import { createSupportRetentionService } from "../src/lib/support/retention/support-retention-service.js";

const NOW = new Date("2026-07-20T01:30:00.000Z");

test("cleanup clears expired content and reply tokens but preserves safe audit state", async () => {
  await withDatabase(async (db) => {
    const timestamp = (date) => Math.floor(date.getTime() / 1_000);
    const oldCreatedAt = timestamp(new Date(NOW.getTime() - (31 * 24 * 60 * 60 * 1_000)));
    const recentCreatedAt = timestamp(new Date(NOW.getTime() - (29 * 24 * 60 * 60 * 1_000)));
    const expiredReplyTokenAt = timestamp(new Date(NOW.getTime() - 1_000));
    const exactReplyTokenAt = timestamp(NOW);
    const activeReplyTokenAt = timestamp(new Date(NOW.getTime() + 1_000));
    const currentTimestamp = timestamp(NOW);
    await db.run(`INSERT INTO support_messages (
      id, conversation_id, direction, sender_type, message_type, text_content, safe_metadata_json,
      provider_message_id, delivery_status, idempotency_key, sent_at, failed_at, safe_error_code,
      processed_at, created_at
    ) VALUES
      ('expired-message', 'conversation-1', 'inbound', 'customer', 'text', 'expired text', '{}', NULL, 'sent', 'expired-message', NULL, NULL, NULL, NULL, ${oldCreatedAt}),
      ('retained-message', 'conversation-1', 'outbound', 'assistant', 'text', 'retained text', '{}', NULL, 'sent', 'retained-message', NULL, NULL, NULL, NULL, ${recentCreatedAt})`);
    await db.run(`INSERT INTO support_webhook_events (
      id, platform_connection_id, webhook_event_id, source_type, processing_status, encrypted_reply_token,
      reply_token_expires_at, safe_error_code, received_at, processed_at, created_at
    ) VALUES
      ('expired-event', 'connection-1', 'expired-event', 'user', 'processed', 'expired-token', ${expiredReplyTokenAt}, 'safe_code', ${currentTimestamp}, ${currentTimestamp}, ${currentTimestamp}),
      ('exact-event', 'connection-1', 'exact-event', 'user', 'processed', 'exact-token', ${exactReplyTokenAt}, 'safe_code', ${currentTimestamp}, ${currentTimestamp}, ${currentTimestamp}),
      ('active-event', 'connection-1', 'active-event', 'user', 'processed', 'active-token', ${activeReplyTokenAt}, 'safe_code', ${currentTimestamp}, ${currentTimestamp}, ${currentTimestamp})`);
    await db.run(`INSERT INTO support_outbound_deliveries (
      id, webhook_event_id, conversation_id, encrypted_recipient, encrypted_canonical_body, retry_key,
      delivery_status, attempt_count, created_at
    ) VALUES
      ('sent-delivery', 'expired-event', 'conversation-1', 'recipient', 'expired canonical body', 'sent-delivery', 'sent', 1, ${oldCreatedAt}),
      ('retryable-delivery', 'active-event', 'conversation-1', 'recipient', 'retryable canonical body', 'retryable-delivery', 'retryable', 1, ${oldCreatedAt})`);

    const service = createSupportRetentionService({
      repository: createSupportRepository(db),
      now: () => NOW,
    });

    assert.deepEqual(await service.purgeExpiredContent(), {
      messagesCleared: 1,
      replyTokensCleared: 2,
      outboundBodiesCleared: 1,
    });

    const messages = await db.all("SELECT id, text_content, delivery_status, safe_error_code, created_at FROM support_messages ORDER BY id");
    assert.deepEqual(messages, [
      {
        id: "expired-message",
        text_content: null,
        delivery_status: "sent",
        safe_error_code: null,
        created_at: oldCreatedAt,
      },
      {
        id: "retained-message",
        text_content: "retained text",
        delivery_status: "sent",
        safe_error_code: null,
        created_at: recentCreatedAt,
      },
    ]);
    const events = await db.all("SELECT id, encrypted_reply_token, reply_token_expires_at, safe_error_code FROM support_webhook_events ORDER BY id");
    assert.deepEqual(events, [
      {
        id: "active-event",
        encrypted_reply_token: "active-token",
        reply_token_expires_at: activeReplyTokenAt,
        safe_error_code: "safe_code",
      },
      {
        id: "exact-event",
        encrypted_reply_token: null,
        reply_token_expires_at: null,
        safe_error_code: "safe_code",
      },
      {
        id: "expired-event",
        encrypted_reply_token: null,
        reply_token_expires_at: null,
        safe_error_code: "safe_code",
      },
    ]);
    assert.deepEqual(await db.all("SELECT id, encrypted_canonical_body, delivery_status FROM support_outbound_deliveries ORDER BY id"), [
      { id: "retryable-delivery", encrypted_canonical_body: "retryable canonical body", delivery_status: "retryable" },
      { id: "sent-delivery", encrypted_canonical_body: "", delivery_status: "sent" },
    ]);
  });
});

test("cleanup continues only after a full batch and aggregates safe counts", async () => {
  const calls = [];
  const repository = {
    async clearExpiredSupportContent(input) {
      calls.push(input);
      return calls.length === 1
        ? { messagesCleared: 100, replyTokensCleared: 0 }
        : { messagesCleared: 1, replyTokensCleared: 1 };
    },
  };
  const service = createSupportRetentionService({ repository, now: () => NOW });

  assert.deepEqual(await service.purgeExpiredContent(), {
    messagesCleared: 101,
    replyTokensCleared: 1,
    outboundBodiesCleared: 0,
  });
  assert.deepEqual(calls, [
    {
      contentBefore: new Date("2026-06-20T01:30:00.000Z"),
      replyTokenBefore: NOW,
      batchSize: 100,
    },
    {
      contentBefore: new Date("2026-06-20T01:30:00.000Z"),
      replyTokenBefore: NOW,
      batchSize: 100,
    },
  ]);
});

test("cleanup caps each daily invocation after ten full batches", async () => {
  let calls = 0;
  const service = createSupportRetentionService({
    repository: {
      async clearExpiredSupportContent() {
        calls += 1;
        return calls <= 10
          ? { messagesCleared: 100, replyTokensCleared: 0, outboundBodiesCleared: 0 }
          : { messagesCleared: 1, replyTokensCleared: 0, outboundBodiesCleared: 0 };
      },
    },
    now: () => NOW,
  });

  assert.deepEqual(await service.purgeExpiredContent(), {
    messagesCleared: 1_000,
    replyTokensCleared: 0,
    outboundBodiesCleared: 0,
  });
  assert.equal(calls, 10);
});

async function withDatabase(run) {
  const directory = await mkdtemp(join(tmpdir(), "support-retention-"));
  const client = createClient({ url: pathToFileURL(join(directory, "support.db")).href });
  try {
    await client.executeMultiple(`
      CREATE TABLE support_messages (
        id TEXT PRIMARY KEY NOT NULL, conversation_id TEXT NOT NULL, direction TEXT NOT NULL,
        sender_type TEXT NOT NULL, message_type TEXT NOT NULL, text_content TEXT,
        safe_metadata_json TEXT NOT NULL, provider_message_id TEXT, delivery_status TEXT NOT NULL,
        idempotency_key TEXT NOT NULL, sent_at INTEGER, failed_at INTEGER, safe_error_code TEXT,
        processed_at INTEGER, created_at INTEGER NOT NULL
      );
      CREATE TABLE support_webhook_events (
        id TEXT PRIMARY KEY NOT NULL, platform_connection_id TEXT NOT NULL, webhook_event_id TEXT NOT NULL,
        source_type TEXT NOT NULL, processing_status TEXT NOT NULL, encrypted_reply_token TEXT,
        reply_token_expires_at INTEGER, safe_error_code TEXT, received_at INTEGER NOT NULL,
        processed_at INTEGER, created_at INTEGER NOT NULL
      );
      CREATE TABLE support_outbound_deliveries (
        id TEXT PRIMARY KEY NOT NULL, webhook_event_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
        encrypted_recipient TEXT NOT NULL, encrypted_canonical_body TEXT NOT NULL, retry_key TEXT NOT NULL,
        delivery_status TEXT NOT NULL, delivery_claim_id TEXT, delivery_claim_expires_at INTEGER,
        attempt_count INTEGER NOT NULL DEFAULT 0, first_attempt_at INTEGER, last_attempt_at INTEGER,
        next_attempt_at INTEGER, accepted_request_id TEXT, safe_error_code TEXT, sent_at INTEGER,
        failed_at INTEGER, human_review_at INTEGER, created_at INTEGER NOT NULL
      );
    `);
    await run(drizzle(client));
  } finally {
    await client.close();
    try {
      await rm(directory, { recursive: true, force: true });
    } catch (error) {
      if (error.code !== "EBUSY") throw error;
    }
  }
}
