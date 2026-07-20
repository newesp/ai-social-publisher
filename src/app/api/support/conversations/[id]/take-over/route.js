import { NextResponse } from "next/server";
import { requireSettingsAccess, routeErrorResponse } from "../../../../../../lib/auth/route-guards.js";
import { requireSameOrigin } from "../../../../../../lib/platform-connections/platform-connection-route-handlers.js";
import { createSupportHumanActionRouteHandlers } from "../../../../../../lib/support/routes/support-human-action-route-handlers.js";
import { getSupportStore } from "../../../../../../lib/support/support-store.js";
const handlers = createSupportHumanActionRouteHandlers({ requireOwner: requireSettingsAccess, requireSameOrigin, getStore: getSupportStore, respond: (body, init) => NextResponse.json(body, init) });
export async function POST(request, { params }) { try { return await handlers.takeOver(request, (await params).id); } catch (error) { return routeErrorResponse(error, NextResponse); } }
