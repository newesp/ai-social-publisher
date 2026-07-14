import { NextResponse } from "next/server";

import { requireAppUser, requirePublisher, routeErrorResponse } from "../../../lib/auth/route-guards.js";
import { createPostRepository } from "../../../lib/posts/post-repository.js";
import { createPostRouteHandlers, createPublishingConnectionResolver } from "../../../lib/posts/post-route-handlers.js";
import { publishTargets } from "../../../lib/platforms/publish-service.js";
import { getPlatformConnectionServices } from "../../../lib/platform-connections/platform-connection-route-handlers.js";

function createConnectionContext() {
  const services = getPlatformConnectionServices();
  return {
    resolveConnection: (ownerEmail, platform) => services.connections.getDefault(ownerEmail, platform),
    getConnection: createPublishingConnectionResolver(services),
  };
}

const handlers = createPostRouteHandlers({
  requireAppUser,
  requirePublisher,
  getRepository: () => createPostRepository(),
  createConnectionContext,
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
