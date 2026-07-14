import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { applyGoogleProfileToToken, applyTokenToSession, fetchSessionOwner } from "../src/lib/auth/session-profile.js";

test("loads and validates the current session owner", async () => {
  assert.equal(await fetchSessionOwner(async () => ({
    ok: true,
    json: async () => ({ user: { email: " Owner@Example.com " } }),
  })), "owner@example.com");

  await assert.rejects(
    () => fetchSessionOwner(async () => ({ ok: false })),
    /登入狀態/,
  );
});

test("auth callbacks retain the Google name and profile image", async () => {
  const token = applyGoogleProfileToToken({
    token: {},
    user: {
      email: "Owner@Example.com",
      name: "王小明",
      image: "https://lh3.googleusercontent.com/avatar.jpg",
    },
  });
  const session = applyTokenToSession({ session: { user: {} }, token });

  assert.equal(token.name, "王小明");
  assert.equal(token.picture, "https://lh3.googleusercontent.com/avatar.jpg");
  assert.deepEqual(session.user, {
    email: "owner@example.com",
    name: "王小明",
    image: "https://lh3.googleusercontent.com/avatar.jpg",
    role: "user",
  });
});

test("app shell loads the NextAuth session image and keeps an initial fallback", async () => {
  const source = await readFile(new URL("../src/components/AppShellFrame.js", import.meta.url), "utf8");

  assert.equal(source.includes('fetch("/api/auth/session")'), true);
  assert.equal(source.includes("src={user?.image}"), true);
  assert.equal(source.includes("getUserInitial"), true);
  assert.equal(source.includes("clearWizardDraft"), true);
});
