export function createSupportRetentionCronRouteHandlers({
  createService,
  env = process.env,
  respond = (body, init) => Response.json(body, init),
}) {
  return {
    async GET(request) {
      const secret = env.CRON_SECRET;
      if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
        return respond({ error: "Unauthorized cron request." }, { status: 401 });
      }
      try {
        const result = await createService().purgeExpiredContent();
        return respond({
          messagesCleared: safeCount(result?.messagesCleared),
          replyTokensCleared: safeCount(result?.replyTokensCleared),
          outboundBodiesCleared: safeCount(result?.outboundBodiesCleared),
        });
      } catch {
        return respond({ error: "Retention cleanup failed." }, { status: 500 });
      }
    },
  };
}

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
