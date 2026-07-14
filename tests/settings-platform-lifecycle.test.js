import assert from "node:assert/strict";
import { test } from "node:test";

import { disconnectFeedback, platformLifecycleStatus } from "../src/lib/platform-connections/settings-platform-lifecycle.js";

test("disconnect feedback maps only safe response outcomes to persistent notices", () => {
  assert.deepEqual(disconnectFeedback("meta", 200, { notice: "provider private" }), {
    error: "", notice: "Meta was disconnected locally. You can separately revoke app access in Meta.",
  });
  assert.deepEqual(disconnectFeedback("line", 200, { warning: "provider private" }), {
    error: "", notice: "LINE was disconnected locally, but token revocation could not be confirmed.",
  });
  assert.deepEqual(disconnectFeedback("line", 409, { error: "private" }), {
    error: "Cancel or wait for pending posts before disconnecting this platform.", notice: "",
  });
});

test("lifecycle status describes expiry without promising permanent Meta renewal", () => {
  assert.match(platformLifecycleStatus({ platform: "line", state: "active", expiresAt: "2026-08-01T00:00:00.000Z" }), /automatic renewal/i);
  assert.match(platformLifecycleStatus({ platform: "line", state: "active", expiresAt: "2026-08-01T00:00:00.000Z" }), /Aug/i);
  const meta = platformLifecycleStatus({ platform: "meta", state: "active", expiresAt: "2026-08-01T00:00:00.000Z" });
  assert.match(meta, /checked before publishing/i);
  assert.match(meta, /best effort/i);
  assert.equal(/permanent|guaranteed/i.test(meta), false);
  assert.equal(platformLifecycleStatus({ platform: "line", state: "disconnected" }), "");
});
