import { NextResponse } from "next/server";
import { start } from "workflow/api";
import { requireSettingsAccess, routeErrorResponse } from "../../../../../../lib/auth/route-guards.js";
import { requireSameOrigin } from "../../../../../../lib/platform-connections/platform-connection-route-handlers.js";
import { createSupportHumanActionRouteHandlers } from "../../../../../../lib/support/routes/support-human-action-route-handlers.js";
import { getSupportStore } from "../../../../../../lib/support/support-store.js";
import { supportTransitionWorkflow } from "../../../../../../lib/support/workflows/support-transition-workflow.js";
const handlers = createSupportHumanActionRouteHandlers({ requireOwner: requireSettingsAccess, requireSameOrigin, getStore: getSupportStore, startTransition: startSupportTransitionWorkflow, respond: (body, init) => NextResponse.json(body, init) });
export async function POST(request, { params }) { try { return await handlers.requestTransition(request, (await params).id); } catch (error) { return routeErrorResponse(error, NextResponse); } }

async function startSupportTransitionWorkflow(input) {
  return start(supportTransitionWorkflow, [input]);
}
