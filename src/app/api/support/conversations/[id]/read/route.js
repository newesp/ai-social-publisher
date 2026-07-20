import { NextResponse } from "next/server";

import { requireSettingsAccess, routeErrorResponse } from "../../../../../../lib/auth/route-guards.js";
import { requireSameOrigin } from "../../../../../../lib/platform-connections/platform-connection-route-handlers.js";
import { createSupportInboxRouteHandlers } from "../../../../../../lib/support/routes/support-inbox-route-handlers.js";
import { getSupportStore } from "../../../../../../lib/support/support-store.js";

const handlers = createSupportInboxRouteHandlers({ requireOwner: requireSettingsAccess, requireSameOrigin, getStore: getSupportStore, respond: (body, init) => NextResponse.json(body, init) });

export async function POST(request, { params }) { try { return await handlers.markConversationRead(request, (await params).id); } catch (error) { return routeErrorResponse(error, NextResponse); } }
