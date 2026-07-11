import { NextResponse } from "next/server";

import { requireAppUser, routeErrorResponse } from "../../../lib/auth/route-guards.js";
import { buildGeneratedResponse } from "../../../lib/ai/generated-response.js";
import { getUserSettingsStore } from "../../../lib/settings/settings-store.js";
import { createGenerateRouteHandler } from "../../../lib/settings/generate-route-handler.js";

const handler = createGenerateRouteHandler({
  requireOwner: requireAppUser,
  getStore: getUserSettingsStore,
  buildResponse: buildGeneratedResponse,
  respond: (body, init) => NextResponse.json(body, init),
});

export async function POST(request) {
  try {
    return await handler(request);
  } catch (error) {
    return routeErrorResponse(error, NextResponse);
  }
}
