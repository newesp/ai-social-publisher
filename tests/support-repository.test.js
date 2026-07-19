import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { createClient } from "@libsql/client";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";

import {
  platformConnections,
  supportConfigurations,
  supportFaqs,
  userSettings,
} from "../src/lib/db/schema.js";
import { decryptJson, encryptJson } from "../src/lib/settings/credential-crypto.js";
import { createSupportRepository } from "../src/lib/support/support-repository.js";

const NOW = new Date("2026-07-19T00:00:00.000Z");
const LATER = new Date("2026-07-19T00:01:00.000Z");
const SETTINGS_ENCRYPTION_KEY = "support-repository-test-key";

test("configuration lookups and mutations stay scoped to the normalized owner", async () => {
  await withDatabase(async (db) => {
    const repository = createSupportRepository(db);
    await db.insert(platformConnections).values([
      connection("11111111-1111-4111-8111-111111111111", "owner@example.com"),
      connection("22222222-2222-4222-8222-222222222222", "other@example.com"),
    ]);

    assert.equal(
      (await repository.findOwnedLineConnection(" OWNER@EXAMPLE.COM ", "11111111-1111-4111-8111-111111111111")).id,
      "11111111-1111-4111-8111-111111111111",
    );
    assert.equal(
      await repository.findOwnedLineConnection("owner@example.com", "22222222-2222-4222-8222-222222222222"),
      null,
    );
    assert.equal(await repository.createConfiguration("owner@example.com", {
      ...configurationRecord(),
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      platformConnectionId: "22222222-2222-4222-8222-222222222222",
    }), null);

    const created = await repository.createConfiguration(" OWNER@EXAMPLE.COM ", configurationRecord());
    assert.equal(created.ownerEmail, "owner@example.com");
    assert.equal(await repository.getConfiguration("other@example.com"), null);
    assert.equal((await repository.getConfiguration("owner@example.com")).id, created.id);

    assert.equal(
      await repository.updateConfiguration("other@example.com", created.id, { brandName: "Stolen" }),
      null,
    );
    assert.equal(
      (await repository.updateConfiguration("owner@example.com", created.id, { brandName: "Updated" })).brandName,
      "Updated",
    );
    const versioned = await repository.updateConfiguration(
      "owner@example.com",
      created.id,
      { brandName: "Version one", version: 1 },
      { expectedVersion: 0 },
    );
    assert.equal(versioned.brandName, "Version one");
    assert.equal(versioned.version, 1);
    assert.equal(
      await repository.updateConfiguration(
        "owner@example.com",
        created.id,
        { brandName: "Stale write", version: 2 },
        { expectedVersion: 0 },
      ),
      null,
    );
    assert.equal((await repository.getConfiguration("owner@example.com")).brandName, "Version one");
    const protectedRecord = await repository.updateConfiguration("owner@example.com", created.id, {
      id: "changed-id",
      ownerEmail: "other@example.com",
      brandName: "Still owned",
    });
    assert.equal(protectedRecord.id, created.id);
    assert.equal(protectedRecord.ownerEmail, "owner@example.com");
    assert.equal(protectedRecord.brandName, "Still owned");
    assert.equal(
      await repository.updateConfiguration("owner@example.com", created.id, {
        platformConnectionId: "22222222-2222-4222-8222-222222222222",
      }),
      null,
    );
    assert.equal((await repository.getConfiguration("owner@example.com")).platformConnectionId, created.platformConnectionId);
  });
});

