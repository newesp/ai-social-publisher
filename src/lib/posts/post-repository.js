import { and, desc, eq, inArray } from "drizzle-orm";

import { createDbClient } from "../db/index.js";
import { postTargets, posts } from "../db/schema.js";
import { POST_STATUS, resolvePostStatus } from "./post-status.js";

export function createPostRepository(db = createDbClient()) {
  return {
    async createPostWithTargets({ post, targetRows }) {
      return db.transaction(async (tx) => {
        const [createdPost] = await tx.insert(posts).values(post).returning();
        const createdTargets = targetRows.length
          ? await tx.insert(postTargets).values(targetRows.map((target) => ({ ...target, postId: createdPost.id }))).returning()
          : [];
        return { ...createdPost, targets: createdTargets };
      });
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
        await tx.update(postTargets).set({ status: POST_STATUS.PUBLISHING, updatedAt: now }).where(eq(postTargets.postId, postId));
        return findPostByOwner(tx, ownerEmail, postId);
      });
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
