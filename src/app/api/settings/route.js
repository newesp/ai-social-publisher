import { NextResponse } from "next/server";

import { requireSettingsAccess, routeErrorResponse } from "../../../lib/auth/route-guards.js";
import { getUserSettingsStore } from "../../../lib/settings/settings-store.js";
import { createSettingsRouteHandlers } from "../../../lib/settings/settings-route-handlers.js";

const handlers = createSettingsRouteHandlers({
  requireOwner: requireSettingsAccess,
  getStore: getUserSettingsStore,
  respond: (body, init) => NextResponse.json(body, init),
});

export async function GET() {
  try {
    return await handlers.GET();
  } catch (error) {
    return routeErrorResponse(error, NextResponse);
  }
}

export async function PUT(request) {
  try {
    return await handlers.PUT(request);
  } catch (error) {
    return routeErrorResponse(error, NextResponse);
  }
}
