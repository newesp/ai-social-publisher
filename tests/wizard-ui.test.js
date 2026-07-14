import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("wizard submits posts through the persisted posts API and offers only the fixed schedule time", async () => {
  const source = await readFile(new URL("../src/components/CreatePostWizard.js", import.meta.url), "utf8");
  const submitSource = await readFile(new URL("../src/lib/wizard/wizard-submit.js", import.meta.url), "utf8");

  assert.equal(submitSource.includes('fetchImpl("/api/posts"'), true);
  assert.equal(`${source}\n${submitSource}`.includes("/api/posts/manual/publish"), false);
  assert.equal(source.includes('value: "09:00"'), true);
  assert.equal(source.includes("DateInput"), true);
  assert.equal(submitSource.includes("buildPostSubmission"), true);
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
  assert.equal(source.includes("已加入自動重試佇列"), true);
  assert.equal(source.includes('result.status === "scheduled"'), true);
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

  for (const expected of ["正在載入已連結的平台", "無法載入發布平台連線", "前往系統設定連結發布平台", 'href="/settings?tab=publishing"']) {
    assert.equal(source.includes(expected), true, `missing ${expected}`);
  }
  assert.equal(source.includes('availabilityStatus === "success" && isProductStepComplete(form)'), true);
});

test("wizard guards later steps, persists its draft, and proofreads before publishing", async () => {
  const source = await readFile(new URL("../src/components/CreatePostWizard.js", import.meta.url), "utf8");

  assert.equal(source.includes("isProductStepComplete"), true);
  assert.equal(source.includes("allowStepClick={productStepComplete}"), true);
  assert.equal(source.includes("disabled={!productStepComplete}"), true);
  assert.equal(source.includes("readWizardDraft"), true);
  assert.equal(source.includes("writeWizardDraft"), true);
  assert.equal(source.includes("submitCheckedPost"), true);
  assert.equal(source.includes("proofreadIssues"), true);
  assert.equal(source.includes("再新增貼文"), true);
  assert.equal(source.includes("clearWizardDraft"), true);
  assert.equal(source.includes("submissionInFlight"), true);
});

test("history loads API rows and exposes cancellation only for scheduled posts", async () => {
  const source = await readFile(new URL("../src/app/history/page.js", import.meta.url), "utf8");

  assert.equal(source.includes("loadPostHistory"), true);
  assert.equal(source.includes("cancelScheduledPost"), true);
  assert.equal(source.includes('row.status === "scheduled"'), true);
});

test("settings, previews, and status badges use Chinese UI copy", async () => {
  const settings = await readFile(new URL("../src/components/SettingsPanel.js", import.meta.url), "utf8");
  const previews = await readFile(new URL("../src/components/PlatformPreview.js", import.meta.url), "utf8");
  const wizard = await readFile(new URL("../src/components/CreatePostWizard.js", import.meta.url), "utf8");
  const history = await readFile(new URL("../src/app/history/page.js", import.meta.url), "utf8");

  assert.equal(settings.includes(">Settings<"), false);
  assert.equal(settings.includes("Save AI settings"), false);
  assert.equal(settings.includes("Publishing platforms"), false);
  assert.equal(previews.includes("feed preview"), false);
  assert.equal(previews.includes("broadcast preview"), false);
  assert.equal(wizard.includes("getStatusLabel"), true);
  assert.equal(history.includes("getStatusLabel"), true);
});
