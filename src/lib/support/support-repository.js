import { and, desc, eq } from "drizzle-orm";

import { createDbClient } from "../db/index.js";
import { platformConnections, supportConfigurations, supportFaqs } from "../db/schema.js";
import { normalizeEmail } from "../auth/policy.js";

export function createSupportRepository(db = createDbClient()) {
  return {
    async findOwnedLineConnection(ownerEmail, connectionId) {
      return findOwnedLineConnection(db, normalizeOwner(ownerEmail), connectionId);
    },

    async getConfiguration(ownerEmail) {
      const [record] = await db.select().from(supportConfigurations)
        .where(eq(supportConfigurations.ownerEmail, normalizeOwner(ownerEmail)))
        .orderBy(desc(supportConfigurations.updatedAt))
        .limit(1);
      return record ?? null;
    },

    async createConfiguration(ownerEmail, record) {
      const owner = normalizeOwner(ownerEmail);
      if (!await findOwnedLineConnection(db, owner, record.platformConnectionId)) return null;
      const [created] = await db.insert(supportConfigurations).values({
        ...record,
        ownerEmail: owner,
      }).returning();
      return created;
    },

    async updateConfiguration(ownerEmail, id, changes, { expectedVersion } = {}) {
      const owner = normalizeOwner(ownerEmail);
      if (expectedVersion != null
        && (!Number.isInteger(expectedVersion) || expectedVersion < 0)) return null;
      const safeChanges = pickChanges(changes, [
        "platformConnectionId", "brandName", "assistantName", "replyTone", "llmProvider", "llmModel",
        "supportState", "webhookKeyHash", "webhookVerifiedAt", "redeliveryAcknowledgedAt",
        "nativeRepliesDisabledAcknowledgedAt", "providerTestedAt", "version", "updatedAt",
      ]);
      if (safeChanges.platformConnectionId
        && !await findOwnedLineConnection(db, owner, safeChanges.platformConnectionId)) return null;
      const predicates = [
        eq(supportConfigurations.ownerEmail, owner),
        eq(supportConfigurations.id, id),
      ];
      if (expectedVersion != null) {
        predicates.push(eq(supportConfigurations.version, expectedVersion));
      }
      const [updated] = await db.update(supportConfigurations).set(safeChanges)
        .where(and(...predicates))
        .returning();
      return updated ?? null;
    },

    async listFaqs(ownerEmail) {
      return db.select().from(supportFaqs)
        .where(eq(supportFaqs.ownerEmail, normalizeOwner(ownerEmail)))
        .orderBy(desc(supportFaqs.priority), desc(supportFaqs.updatedAt));
    },

    async createFaq(ownerEmail, record) {
      const [created] = await db.insert(supportFaqs).values({
        ...record,
        ownerEmail: normalizeOwner(ownerEmail),
      }).returning();
      return created;
    },

    async updateFaq(ownerEmail, id, changes) {
      const safeChanges = pickChanges(changes, [
        "question", "answer", "category", "keywordsJson", "enabled", "priority", "updatedAt",
      ]);
      const [updated] = await db.update(supportFaqs).set(safeChanges).where(and(
        eq(supportFaqs.ownerEmail, normalizeOwner(ownerEmail)),
        eq(supportFaqs.id, id),
      )).returning();
      return updated ?? null;
    },

    async deleteFaq(ownerEmail, id) {
      const [deleted] = await db.delete(supportFaqs).where(and(
        eq(supportFaqs.ownerEmail, normalizeOwner(ownerEmail)),
        eq(supportFaqs.id, id),
      )).returning();
      return deleted ?? null;
    },
  };
}

async function findOwnedLineConnection(db, ownerEmail, connectionId) {
  const [record] = await db.select({
    id: platformConnections.id,
    ownerEmail: platformConnections.ownerEmail,
    platform: platformConnections.platform,
    state: platformConnections.state,
  }).from(platformConnections).where(and(
    eq(platformConnections.ownerEmail, ownerEmail),
    eq(platformConnections.id, connectionId),
    eq(platformConnections.platform, "line"),
    eq(platformConnections.state, "active"),
  )).limit(1);
  return record ?? null;
}

function pickChanges(changes, keys) {
  return Object.fromEntries(
    keys.filter((key) => Object.hasOwn(changes ?? {}, key)).map((key) => [key, changes[key]]),
  );
}

function normalizeOwner(ownerEmail) {
  const owner = normalizeEmail(ownerEmail);
  if (!owner) throw routeError("Authentication is required.", 401);
  return owner;
}

function routeError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}
