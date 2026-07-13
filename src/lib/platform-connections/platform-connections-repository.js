import { and, desc, eq, gt, inArray, isNull, lte } from "drizzle-orm";

import { createDbClient } from "../db/index.js";
import { oauthTransactions, platformConnections } from "../db/schema.js";

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
