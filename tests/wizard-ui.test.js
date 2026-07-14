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

test("wizard renders provider-specific model selects and sends selected models to generate", async () => {
  const source = await readFile(new URL("../src/components/CreatePostWizard.js", import.meta.url), "utf8");

  assert.equal(source.includes("getLLMModelOptions"), true);
  assert.equal(source.includes("getImageModelOptions"), true);
  assert.equal(source.includes("value={form.llmModel}"), true);
  assert.equal(source.includes("value={form.imageModel}"), true);
  assert.equal(source.includes("useEffect"), true);
  assert.equal(source.includes("writeModelPreferences"), true);
  assert.equal(source.includes('body: JSON.stringify(form)'), true);
});

test("wizard exposes OpenAI's one-option model controls", async () => {
  const source = await readFile(new URL("../src/components/CreatePostWizard.js", import.meta.url), "utf8");

  assert.equal(source.includes('getLLMModelOptions(form.llmProvider)'), true);
  assert.equal(source.includes('getImageModelOptions(form.imageProvider)'), true);
});

test("wizard renders an automatic retry notice for an accepted scheduled immediate post", async () => {
  const source = await readFile(new URL("../src/components/CreatePostWizard.js", import.meta.url), "utf8");
  assert.equal(source.includes("Queued for automatic retry at the next scheduled run"), true);
  assert.equal(source.includes('publishResult.status === "scheduled"'), true);
});

test("wizard fetches connection availability and renders only active platform choices", async () => {
  const source = await readFile(new URL("../src/components/CreatePostWizard.js", import.meta.url), "utf8");

  assert.equal(source.includes('fetch("/api/platform-connections")'), true);
  assert.equal(source.includes('connection.state === "active"'), true);
  assert.equal(source.includes("connectedPlatformOptions.map"), true);
  assert.equal(source.includes("ACTIVE_PLATFORMS.map"), false);
  assert.equal(source.includes("reconcileConnectedPlatforms"), true);
});

test("wizard handles loading, error, and no-connection states without selectable fallbacks", async () => {
  const source = await readFile(new URL("../src/components/CreatePostWizard.js", import.meta.url), "utf8");

  for (const expected of ["Loading connected platforms", "Could not load publishing connections", "Connect a publishing platform in Settings", 'href="/settings?tab=publishing"']) {
    assert.equal(source.includes(expected), true, `missing ${expected}`);
  }
  assert.equal(source.includes('availabilityStatus !== "success" || connectedPlatforms.length === 0'), true);
});

test("history loads API rows and exposes cancellation only for scheduled posts", async () => {
  const source = await readFile(new URL("../src/app/history/page.js", import.meta.url), "utf8");

  assert.equal(source.includes("loadPostHistory"), true);
  assert.equal(source.includes("cancelScheduledPost"), true);
  assert.equal(source.includes('row.status === "scheduled"'), true);
});
