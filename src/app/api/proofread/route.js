import { NextResponse } from "next/server";

import { requireAppUser, routeErrorResponse } from "../../../lib/auth/route-guards.js";
import { getUserSettingsStore } from "../../../lib/settings/settings-store.js";
import { createProofreadRouteHandler } from "../../../lib/settings/proofread-route-handler.js";

const handler = createProofreadRouteHandler({
  requireOwner: requireAppUser,
  getStore: getUserSettingsStore,
  respond: (body, init) => NextResponse.json(body, init),
});

export async function POST(request) {
  try {
    return await handler(request);
  } catch (error) {
    return routeErrorResponse(error, NextResponse);
  }
}
