import { NextResponse } from "next/server";

import { requireSettingsAccess, routeErrorResponse } from "../../../../../lib/auth/route-guards.js";
import { createSupportInboxRouteHandlers } from "../../../../../lib/support/routes/support-inbox-route-handlers.js";
import { getSupportStore } from "../../../../../lib/support/support-store.js";

const handlers = createSupportInboxRouteHandlers({ requireOwner: requireSettingsAccess, getStore: getSupportStore, respond: (body, init) => NextResponse.json(body, init) });

export async function GET(request, { params }) { try { return await handlers.getConversation(request, (await params).id); } catch (error) { return routeErrorResponse(error, NextResponse); } }
export async function DELETE(request, { params }) { try { return await handlers.deleteConversation(request, (await params).id); } catch (error) { return routeErrorResponse(error, NextResponse); } }
