import { NextResponse } from "next/server";

import { requireAppUser, requirePublisher, routeErrorResponse } from "../../../lib/auth/route-guards.js";
import { createPostRepository } from "../../../lib/posts/post-repository.js";
import { createPostRouteHandlers } from "../../../lib/posts/post-route-handlers.js";
import { publishTargets } from "../../../lib/platforms/publish-service.js";
import { readSettings } from "../../../lib/settings/settings-store.js";

const handlers = createPostRouteHandlers({
  requireAppUser,
  requirePublisher,
  getRepository: () => createPostRepository(),
  readSettings,
  publishTargets,
  respond: (body, init) => NextResponse.json(body, init),
});

export async function GET() {
  try {
    return await handlers.GET();
  } catch (error) {
    return routeErrorResponse(error, NextResponse);
  }
}

export async function POST(request) {
  try {
    return await handlers.POST(request);
  } catch (error) {
    return routeErrorResponse(error, NextResponse);
  }
}