test("FAQ mutations require both normalized owner and FAQ id", async () => {
  await withDatabase(async (db) => {
    const repository = createSupportRepository(db);
    const faq = await repository.createFaq(" OWNER@EXAMPLE.COM ", faqRecord());
    await repository.createFaq("other@example.com", {
      ...faqRecord(),
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      question: "Other question",
    });

    assert.deepEqual((await repository.listFaqs("owner@example.com")).map(({ id }) => id), [faq.id]);
    assert.equal(await repository.updateFaq("other@example.com", faq.id, { answer: "stolen" }), null);
    const protectedFaq = await repository.updateFaq("owner@example.com", faq.id, {
      id: "changed-id",
      ownerEmail: "other@example.com",
      answer: "updated",
    });
    assert.equal(protectedFaq.id, faq.id);
    assert.equal(protectedFaq.ownerEmail, "owner@example.com");
    assert.equal(protectedFaq.answer, "updated");
    assert.equal(await repository.deleteFaq("other@example.com", faq.id), null);
    assert.equal((await repository.deleteFaq("owner@example.com", faq.id)).id, faq.id);
    assert.deepEqual(await repository.listFaqs("owner@example.com"), []);
  });
});

test("webhook verification writes require the prepared version and key hash", async () => {
  await withDatabase(async (db) => {
    const repository = createSupportRepository(db);
    await db.insert(platformConnections).values(
      connection("11111111-1111-4111-8111-111111111111", "owner@example.com"),
    );
    await repository.createConfiguration("owner@example.com", configurationRecord());

    assert.equal(
      await repository.updateConfiguration(
        "owner@example.com",
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        { webhookVerifiedAt: LATER, version: 1 },
        { expectedVersion: 0, expectedWebhookKeyHash: "wrong-hash" },
      ),
      null,
    );
    const updated = await repository.updateConfiguration(
      "owner@example.com",
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      { webhookVerifiedAt: LATER, version: 1 },
      { expectedVersion: 0, expectedWebhookKeyHash: "secret-hash" },
    );
    assert.equal(updated.webhookVerifiedAt.toISOString(), LATER.toISOString());
    assert.equal(updated.version, 1);
  });
});

test("atomic enable rejects an FAQ disabled after its readiness snapshot", async () => {
  await withDatabase(async (db, { createSecondaryDb }) => {
    await seedReadySupport(db);
    const interleaving = createDecryptInterleaving();
    const repository = createSupportRepository(db, {
      encryptionKey: SETTINGS_ENCRYPTION_KEY,
      decryptSettings: interleaving.decrypt,
    });

    const enabling = repository.enableConfigurationIfReady(
      "owner@example.com",
      "11111111-1111-4111-8111-111111111111",
      LATER,
    );
    await interleaving.started;
    const secondaryDb = await createSecondaryDb();
    await secondaryDb.update(supportFaqs).set({ enabled: false, updatedAt: LATER })
      .where(eq(supportFaqs.id, "ffffffff-ffff-4fff-8fff-ffffffffffff"));
    interleaving.release();

    assert.equal(await enabling, null);
    assert.equal((await repository.getConfiguration("owner@example.com")).supportState, "disabled");
  });
});

test("atomic enable rejects a provider key removed after its readiness snapshot", async () => {
  await withDatabase(async (db, { createSecondaryDb }) => {
    await seedReadySupport(db);
    const interleaving = createDecryptInterleaving();
    const repository = createSupportRepository(db, {
      encryptionKey: SETTINGS_ENCRYPTION_KEY,
      decryptSettings: interleaving.decrypt,
    });

    const enabling = repository.enableConfigurationIfReady(
      "owner@example.com",
      "11111111-1111-4111-8111-111111111111",
      LATER,
    );
    await interleaving.started;
    const secondaryDb = await createSecondaryDb();
    await secondaryDb.update(userSettings).set({
      encryptedSettings: encryptJson({}, SETTINGS_ENCRYPTION_KEY),
      updatedAt: LATER,
    }).where(eq(userSettings.ownerEmail, "owner@example.com"));
    interleaving.release();

    assert.equal(await enabling, null);
    assert.equal((await repository.getConfiguration("owner@example.com")).supportState, "disabled");
  });
});

