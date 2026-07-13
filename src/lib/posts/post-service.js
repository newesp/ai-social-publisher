import { normalizeEmail } from "../auth/policy.js";
import { buildPlatformPreviews } from "../platform-preview/build-platform-previews.js";
import { filterActivePlatforms } from "../platforms/platform-config.js";
import { publishTargets as publishPlatformTargets } from "../platforms/publish-service.js";
import { POST_STATUS } from "./post-status.js";
import { computeScheduledFor } from "./schedule-time.js";

export async function createPost({ ownerEmail, input, mode, repository, resolveConnection, now = new Date() }) {
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
  const boundTargets = [];
  for (const target of targets) {
    const connection = await resolveConnection?.(owner, target.platform);
    if (!isConnectionAvailable(connection, owner, target.platform, { activeOnly: true })) throw reconnectError();
    boundTargets.push({ target, connection });
  }

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
    targetRows: boundTargets.map(({ target, connection }) => ({
      platform: target.platform,
      platformConnectionId: connection.id,
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
  getConnection,
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

  return publishClaimedPost({ post, repository, getConnection, publishTargets, now });
}

export async function publishClaimedPost({
  post,
  repository,
  getConnection,
  publishTargets = publishPlatformTargets,
  now = new Date(),
}) {
  const owner = requireOwner(post.ownerEmail);

  let results;
  try {
    const connections = [];
    const publishableTargets = [];
    const unavailableResults = [];
    for (const target of post.targets) {
      if (!target.platformConnectionId) {
        unavailableResults.push(failedReconnectResult(target.platform));
        continue;
      }
      let connection;
      try {
        connection = await getConnection?.(owner, target.platformConnectionId);
      } catch {
        unavailableResults.push(failedReconnectResult(target.platform));
        continue;
      }
      if (!isConnectionAvailable(connection, owner, target.platform)) {
        unavailableResults.push(failedReconnectResult(target.platform));
        continue;
      }
      connections.push(connection);
      publishableTargets.push(target);
    }
    if (publishableTargets.length === 0) {
      return repository.recordPublishResults(owner, post.id, unavailableResults, now);
    }
    const previews = buildPlatformPreviews({
      imageUrl: post.imageImgurUrl,
      targets: publishableTargets.map((target) => ({
        platform: target.platform,
        content: target.content,
        hashtags: parseHashtags(target.hashtagsJson),
      })),
    });
    const targets = Object.values(previews).map((preview) => ({
      platform: preview.platform,
      platformConnectionId: publishableTargets.find((target) => target.platform === preview.platform).platformConnectionId,
      publishPayload: preview.publishPayload,
    }));
    results = [
      ...terminalResults(publishableTargets, await publishTargets({ targets, connections }), connections, owner),
      ...unavailableResults,
    ];
  } catch {
    results = post.targets.map((target) => ({
      platform: target.platform,
      status: POST_STATUS.FAILED,
      error: "Publishing failed before a provider response was recorded.",
    }));
  }
  return repository.recordPublishResults(owner, post.id, results, now);
}

function terminalResults(targets, providerResults, connections, owner) {
  const resultsByPlatform = new Map(
    (Array.isArray(providerResults) ? providerResults : []).map((result) => [result?.platform, result]),
  );
  return targets.map((target) => {
    const result = resultsByPlatform.get(target.platform);
    if (result?.status === POST_STATUS.PUBLISHED || result?.status === POST_STATUS.FAILED) {
      return {
        ...result,
        error: result.error ? redactProviderError(result.error, connections, owner) : result.error,
      };
    }
    return {
      platform: target.platform,
      status: POST_STATUS.FAILED,
      error: "Publishing did not return a terminal result.",
    };
  });
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

function redactProviderError(error, connections, owner) {
  let message = String(error);
  if (owner) message = message.split(owner).join("[redacted]");
  for (const secret of collectSecretValues((connections ?? []).map((connection) => connection?.credentials))) {
    message = message.split(secret).join("[redacted]");
  }
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/access_token=([^&\s]+)/gi, "access_token=[redacted]");
}

function collectSecretValues(value, values = [], seen = new WeakSet()) {
  if (value == null) return values;
  if (typeof value === "string" || typeof value === "number") {
    if (String(value)) values.push(String(value));
    return values;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectSecretValues(item, values, seen);
    return values;
  }
  if (typeof value === "object") {
    if (seen.has(value)) return values;
    seen.add(value);
    for (const item of Object.values(value)) collectSecretValues(item, values, seen);
  }
  return values;
}

function isConnectionAvailable(connection, owner, platform, { activeOnly = false } = {}) {
  if (!connection || !String(connection.id ?? "").trim()) return false;
  if (normalizeEmail(connection.ownerEmail) !== owner || connection.platform !== platform) return false;
  return activeOnly ? connection.state === "active" : connection.state === "active" || connection.state === "archived";
}

function failedReconnectResult(platform) {
  return { platform, status: POST_STATUS.FAILED, error: reconnectError().message };
}

function reconnectError() {
  return routeError("The selected platform connection needs to be reconnected.", 409);
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
