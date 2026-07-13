import { and, desc, eq, inArray, lte } from "drizzle-orm";

import { createDbClient } from "../db/index.js";
import { platformConnections, postTargets, posts } from "../db/schema.js";
import { POST_STATUS, resolvePostStatus } from "./post-status.js";

export function createPostRepository(db = createDbClient()) {
  return {
    async createPostWithTargets({ post, targetRows }) {
      return retryBusyTransaction(() => db.transaction(async (tx) => {
        for (const target of targetRows) {
          if (!target.platformConnectionId) throw reconnectError();
          const [connection] = await tx.select({ id: platformConnections.id }).from(platformConnections).where(and(
            eq(platformConnections.id, target.platformConnectionId),
            eq(platformConnections.ownerEmail, post.ownerEmail),
            eq(platformConnections.platform, target.platform),
            eq(platformConnections.state, "active"),
          )).limit(1);
          if (!connection) throw reconnectError();
        }
        const [createdPost] = await tx.insert(posts).values(post).returning();
        const createdTargets = targetRows.length
          ? await tx.insert(postTargets).values(targetRows.map((target) => ({ ...target, postId: createdPost.id }))).returning()
          : [];
        return { ...createdPost, targets: createdTargets };
      }));
    },
    async listPostsByOwner(ownerEmail) {
      const postRows = await db.select().from(posts).where(eq(posts.ownerEmail, ownerEmail)).orderBy(desc(posts.createdAt));
      return attachTargets(db, postRows);
    },
    async findPostByOwner(ownerEmail, postId) {
      const [post] = await db.select().from(posts).where(and(eq(posts.ownerEmail, ownerEmail), eq(posts.id, postId)));
      if (!post) return null;
      const [result] = await attachTargets(db, [post]);
      return result;
    },
    async cancelScheduledPost(ownerEmail, postId, now) {
      return db.transaction(async (tx) => {
        const [updated] = await tx.update(posts).set({ status: POST_STATUS.CANCELLED, updatedAt: now })
          .where(and(eq(posts.ownerEmail, ownerEmail), eq(posts.id, postId), eq(posts.status, POST_STATUS.SCHEDULED))).returning();
        if (!updated) return null;
        await tx.update(postTargets).set({ status: POST_STATUS.CANCELLED, updatedAt: now }).where(eq(postTargets.postId, postId));
        return findPostByOwner(tx, ownerEmail, postId);
      });
    },
    async claimPostForPublish(ownerEmail, postId, now) {
      return db.transaction(async (tx) => {
        const [updated] = await tx.update(posts).set({ status: POST_STATUS.PUBLISHING, publishingStartedAt: now, updatedAt: now })
          .where(and(eq(posts.ownerEmail, ownerEmail), eq(posts.id, postId), eq(posts.status, POST_STATUS.DRAFT))).returning();
        if (!updated) return null;
        await tx.update(postTargets).set({ status: POST_STATUS.PUBLISHING, updatedAt: now }).where(and(
          eq(postTargets.postId, postId), eq(postTargets.status, POST_STATUS.DRAFT),
        ));
        return findPostByOwner(tx, ownerEmail, postId);
      });
    },
    async claimDueScheduledPosts(now) {
      return retryBusyTransaction(() => db.transaction(async (tx) => {
        const duePosts = await tx.update(posts).set({
          status: POST_STATUS.PUBLISHING,
          publishingStartedAt: now,
          updatedAt: now,
        }).where(and(
          eq(posts.status, POST_STATUS.SCHEDULED),
          lte(posts.scheduledFor, now),
        )).returning();
        const claimedPosts = [];
        for (const duePost of duePosts) {
          await tx.update(postTargets).set({ status: POST_STATUS.PUBLISHING, updatedAt: now })
            .where(and(eq(postTargets.postId, duePost.id), eq(postTargets.status, POST_STATUS.SCHEDULED)));
          claimedPosts.push(await findPostByOwner(tx, duePost.ownerEmail, duePost.id));
        }
        return claimedPosts;
      }));
    },
    async requeueClaimedPost(ownerEmail, postId, status, retryAt, now) {
      return retryBusyTransaction(() => db.transaction(async (tx) => {
        const [updated] = await tx.update(posts).set({
          status, scheduledFor: status === POST_STATUS.SCHEDULED ? retryAt : null,
          publishingStartedAt: null, updatedAt: now,
        }).where(and(eq(posts.ownerEmail, ownerEmail), eq(posts.id, postId), eq(posts.status, POST_STATUS.PUBLISHING))).returning();
        if (!updated) return null;
        await tx.update(postTargets).set({ status, updatedAt: now }).where(and(
          eq(postTargets.postId, postId), eq(postTargets.status, POST_STATUS.PUBLISHING),
        ));
        return findPostByOwner(tx, ownerEmail, postId);
      }));
    },
    async recordPublishProgressAndRequeue(ownerEmail, postId, results, status, retryAt, now) {
      return retryBusyTransaction(() => db.transaction(async (tx) => {
        const [current] = await tx.select({ id: posts.id }).from(posts).where(and(
          eq(posts.ownerEmail, ownerEmail), eq(posts.id, postId), eq(posts.status, POST_STATUS.PUBLISHING),
        )).limit(1);
        if (!current) return null;
        for (const result of results.filter((item) => item.status === POST_STATUS.PUBLISHED)) {
          await tx.update(postTargets).set({
            status: POST_STATUS.PUBLISHED, externalPostId: result.externalId ?? null, errorMessage: null,
            publishedAt: now, updatedAt: now,
          }).where(and(eq(postTargets.postId, postId), eq(postTargets.platform, result.platform), eq(postTargets.status, POST_STATUS.PUBLISHING)));
        }
        await tx.update(postTargets).set({ status, updatedAt: now }).where(and(
          eq(postTargets.postId, postId), eq(postTargets.status, POST_STATUS.PUBLISHING),
        ));
        await tx.update(posts).set({ status, scheduledFor: status === POST_STATUS.SCHEDULED ? retryAt : null,
          publishingStartedAt: null, updatedAt: now }).where(and(eq(posts.ownerEmail, ownerEmail), eq(posts.id, postId)));
        return findPostByOwner(tx, ownerEmail, postId);
      }));
    },
    async recordPublishResults(ownerEmail, postId, results, now) {
      return db.transaction(async (tx) => {
        const current = await findPostByOwner(tx, ownerEmail, postId);
        if (!current) throw new Error("The claimed post is no longer available.");
        for (const result of results) {
          await tx.update(postTargets).set({
            status: result.status,
            externalPostId: result.externalId ?? null,
            errorMessage: result.error ?? null,
            publishedAt: result.status === POST_STATUS.PUBLISHED ? now : null,
            updatedAt: now,
          }).where(and(eq(postTargets.postId, postId), eq(postTargets.platform, result.platform)));
        }
        const targets = await targetsForPosts(tx, [postId]);
        const status = resolvePostStatus(targets);
        await tx.update(posts).set({ status, publishedAt: status === POST_STATUS.PUBLISHED ? now : null, updatedAt: now })
          .where(and(eq(posts.ownerEmail, ownerEmail), eq(posts.id, postId)));
        return findPostByOwner(tx, ownerEmail, postId);
      });
    },
  };
}

function reconnectError() {
  const error = new Error("The selected platform connection needs to be reconnected.");
  error.status = 409;
  return error;
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

async function findPostByOwner(db, ownerEmail, postId) {
  const [post] = await db.select().from(posts).where(and(eq(posts.ownerEmail, ownerEmail), eq(posts.id, postId)));
  if (!post) return null;
  const [result] = await attachTargets(db, [post]);
  return result;
}

async function attachTargets(db, postRows) {
  if (postRows.length === 0) return [];
  const targets = await targetsForPosts(db, postRows.map((post) => post.id));
  return postRows.map((post) => ({ ...post, targets: targets.filter((target) => target.postId === post.id) }));
}

function targetsForPosts(db, postIds) {
  return db.select().from(postTargets).where(inArray(postTargets.postId, postIds));
}
