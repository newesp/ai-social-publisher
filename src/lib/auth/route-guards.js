import { getServerSession } from "next-auth";

import {
  canManageSettings,
  canPublish,
  canUseApp,
  normalizeEmail,
} from "./policy.js";

export async function requireAppUser(options) {
  return requireOwnerEmail(canUseApp, options);
}

export async function requirePublisher(options) {
  return requireOwnerEmail(canPublish, options);
}

export async function requireSettingsAccess(options) {
  return requireOwnerEmail(canManageSettings, options);
}

async function requireOwnerEmail(
  policy,
  { getSessionImpl = getSession, getServerSessionImpl = getServerSession, env = process.env } = {},
) {
  const session = await getSessionImpl({ getServerSessionImpl });
  const ownerEmail = normalizeEmail(session?.user?.email);

  if (!ownerEmail) {
    throwRouteError("Authentication is required.", 401);
  }
  if (!policy(ownerEmail, env)) {
    throwRouteError("This account is not allowed to use this app.", 403);
  }

  return ownerEmail;
}

async function getSession({ getServerSessionImpl }) {
  const { authOptions } = await import("../auth.js");
  return getServerSessionImpl(authOptions);
}

function throwRouteError(message, status) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

export function routeErrorResponse(error, NextResponse) {
  return NextResponse.json(
    { error: error.message ?? "Request failed." },
    { status: error.status ?? 500 },
  );
}
