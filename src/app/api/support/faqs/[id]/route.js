import { NextResponse } from "next/server";

import { requireSettingsAccess, routeErrorResponse } from "../../../../../lib/auth/route-guards.js";
import { requireSameOrigin } from "../../../../../lib/platform-connections/platform-connection-route-handlers.js";
import { createSupportSettingsRouteHandlers } from "../../../../../lib/support/routes/support-settings-route-handlers.js";
import { getSupportStore } from "../../../../../lib/support/support-store.js";

const handlers = createSupportSettingsRouteHandlers({
  requireOwner: requireSettingsAccess,
  requireSameOrigin,
  getStore: getSupportStore,
  respond: (body, init) => NextResponse.json(body, init),
});

export async function PUT(request, context) {
  return update(request, context);
}

export async function PATCH(request, context) {
  return update(request, context);
}

export async function DELETE(request, { params }) {
  try {
    return await handlers.deleteFaq(request, (await params).id);
  } catch (error) {
    return routeErrorResponse(error, NextResponse);
  }
}

async function update(request, { params }) {
  try {
    return await handlers.updateFaq(request, (await params).id);
  } catch (error) {
    return routeErrorResponse(error, NextResponse);
  }
}
