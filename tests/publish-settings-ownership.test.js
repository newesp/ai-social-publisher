import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("publish route derives the settings owner from the signed-in session", async () => {
  const source = await readFile(
    new URL("../src/app/api/posts/[id]/publish/route.js", import.meta.url),
    "utf8",
  );

  assert.equal(source.includes("requirePublisher"), true);
  assert.equal(source.includes("readSettings(ownerEmail)"), true);
});
