import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("support text inputs capture values before queuing form state updates", async () => {
  const sources = await Promise.all([
    "SupportSettingsPanel.js",
    "FaqManager.js",
  ].map((name) => readFile(
    new URL(`../src/components/support/${name}`, import.meta.url),
    "utf8",
  )));

  for (const source of sources) {
    assert.doesNotMatch(
      source,
      /setForm\(\(current\)\s*=>\s*\(\{[\s\S]{0,200}event\.currentTarget\.value/,
    );
  }
});
