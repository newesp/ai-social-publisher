import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  canManageSettings,
  canPublish,
  canSignInWithGoogle,
  canUseApp,
  getAuthMode,
  normalizeEmail,
} from "../src/lib/auth/policy.js";
import {
  requireAppUser,
  routeErrorResponse,
} from "../src/lib/auth/route-guards.js";
import { isLocalAuthBypassEnabled } from "../src/lib/auth/middleware-policy.js";

test("normalizes Google account emails", () => {
  assert.equal(normalizeEmail(" Owner@Example.COM "), "owner@example.com");
  assert.equal(normalizeEmail(""), "");
  assert.equal(normalizeEmail(null), "");
});

test("demo mode accepts any non-empty normalized Google email", () => {
  const env = { AUTH_MODE: "demo", ALLOWED_GOOGLE_EMAILS: "" };

  assert.equal(getAuthMode(env), "demo");
  assert.equal(canSignInWithGoogle(" Guest@Example.com ", env), true);
  assert.equal(canUseApp("guest@example.com", env), true);
  assert.equal(canPublish("guest@example.com", env), true);
  assert.equal(canManageSettings("guest@example.com", env), true);
  assert.equal(canSignInWithGoogle("", env), false);
});

test("production mode rejects Google emails outside ALLOWED_GOOGLE_EMAILS", () => {
  const env = {
    AUTH_MODE: "production",
    ALLOWED_GOOGLE_EMAILS: " Owner@Example.com, admin@example.com ",
    ADMIN_EMAILS: "admin@example.com",
  };

  assert.equal(getAuthMode(env), "production");
  assert.equal(canSignInWithGoogle("OWNER@example.com", env), true);
  assert.equal(canUseApp("guest@example.com", env), false);
  assert.equal(canPublish("guest@example.com", env), false);
  assert.equal(canManageSettings("guest@example.com", env), false);
});

test("route guards derive the normalized owner from the NextAuth session", async () => {
  const ownerEmail = await requireAppUser({
    getSessionImpl: async () => ({ user: { email: " Owner@Example.com " } }),
    env: { AUTH_MODE: "demo" },
  });

  assert.equal(ownerEmail, "owner@example.com");
});

test("unauthenticated route guards produce a 401 response", async () => {
  await assert.rejects(
    requireAppUser({
      getSessionImpl: async () => null,
      env: { AUTH_MODE: "demo" },
    }),
    (error) => error.status === 401 && error.message === "Authentication is required.",
  );

  const response = routeErrorResponse(
    Object.assign(new Error("Authentication is required."), { status: 401 }),
    { json: (body, init) => ({ body, ...init }) },
  );
  assert.deepEqual(response, { body: { error: "Authentication is required." }, status: 401 });
});

test("middleware excludes NextAuth and cron endpoints", async () => {
  const middlewareSource = await readFile(new URL("../src/middleware.js", import.meta.url), "utf8");

  assert.equal(middlewareSource.includes("api/auth|api/cron"), true);
});

test("the local auth bypass cannot disable production middleware", () => {
  assert.equal(
    isLocalAuthBypassEnabled({ DISABLE_AUTH_FOR_LOCAL_DEV: "true", NODE_ENV: "development" }),
    true,
  );
  assert.equal(
    isLocalAuthBypassEnabled({ DISABLE_AUTH_FOR_LOCAL_DEV: "true", NODE_ENV: "production" }),
    false,
  );
});
