import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  getMaskedSettings,
  readSettings,
  updateSettings,
} from "../src/lib/settings/settings-store.js";

test("persists settings to the configured local data file", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ai-social-publisher-"));
  const filePath = path.join(dir, "settings.json");

  try {
    await updateSettings({ googleAiApiKey: "google-secret" }, { filePath });
    assert.deepEqual(await readSettings({ filePath }), { googleAiApiKey: "google-secret" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("masks persisted settings for API responses", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ai-social-publisher-"));
  const filePath = path.join(dir, "settings.json");

  try {
    await updateSettings({ openAiApiKey: "sk-example-secret" }, { filePath });
    assert.deepEqual(await getMaskedSettings({ filePath }), { openAiApiKey: "sk-...ret" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("does not mask public Meta Page ID in settings responses", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ai-social-publisher-"));
  const filePath = path.join(dir, "settings.json");

  try {
    await updateSettings({ metaPageId: "1234567890" }, { filePath });
    assert.deepEqual(await getMaskedSettings({ filePath }), { metaPageId: "1234567890" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
