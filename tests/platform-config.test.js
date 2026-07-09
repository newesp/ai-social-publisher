import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ACTIVE_PLATFORMS,
  filterActivePlatforms,
  isActivePlatform,
} from "../src/lib/platforms/platform-config.js";

test("only Meta and LINE are active while Instagram is deferred", () => {
  assert.deepEqual(ACTIVE_PLATFORMS.map((platform) => platform.value), ["meta", "line"]);
  assert.equal(isActivePlatform("instagram"), false);
});

test("filters inactive platforms from requested targets", () => {
  assert.deepEqual(filterActivePlatforms(["meta", "instagram", "line"]), ["meta", "line"]);
});
