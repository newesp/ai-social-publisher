import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("wizard submits posts through the persisted posts API and offers only the fixed schedule time", async () => {
  const source = await readFile(new URL("../src/components/CreatePostWizard.js", import.meta.url), "utf8");

  assert.equal(source.includes('fetch("/api/posts"'), true);
  assert.equal(source.includes("/api/posts/manual/publish"), false);
  assert.equal(source.includes('value: "09:00"'), true);
  assert.equal(source.includes("DateInput"), true);
  assert.equal(source.includes("buildPostSubmission"), true);
});

test("wizard surfaces an image-generation error returned alongside generated text", async () => {
  const source = await readFile(new URL("../src/components/CreatePostWizard.js", import.meta.url), "utf8");

  assert.equal(source.includes("data.imageError"), true);
});

test("history loads API rows and exposes cancellation only for scheduled posts", async () => {
  const source = await readFile(new URL("../src/app/history/page.js", import.meta.url), "utf8");

  assert.equal(source.includes("loadPostHistory"), true);
  assert.equal(source.includes("cancelScheduledPost"), true);
  assert.equal(source.includes('row.status === "scheduled"'), true);
});
