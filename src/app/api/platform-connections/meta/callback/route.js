import { NextResponse } from "next/server";

import { requireSettingsAccess, routeErrorResponse } from "../../../../../lib/auth/route-guards.js";
import { createPlatformConnectionRouteHandlers, getPlatformConnectionServices } from "../../../../../lib/platform-connections/platform-connection-route-handlers.js";

const handlers = createPlatformConnectionRouteHandlers({
  requireOwner: requireSettingsAccess,
  getServices: () => getPlatformConnectionServices(),
  redirect: (url) => NextResponse.redirect(url, 302),
});

export async function GET(request) {
  try { return await handlers.completeMeta(request); } catch (error) { return routeErrorResponse(error, NextResponse); }
}
