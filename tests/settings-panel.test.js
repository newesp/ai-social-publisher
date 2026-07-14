import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("settings panel exposes only supported per-user settings", async () => {
  const source = await readFile(
    new URL("../src/components/SettingsPanel.js", import.meta.url),
    "utf8",
  );

  assert.equal(source.toLowerCase().includes("imgur"), false);
  assert.equal(source.toLowerCase().includes("instagram"), false);
  assert.equal(source.toLowerCase().includes("admin-only"), false);
  assert.equal(source.includes("IconDownload"), false);
  assert.equal(source.includes("IconUpload"), false);
});

test("settings uses safe per-user connection APIs instead of stored publishing credentials", async () => {
  const source = await readFile(new URL("../src/components/SettingsPanel.js", import.meta.url), "utf8");

  assert.equal(source.includes('fetch("/api/platform-connections")'), true);
  assert.equal(source.includes('/api/platform-connections/meta/start'), true);
  assert.equal(source.includes('/api/platform-connections/meta/select'), true);
  assert.equal(source.includes('/api/platform-connections/line'), true);
  assert.equal(source.includes('/disconnect'), true);
  for (const forbidden of ["Meta Page Access Token", "LINE Channel Access Token", "Meta Page ID", "client_id", "client_secret"]) {
    assert.equal(source.includes(forbidden), false, `must not render ${forbidden}`);
  }
});

test("Meta connection starts with a native POST form and consumes only a safe error flag", async () => {
  const source = await readFile(new URL("../src/components/SettingsPanel.js", import.meta.url), "utf8");

  assert.equal(source.includes('action="/api/platform-connections/meta/start"'), true);
  assert.equal(source.includes('method="post"'), true);
  assert.equal(source.includes('name="returnPath"'), true);
  assert.equal(source.includes('type="submit"'), true);
  assert.equal(source.includes('fetch("/api/platform-connections/meta/start"'), false);
  assert.equal(source.includes('params.get("meta") === "start_error"'), true);
  assert.equal(source.includes('params.delete("meta")'), true);
});

test("LINE credential form explains where to find Channel ID and Channel secret", async () => {
  const source = await readFile(new URL("../src/components/SettingsPanel.js", import.meta.url), "utf8");

  for (const expected of [
    "How to get Channel ID / Channel secret",
    "https://developers.line.biz/",
    "Messaging API",
    "Basic settings",
    "LINE Official Account",
    "Do not paste a Channel access token",
    'rel="noreferrer noopener"',
  ]) {
    assert.equal(source.includes(expected), true, `missing ${expected}`);
  }
  assert.equal(source.includes("<details"), true);
  assert.equal(source.includes("<summary"), true);
});

test("settings renders actionable loading, disconnected, active, reconnect, and error states", async () => {
  const source = await readFile(new URL("../src/components/SettingsPanel.js", import.meta.url), "utf8");
  const lifecycleSource = await readFile(new URL("../src/lib/platform-connections/settings-platform-lifecycle.js", import.meta.url), "utf8");

  for (const expected of ["Loading publishing connections", "Not connected", "Connected", "Reconnect", "Change Page", "Try again", "Channel ID", "Channel Secret"]) {
    assert.equal(source.includes(expected), true, `missing ${expected}`);
  }
  assert.equal(source.includes("setLineCredentials({ channelId: \"\", channelSecret: \"\" })"), true);
  assert.equal(source.includes("response.status === 409"), true);
  assert.equal(lifecycleSource.includes("Cancel or wait for pending posts"), true);
  assert.equal(source.includes('role="status"'), true);
  assert.equal(source.includes("disconnectFeedback"), true);
  assert.equal(source.includes("platformLifecycleStatus"), true);
});

test("successful Meta Page selection removes the opaque callback query before refreshing availability", async () => {
  const source = await readFile(new URL("../src/components/SettingsPanel.js", import.meta.url), "utf8");
  const cleanup = source.indexOf('window.history.replaceState({}, "", "/settings?tab=publishing")');
  const refresh = source.indexOf("await loadConnections()", cleanup);

  assert.notEqual(cleanup, -1);
  assert.equal(refresh > cleanup, true);
});

test("login explains that each signed-in account connects its own platforms", async () => {
  const source = await readFile(new URL("../src/app/login/page.js", import.meta.url), "utf8");

  assert.equal(source.includes("每個登入帳號都會連結自己的發布平台"), true);
  assert.equal(source.toLowerCase().includes("admin-only"), false);
});
