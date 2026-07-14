import { publishClaimedPost } from "../posts/post-service.js";

export async function runDuePostScheduler({ repository, getConnection, createGetConnection = () => getConnection, publishTargets, now = new Date() }) {
  const claimedPosts = await repository.claimDueScheduledPosts(now);
  const connectionResolver = createGetConnection();
  const posts = [];

  for (const post of claimedPosts) {
    try {
      const result = await publishClaimedPost({
        post,
        repository,
        getConnection: connectionResolver,
        publishTargets,
        now,
      });
      posts.push({ id: post.id, status: result.status });
    } catch (error) {
      posts.push({ id: post.id, status: error?.retryable ? "scheduled" : "failed" });
    }
  }

  return { posts };
}

export function createCronRouteHandlers({ runScheduler, env = process.env, now = () => new Date(), respond = (body, init) => Response.json(body, init) }) {
  return {
    async GET(request) {
      const secret = env.CRON_SECRET;
      if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
        return respond({ error: "Unauthorized cron request." }, { status: 401 });
      }

      const result = await runScheduler();
      return respond({ checkedAt: now().toISOString(), ...result });
    },
  };
}
