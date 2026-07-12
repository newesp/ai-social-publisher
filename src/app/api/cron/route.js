import { NextResponse } from "next/server";

import { createPostRepository } from "../../../lib/posts/post-repository.js";
import { createCronRouteHandlers, runDuePostScheduler } from "../../../lib/scheduler/run-due-post-scheduler.js";
import { publishTargets } from "../../../lib/platforms/publish-service.js";
import { readSettings } from "../../../lib/settings/settings-store.js";

const handlers = createCronRouteHandlers({
  runScheduler: () => runDuePostScheduler({
    repository: createPostRepository(),
    readSettings,
    publishTargets,
  }),
  respond: (body, init) => NextResponse.json(body, init),
});

export const GET = handlers.GET;
