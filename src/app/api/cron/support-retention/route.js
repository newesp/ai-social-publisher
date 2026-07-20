import { NextResponse } from "next/server";

import { createSupportRepository } from "../../../../lib/support/support-repository.js";
import { createSupportRetentionCronRouteHandlers } from "../../../../lib/support/retention/support-retention-cron.js";
import { createSupportRetentionService } from "../../../../lib/support/retention/support-retention-service.js";

const handlers = createSupportRetentionCronRouteHandlers({
  createService: () => createSupportRetentionService({ repository: createSupportRepository() }),
  respond: (body, init) => NextResponse.json(body, init),
});

export const GET = handlers.GET;
