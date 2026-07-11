import { normalizeEmail } from "../auth/policy.js";
import { buildPlatformPreviews } from "../platform-preview/build-platform-previews.js";
import { filterActivePlatforms } from "../platforms/platform-config.js";
import { publishTargets as publishPlatformTargets } from "../platforms/publish-service.js";
import { POST_STATUS } from "./post-status.js";
import { computeScheduledFor } from "./schedule-time.js";

export async function createPost({ ownerEmail, input, mode, repository, now = new Date() }) {
  const owner = requireOwner(ownerEmail);
  const scheduled = mode === "scheduled";
  if (!scheduled && mode !== "now") throw routeError("mode must be either now or scheduled.", 400);

  const status = scheduled ? POST_STATUS.SCHEDULED : POST_STATUS.DRAFT;
  const scheduledFor = scheduled
    ? computeScheduledFor({
        scheduledDate: input.scheduledDate,
        scheduledTime: input.scheduledTime,
        now,
      })
    : null;
  const targets = activeTargets(input.targets);
  if (targets.length === 0) throw routeError("At least one active platform target is required.", 400);

  return repository.createPostWithTargets({
    post: {
      ownerEmail: owner,
      productName: String(input.productName ?? ""),
      productFeatures: String(input.productFeatures ?? ""),
      imagePrompt: input.imagePrompt ?? null,
      imageImgurUrl: input.imageUrl ?? null,
      status,
      scheduledFor,
      publishingStartedAt: null,
      publishedAt: null,
      createdAt: now,
      updatedAt: now,
    },
    targetRows: targets.map((target) => ({
      platform: target.platform,
      content: String(target.content ?? ""),
      hashtagsJson: JSON.stringify(target.hashtags ?? []),
      status,
      externalPostId: null,
      errorMessage: null,
      publishedAt: null,
      createdAt: now,
      updatedAt: now,
    })),
  });
}

export async function listPosts({ ownerEmail, repository }) {
  return repository.listPostsByOwner(requireOwner(ownerEmail));
}

export async function cancelScheduledPost({ ownerEmail, postId, repository, now = new Date() }) {
  const owner = requireOwner(ownerEmail);
  const id = toPostId(postId);
  const cancelled = await repository.cancelScheduledPost(owner, id, now);
  if (cancelled) return cancelled;

  const current = await repository.findPostByOwner(owner, id);
  throw routeError(
    current ? `Post cannot be cancelled from status ${current.status}.` : "Post was not found.",
    current ? 409 : 404,
  );
}

export async function publishPost({
  ownerEmail,
  postId,
  repository,
  readSettings,
  publishTargets = publishPlatformTargets,
  now = new Date(),
}) {
  const owner = requireOwner(ownerEmail);
  const id = toPostId(postId);
  const post = await repository.claimPostForPublish(owner, id, now);
  if (!post) {
    const current = await repository.findPostByOwner(owner, id);
    throw routeError(
      current ? `Post cannot be published from status ${current.status}.` : "Post was not found.",
      current ? 409 : 404,
    );
  }

  const settings = await readSettings(owner);
  const previews = buildPlatformPreviews({
    imageUrl: post.imageImgurUrl,
    targets: post.targets.map((target) => ({
      platform: target.platform,
      content: target.content,
      hashtags: parseHashtags(target.hashtagsJson),
    })),
  });
  const targets = Object.values(previews).map((preview) => ({
    platform: preview.platform,
    publishPayload: preview.publishPayload,
  }));
  const results = (await publishTargets({ targets, settings })).map((result) => ({
    ...result,
    error: result.error ? redactProviderError(result.error, settings) : result.error,
  }));
  return repository.recordPublishResults(owner, id, results, now);
}

function activeTargets(targets) {
  const byPlatform = new Map();
  for (const target of Array.isArray(targets) ? targets : []) {
    if (filterActivePlatforms([target?.platform]).length > 0 && !byPlatform.has(target.platform)) {
      byPlatform.set(target.platform, target);
    }
  }
  return [...byPlatform.values()];
}

function parseHashtags(value) {
  try {
    const hashtags = JSON.parse(value ?? "[]");
    return Array.isArray(hashtags) ? hashtags : [];
  } catch {
    return [];
  }
}

function redactProviderError(error, settings) {
  let message = String(error);
  for (const secret of Object.values(settings ?? {}).filter(Boolean).map(String)) {
    message = message.split(secret).join("[redacted]");
  }
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/access_token=([^&\s]+)/gi, "access_token=[redacted]");
}

function requireOwner(ownerEmail) {
  const owner = normalizeEmail(ownerEmail);
  if (!owner) throw routeError("A post owner is required.", 400);
  return owner;
}

function toPostId(postId) {
  const id = Number(postId);
  if (!Number.isInteger(id) || id <= 0) throw routeError("Post id must be a positive integer.", 400);
  return id;
}

function routeError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}
