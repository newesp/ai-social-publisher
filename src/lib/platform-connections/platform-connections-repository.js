import { and, desc, eq, gt, inArray, isNull, lte, or } from "drizzle-orm";

import { createDbClient } from "../db/index.js";
import { oauthTransactions, platformConnections, postTargets } from "../db/schema.js";

const BLOCKING_TARGET_STATES = ["pending", "draft", "scheduled", "publishing"];

export function createPlatformConnectionsRepository(db = createDbClient()) {
  return {
    async createConnection(record) {
      const [created] = await db.insert(platformConnections).values(record).returning();
      return created;
    },
    async replaceDefaultConnection(record) {
      return db.transaction(async (tx) => {
        await tx.update(platformConnections).set({ state: "archived", updatedAt: record.updatedAt }).where(and(
          eq(platformConnections.ownerEmail, record.ownerEmail), eq(platformConnections.platform, record.platform), eq(platformConnections.state, "active"),
        ));
        const [created] = await tx.insert(platformConnections).values(record).returning();
        return created;
      });
    },
    async findDefaultByOwnerAndPlatform(ownerEmail, platform) {
      const [record] = await db.select().from(platformConnections).where(and(
        eq(platformConnections.ownerEmail, ownerEmail), eq(platformConnections.platform, platform), eq(platformConnections.state, "active"),
      )).orderBy(desc(platformConnections.updatedAt)).limit(1);
      return record ?? null;
    },
    async findConnectionByIdAndOwner(id, ownerEmail) {
      const [record] = await db.select().from(platformConnections).where(and(
        eq(platformConnections.id, id), eq(platformConnections.ownerEmail, ownerEmail),
      )).limit(1);
      return record ?? null;
    },
    async replaceConnectionCredentials(id, ownerEmail, changes) {
      const [record] = await db.update(platformConnections).set(changes).where(and(
        eq(platformConnections.id, id), eq(platformConnections.ownerEmail, ownerEmail),
      )).returning();
      return record ?? null;
    },
    async replaceConnectionCredentialsIfUnchanged(id, ownerEmail, previousUpdatedAt, changes) {
      const [record] = await db.update(platformConnections).set(changes).where(and(
        eq(platformConnections.id, id), eq(platformConnections.ownerEmail, ownerEmail), inArray(platformConnections.state, ["active", "archived"]),
        eq(platformConnections.updatedAt, previousUpdatedAt),
      )).returning();
      return record ?? null;
    },
    async acquireRenewalLease(id, ownerEmail, leaseId, leaseExpiresAt, acquiredAt) {
      const [record] = await db.update(platformConnections).set({ renewalLeaseId: leaseId, renewalLeaseExpiresAt: leaseExpiresAt }).where(and(
        eq(platformConnections.id, id), eq(platformConnections.ownerEmail, ownerEmail), inArray(platformConnections.state, ["active", "archived"]),
        or(isNull(platformConnections.renewalLeaseId), isNull(platformConnections.renewalLeaseExpiresAt), lte(platformConnections.renewalLeaseExpiresAt, acquiredAt)),
      )).returning();
      return record ?? null;
    },
    async completeRenewalLease(id, ownerEmail, leaseId, changes) {
      const [record] = await db.update(platformConnections).set({
        ...changes, renewalLeaseId: null, renewalLeaseExpiresAt: null,
      }).where(and(
        eq(platformConnections.id, id), eq(platformConnections.ownerEmail, ownerEmail), inArray(platformConnections.state, ["active", "archived"]),
        eq(platformConnections.renewalLeaseId, leaseId),
      )).returning();
      return record ?? null;
    },
    async releaseRenewalLease(id, ownerEmail, leaseId) {
      const [record] = await db.update(platformConnections).set({ renewalLeaseId: null, renewalLeaseExpiresAt: null }).where(and(
        eq(platformConnections.id, id), eq(platformConnections.ownerEmail, ownerEmail), eq(platformConnections.renewalLeaseId, leaseId),
      )).returning();
      return record ?? null;
    },
    async markConnectionNeedsReconnect(id, ownerEmail, updatedAt) {
      const [record] = await db.update(platformConnections).set({ state: "needs_reconnect", updatedAt }).where(and(
        eq(platformConnections.id, id), eq(platformConnections.ownerEmail, ownerEmail), inArray(platformConnections.state, ["active", "archived"]),
      )).returning();
      return record ?? null;
    },
    async archiveConnection(id, ownerEmail, updatedAt) {
      const [record] = await db.update(platformConnections).set({ state: "archived", updatedAt }).where(and(
        eq(platformConnections.id, id), eq(platformConnections.ownerEmail, ownerEmail),
      )).returning();
      return record ?? null;
    },
    async archiveActiveDefaultConnection(ownerEmail, platform, updatedAt) {
      const records = await db.update(platformConnections).set({ state: "archived", updatedAt }).where(and(
        eq(platformConnections.ownerEmail, ownerEmail), eq(platformConnections.platform, platform), eq(platformConnections.state, "active"),
      )).returning();
      return records[0] ?? null;
    },
    async disconnectActiveConnection(ownerEmail, platform, clearedCredentials, updatedAt) {
      return retryBusyTransaction(() => db.transaction(async (tx) => {
        const [connection] = await tx.select().from(platformConnections).where(and(
          eq(platformConnections.ownerEmail, ownerEmail), eq(platformConnections.platform, platform), eq(platformConnections.state, "active"),
        )).limit(1);
        if (!connection) return { status: "not_found" };
        const [blocking] = await tx.select({ id: postTargets.id }).from(postTargets).where(and(
          eq(postTargets.platformConnectionId, connection.id), inArray(postTargets.status, BLOCKING_TARGET_STATES),
        )).limit(1);
        if (blocking) return { status: "blocked" };
        const [disconnected] = await tx.update(platformConnections).set({
          state: "disconnected", encryptedCredentials: clearedCredentials, credentialExpiresAt: null,
          renewalLeaseId: null, renewalLeaseExpiresAt: null, updatedAt,
        }).where(and(
          eq(platformConnections.id, connection.id), eq(platformConnections.ownerEmail, ownerEmail), eq(platformConnections.platform, platform), eq(platformConnections.state, "active"),
        )).returning();
        return disconnected ? { status: "disconnected", connection } : { status: "not_found" };
      }));
    },
    async listConnectionAvailability(ownerEmail) {
      return db.select({ platform: platformConnections.platform, state: platformConnections.state,
        displayName: platformConnections.displayName, credentialExpiresAt: platformConnections.credentialExpiresAt })
        .from(platformConnections).where(eq(platformConnections.ownerEmail, ownerEmail));
    },
    async createOAuthTransaction(record) {
      const [created] = await db.insert(oauthTransactions).values(record).returning();
      return created;
    },
    async consumeOAuthTransaction(id, ownerEmail, now) {
      const [record] = await db.update(oauthTransactions).set({ consumedAt: now }).where(and(
        eq(oauthTransactions.id, id), eq(oauthTransactions.ownerEmail, ownerEmail), isNull(oauthTransactions.consumedAt), gt(oauthTransactions.expiresAt, now),
      )).returning();
      return record ?? null;
    },
    async findOAuthTransactionByIdAndOwner(id, ownerEmail, now) {
      const [record] = await db.select().from(oauthTransactions).where(and(
        eq(oauthTransactions.id, id), eq(oauthTransactions.ownerEmail, ownerEmail), isNull(oauthTransactions.consumedAt), gt(oauthTransactions.expiresAt, now),
      )).limit(1);
      return record ?? null;
    },
    async purgeExpiredOAuthTransactions(now) {
      await db.delete(oauthTransactions).where(lte(oauthTransactions.expiresAt, now));
    },
  };
}

async function retryBusyTransaction(transaction, attempts = 8) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await transaction();
    } catch (error) {
      if (error?.code !== "SQLITE_BUSY" || attempt === attempts - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
    }
  }
}
