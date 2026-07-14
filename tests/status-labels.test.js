import assert from "node:assert/strict";
import test from "node:test";

import { getPlatformLabel, getStatusLabel } from "../src/lib/posts/status-labels.js";

test("localizes post states while preserving platform proper nouns", () => {
  assert.equal(getStatusLabel("scheduled"), "已排程");
  assert.equal(getStatusLabel("published"), "已發布");
  assert.equal(getStatusLabel("publishing"), "發布中");
  assert.equal(getStatusLabel("partial_failed"), "部分失敗");
  assert.equal(getStatusLabel("failed"), "失敗");
  assert.equal(getStatusLabel("cancelled"), "已取消");
  assert.equal(getPlatformLabel("line"), "LINE");
  assert.equal(getPlatformLabel("meta"), "Meta");
  assert.equal(getPlatformLabel("system"), "系統");
});
