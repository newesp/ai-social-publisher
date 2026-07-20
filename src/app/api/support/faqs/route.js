import { NextResponse } from "next/server";

import { requireSettingsAccess, routeErrorResponse } from "../../../../lib/auth/route-guards.js";
import { requireSameOrigin } from "../../../../lib/platform-connections/platform-connection-route-handlers.js";
import { createSupportSettingsRouteHandlers } from "../../../../lib/support/routes/support-settings-route-handlers.js";
import { getSupportStore } from "../../../../lib/support/support-store.js";

const handlers = createSupportSettingsRouteHandlers({
  requireOwner: requireSettingsAccess,
  requireSameOrigin,
  getStore: getSupportStore,
  respond: (body, init) => NextResponse.json(body, init),
});

export async function GET() {
  try {
    return await handlers.listFaqs();
  } catch (error) {
    return routeErrorResponse(error, NextResponse);
  }
}

export async function POST(request) {
  try {
    return await handlers.createFaq(request);
  } catch (error) {
    return routeErrorResponse(error, NextResponse);
  }
}
