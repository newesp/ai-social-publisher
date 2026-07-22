import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("workflow route entrypoints statically import every workflow they start", async () => {
  const [lineRoute, transitionRoute] = await Promise.all([
    readFile(new URL("../src/app/api/webhooks/line/[webhookKey]/route.js", import.meta.url), "utf8"),
    readFile(new URL("../src/app/api/support/conversations/[id]/transitions/route.js", import.meta.url), "utf8"),
  ]);

  assert.match(lineRoute, /import \{ lineMessageWorkflow \} from ".*workflows\/line-message-workflow\.js";/);
  assert.match(transitionRoute, /import \{ supportTransitionWorkflow \} from ".*workflows\/support-transition-workflow\.js";/);
  assert.match(lineRoute, /start\(lineMessageWorkflow, \[input\]\)/);
  assert.match(transitionRoute, /start\(supportTransitionWorkflow, \[input\]\)/);
  assert.doesNotMatch(lineRoute, /await import\(/);
  assert.doesNotMatch(transitionRoute, /await import\(/);
});
