import { NextResponse } from "next/server";

import { requireSettingsAccess, routeErrorResponse } from "../../../../../lib/auth/route-guards.js";
import { createPlatformConnectionRouteHandlers, getPlatformConnectionServices } from "../../../../../lib/platform-connections/platform-connection-route-handlers.js";

const handlers = createPlatformConnectionRouteHandlers({
  requireOwner: requireSettingsAccess,
  getServices: () => getPlatformConnectionServices(),
  respond: (body, init) => NextResponse.json(body, init),
});

export async function POST(request, context) {
  try {
    const { platform } = await context.params;
    return await handlers.disconnectPlatform(request, platform);
  } catch (error) {
    return routeErrorResponse(error, NextResponse);
  }
}
