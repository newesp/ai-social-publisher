import assert from "node:assert/strict";
import { test } from "node:test";

import { disconnectFeedback, platformLifecycleStatus } from "../src/lib/platform-connections/settings-platform-lifecycle.js";

test("disconnect feedback maps only safe response outcomes to persistent notices", () => {
  assert.deepEqual(disconnectFeedback("meta", 200, { notice: "provider private" }), {
    error: "", notice: "已在本系統中斷 Meta 連線；如有需要，可另至 Meta 撤銷應用程式存取權。",
  });
  assert.deepEqual(disconnectFeedback("line", 200, { warning: "provider private" }), {
    error: "", notice: "已在本系統中斷 LINE 連線，但無法確認存取權杖是否已撤銷。",
  });
  assert.deepEqual(disconnectFeedback("line", 409, { error: "private" }), {
    error: "請取消待發布貼文或等待發布完成後，再中斷此平台連線。", notice: "",
  });
});

test("lifecycle status describes expiry without promising permanent Meta renewal", () => {
  assert.match(platformLifecycleStatus({ platform: "line", state: "active", expiresAt: "2026-08-01T00:00:00.000Z" }), /自動更新/);
  assert.match(platformLifecycleStatus({ platform: "line", state: "active", expiresAt: "2026-08-01T00:00:00.000Z" }), /2026/);
  const meta = platformLifecycleStatus({ platform: "meta", state: "active", expiresAt: "2026-08-01T00:00:00.000Z" });
  assert.match(meta, /發布前/);
  assert.match(meta, /嘗試更新/);
  assert.equal(/permanent|guaranteed/i.test(meta), false);
  assert.equal(platformLifecycleStatus({ platform: "line", state: "disconnected" }), "");
});
