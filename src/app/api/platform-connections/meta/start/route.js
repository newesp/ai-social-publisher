import { NextResponse } from "next/server";

import { requireSettingsAccess, routeErrorResponse } from "../../../../../lib/auth/route-guards.js";
import { createPlatformConnectionRouteHandlers, getPlatformConnectionServices } from "../../../../../lib/platform-connections/platform-connection-route-handlers.js";

const handlers = createPlatformConnectionRouteHandlers({
  requireOwner: requireSettingsAccess,
  getServices: () => getPlatformConnectionServices(),
  respond: (body, init) => NextResponse.json(body, init),
  redirect: (url, status) => NextResponse.redirect(url, status),
});

export async function POST(request) {
  try {
    const contentType = String(request.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
    if (contentType === "application/x-www-form-urlencoded") return await handlers.startMetaRedirect(request);
    return await handlers.startMeta(request);
  } catch (error) {
    return routeErrorResponse(error, NextResponse);
  }
}
