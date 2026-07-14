import { NextResponse } from "next/server";

import { requireSettingsAccess, routeErrorResponse } from "../../../../../lib/auth/route-guards.js";
import { createPlatformConnectionRouteHandlers, getPlatformConnectionServices } from "../../../../../lib/platform-connections/platform-connection-route-handlers.js";
import { dispatchMetaStartRequest } from "./meta-start-dispatch.js";

const handlers = createPlatformConnectionRouteHandlers({
  requireOwner: requireSettingsAccess,
  getServices: () => getPlatformConnectionServices(),
  respond: (body, init) => NextResponse.json(body, init),
  redirect: (url, status) => NextResponse.redirect(url, status),
});

export async function POST(request) {
  try {
    return await dispatchMetaStartRequest(request, handlers);
  } catch (error) {
    return routeErrorResponse(error, NextResponse);
  }
}
