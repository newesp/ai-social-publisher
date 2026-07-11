import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("legacy direct publish route is retired so it cannot use shared settings", async () => {
  const source = await readFile(
    new URL("../src/app/api/posts/[id]/publish/route.js", import.meta.url),
    "utf8",
  );

  assert.equal(source.includes("status: 410"), true);
  assert.equal(source.includes("readSettings"), false);
  assert.equal(source.includes("publishTargets"), false);
});