test("atomic enable rejects the configured LINE connection becoming inactive after its readiness snapshot", async () => {
  await withDatabase(async (db, { createSecondaryDb }) => {
    await seedReadySupport(db);
    const interleaving = createDecryptInterleaving();
    const repository = createSupportRepository(db, {
      encryptionKey: SETTINGS_ENCRYPTION_KEY,
      decryptSettings: interleaving.decrypt,
    });

    const enabling = repository.enableConfigurationIfReady(
      "owner@example.com",
      "11111111-1111-4111-8111-111111111111",
      LATER,
    );
    await interleaving.started;
    const secondaryDb = await createSecondaryDb();
    await secondaryDb.update(platformConnections).set({
      state: "needs_reconnect",
      updatedAt: LATER,
    }).where(eq(platformConnections.id, "11111111-1111-4111-8111-111111111111"));
    interleaving.release();

    assert.equal(await enabling, null);
    assert.equal((await repository.getConfiguration("owner@example.com")).supportState, "disabled");
  });
});

test("atomic enable rejects replacement of the configured LINE default after its readiness snapshot", async () => {
  await withDatabase(async (db, { createSecondaryDb }) => {
    await seedReadySupport(db);
    const interleaving = createDecryptInterleaving();
    const repository = createSupportRepository(db, {
      encryptionKey: SETTINGS_ENCRYPTION_KEY,
      decryptSettings: interleaving.decrypt,
    });

    const enabling = repository.enableConfigurationIfReady(
      "owner@example.com",
      "11111111-1111-4111-8111-111111111111",
      LATER,
    );
    await interleaving.started;
    const secondaryDb = await createSecondaryDb();
    await secondaryDb.update(platformConnections).set({
      state: "archived",
      updatedAt: LATER,
    }).where(eq(platformConnections.id, "11111111-1111-4111-8111-111111111111"));
    await secondaryDb.insert(platformConnections).values(
      connection("22222222-2222-4222-8222-222222222222", "owner@example.com"),
    );
    interleaving.release();

    assert.equal(await enabling, null);
    assert.equal((await repository.getConfiguration("owner@example.com")).supportState, "disabled");
  });
});

test("atomic enable accepts rotation to another current non-empty provider key", async () => {
  await withDatabase(async (db, { createSecondaryDb }) => {
    await seedReadySupport(db);
    const interleaving = createDecryptInterleaving();
    const repository = createSupportRepository(db, {
      encryptionKey: SETTINGS_ENCRYPTION_KEY,
      decryptSettings: interleaving.decrypt,
    });

    const enabling = repository.enableConfigurationIfReady(
      "owner@example.com",
      "11111111-1111-4111-8111-111111111111",
      LATER,
    );
    await interleaving.started;
    const secondaryDb = await createSecondaryDb();
    await secondaryDb.update(userSettings).set({
      encryptedSettings: encryptJson({ googleAiApiKey: "rotated-key" }, SETTINGS_ENCRYPTION_KEY),
      updatedAt: LATER,
    }).where(eq(userSettings.ownerEmail, "owner@example.com"));
    interleaving.release();

    const enabled = await enabling;
    assert.equal(enabled.supportState, "enabled");
    assert.equal(enabled.version, 1);
    assert.equal((await repository.getConfiguration("owner@example.com")).supportState, "enabled");
  });
});

