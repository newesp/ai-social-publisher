import { NextResponse } from "next/server";

import { requirePublisher, routeErrorResponse } from "../../../../lib/auth/route-guards.js";
import { createPostRepository } from "../../../../lib/posts/post-repository.js";
import { createPostCancellationHandler } from "../../../../lib/posts/post-route-handlers.js";

const handler = createPostCancellationHandler({
  requirePublisher,
  getRepository: () => createPostRepository(),
  respond: (body, init) => NextResponse.json(body, init),
});

export async function DELETE(request, context) {
  try {
    return await handler(request, context);
  } catch (error) {
    return routeErrorResponse(error, NextResponse);
  }
}
