import { start } from "workflow/api";

import { requireSettingsAccess, routeErrorResponse } from "../../../../lib/auth/route-guards.js";
import { requireSameOrigin } from "../../../../lib/platform-connections/platform-connection-route-handlers.js";
import { createSupportWorkflowSmokeHandler } from "../../../../lib/support/routes/support-workflow-smoke-handler.js";

const handler = createSupportWorkflowSmokeHandler({
  requireOwner: requireSettingsAccess,
  requireSameOrigin,
  startWorkflow: start,
  enabled: process.env.SUPPORT_WORKFLOW_SMOKE_ENABLED === "true",
});

export async function POST(request) {
  try {
    return await handler(request);
  } catch (error) {
    return routeErrorResponse(error, Response);
  }
}
