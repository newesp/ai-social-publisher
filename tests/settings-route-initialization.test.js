import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

async function readRoute(path) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

test("settings route defers settings-store creation until a request handler runs", async () => {
  const source = await readRoute("../src/app/api/settings/route.js");

  assert.match(source, /getStore:\s*getUserSettingsStore/);
  assert.doesNotMatch(source, /getUserSettingsStore\(\)/);
});

test("generate route defers settings-store creation until a request handler runs", async () => {
  const source = await readRoute("../src/app/api/generate/route.js");

  assert.match(source, /getStore:\s*getUserSettingsStore/);
  assert.doesNotMatch(source, /getUserSettingsStore\(\)/);
});
