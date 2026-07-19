import { NextResponse } from "next/server";

import { requireSettingsAccess, routeErrorResponse } from "../../../../../lib/auth/route-guards.js";
import {
  getPlatformConnectionServices,
  requireSameOrigin,
} from "../../../../../lib/platform-connections/platform-connection-route-handlers.js";
import { createSupportOnboardingRouteHandlers } from "../../../../../lib/support/routes/support-onboarding-route-handlers.js";

const handlers = createSupportOnboardingRouteHandlers({
  requireOwner: requireSettingsAccess,
  requireSameOrigin,
  getServices: () => getPlatformConnectionServices(),
  respond: (body, init) => NextResponse.json(body, init),
});

export async function POST(request) {
  try {
    return await handlers.testProvider(request);
  } catch (error) {
    return routeErrorResponse(error, NextResponse);
  }
}