async function withDatabase(run) {
  const directory = await mkdtemp(join(tmpdir(), "support-repository-"));
  const databaseUrl = pathToFileURL(join(directory, "support.db")).href;
  const client = createClient({ url: databaseUrl });
  const secondaryClients = [];
  try {
    await client.executeMultiple(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE platform_connections (
        id TEXT PRIMARY KEY NOT NULL, owner_email TEXT NOT NULL, platform TEXT NOT NULL,
        display_name TEXT NOT NULL, state TEXT NOT NULL, encrypted_credentials TEXT NOT NULL,
        credential_expires_at INTEGER, renewal_lease_id TEXT, renewal_lease_expires_at INTEGER,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE support_configurations (
        id TEXT PRIMARY KEY NOT NULL, owner_email TEXT NOT NULL, platform_connection_id TEXT NOT NULL,
        brand_name TEXT NOT NULL DEFAULT '', assistant_name TEXT NOT NULL DEFAULT '',
        reply_tone TEXT NOT NULL DEFAULT 'friendly', llm_provider TEXT, llm_model TEXT,
        support_state TEXT NOT NULL DEFAULT 'disabled', webhook_key_hash TEXT,
        webhook_verified_at INTEGER, redelivery_acknowledged_at INTEGER,
        native_replies_disabled_acknowledged_at INTEGER, provider_tested_at INTEGER,
        version INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        FOREIGN KEY (platform_connection_id) REFERENCES platform_connections(id)
      );
      CREATE UNIQUE INDEX support_configurations_connection_unique
        ON support_configurations(platform_connection_id);
      CREATE TABLE support_faqs (
        id TEXT PRIMARY KEY NOT NULL, owner_email TEXT NOT NULL, question TEXT NOT NULL,
        answer TEXT NOT NULL, category TEXT NOT NULL, keywords_json TEXT NOT NULL DEFAULT '[]',
        enabled INTEGER NOT NULL DEFAULT 1, priority INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE user_settings (
        owner_email TEXT PRIMARY KEY NOT NULL, encrypted_settings TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    await run(drizzle(client), {
      async createSecondaryDb() {
        const secondaryClient = createClient({ url: databaseUrl });
        secondaryClients.push(secondaryClient);
        await secondaryClient.execute("PRAGMA foreign_keys = ON");
        await secondaryClient.execute("PRAGMA busy_timeout = 5000");
        return drizzle(secondaryClient);
      },
    });
  } finally {
    await Promise.all(secondaryClients.map((secondaryClient) => secondaryClient.close()));
    await client.close();
    try {
      await rm(directory, { recursive: true, force: true });
    } catch (error) {
      if (error.code !== "EBUSY") throw error;
    }
  }
}

async function seedReadySupport(db) {
  await db.insert(platformConnections).values(
    connection("11111111-1111-4111-8111-111111111111", "owner@example.com"),
  );
  await db.insert(supportConfigurations).values(configurationRecord());
  await db.insert(supportFaqs).values({
    ...faqRecord(),
    id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    ownerEmail: "owner@example.com",
  });
  await db.insert(userSettings).values({
    ownerEmail: "owner@example.com",
    encryptedSettings: encryptJson({ googleAiApiKey: "current-key" }, SETTINGS_ENCRYPTION_KEY),
    updatedAt: NOW,
  });
}

function createDecryptInterleaving() {
  let release;
  let announceStarted;
  let reads = 0;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const started = new Promise((resolve) => {
    announceStarted = resolve;
  });
  return {
    started,
    release,
    async decrypt(encryptedSettings) {
      const settings = decryptJson(encryptedSettings, SETTINGS_ENCRYPTION_KEY);
      reads += 1;
      if (reads === 1) {
        announceStarted();
        await gate;
      }
      return settings;
    },
  };
}

function connection(id, ownerEmail) {
  return {
    id,
    ownerEmail,
    platform: "line",
    displayName: id,
    state: "active",
    encryptedCredentials: "encrypted",
    credentialExpiresAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function configurationRecord() {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    ownerEmail: "owner@example.com",
    platformConnectionId: "11111111-1111-4111-8111-111111111111",
    brandName: "Acme",
    assistantName: "Ada",
    replyTone: "friendly",
    llmProvider: "google",
    llmModel: "gemini-3.1-flash-lite",
    supportState: "disabled",
    webhookKeyHash: "secret-hash",
    webhookVerifiedAt: NOW,
    redeliveryAcknowledgedAt: NOW,
    nativeRepliesDisabledAcknowledgedAt: NOW,
    providerTestedAt: null,
    version: 0,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function faqRecord() {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    question: "Question",
    answer: "Answer",
    category: "general",
    keywordsJson: '["question"]',
    enabled: true,
    priority: 0,
    createdAt: NOW,
    updatedAt: NOW,
  };
}
