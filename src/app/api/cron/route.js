import { NextResponse } from "next/server";

import { createPostRepository } from "../../../lib/posts/post-repository.js";
import { createPublishingConnectionResolver } from "../../../lib/posts/post-route-handlers.js";
import { createCronRouteHandlers, runDuePostScheduler } from "../../../lib/scheduler/run-due-post-scheduler.js";
import { publishTargets } from "../../../lib/platforms/publish-service.js";
import { getPlatformConnectionServices } from "../../../lib/platform-connections/platform-connection-route-handlers.js";

const handlers = createCronRouteHandlers({
  runScheduler: () => runDuePostScheduler({
    repository: createPostRepository(),
    createGetConnection: () => createPublishingConnectionResolver(getPlatformConnectionServices()),
    publishTargets,
  }),
  respond: (body, init) => NextResponse.json(body, init),
});

export const GET = handlers.GET;
