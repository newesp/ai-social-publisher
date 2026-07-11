import assert from "node:assert/strict";
import { test } from "node:test";

import { canSignInWithGoogle, getRoleForEmail, isAdminEmail } from "../src/lib/auth/roles.js";

test("demo allows non-empty Google accounts to sign in", () => {
  const env = { AUTH_MODE: "demo" };

  assert.equal(canSignInWithGoogle("guest@example.com", env), true);
  assert.equal(canSignInWithGoogle("", env), false);
});

test("detects admin emails case-insensitively from ADMIN_EMAILS", () => {
  const env = { ADMIN_EMAILS: "admin@example.com, owner@example.com" };

  assert.equal(isAdminEmail("Admin@Example.com", env), true);
  assert.equal(isAdminEmail("guest@example.com", env), false);
});

test("assigns admin or user role without blocking non-admin sign-in", () => {
  const env = { ADMIN_EMAILS: "admin@example.com" };

  assert.equal(getRoleForEmail("admin@example.com", env), "admin");
  assert.equal(getRoleForEmail("viewer@example.com", env), "user");
});
