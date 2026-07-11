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
