import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { createSupportRetentionCronRouteHandlers } from "../src/lib/support/retention/support-retention-cron.js";

test("retention cron fails closed unless authorization exactly matches CRON_SECRET", async () => {
  let calls = 0;
  const handlers = createSupportRetentionCronRouteHandlers({
    createService: () => ({
      async purgeExpiredContent() {
        calls += 1;
        return { messagesCleared: 1, replyTokensCleared: 2 };
      },
    }),
    env: { CRON_SECRET: "cron-secret" },
    respond: (body, init) => ({ body, ...init }),
  });

  for (const authorization of [undefined, "Bearer wrong", "bearer cron-secret", "Bearer cron-secret extra"]) {
    const response = await handlers.GET(new Request("https://app.test/api/cron/support-retention", {
      headers: authorization ? { authorization } : {},
    }));
    assert.deepEqual(response, { body: { error: "Unauthorized cron request." }, status: 401 });
  }
  assert.equal(calls, 0);
});

test("retention cron returns only safe cleanup counts", async () => {
  const handlers = createSupportRetentionCronRouteHandlers({
    createService: () => ({
      async purgeExpiredContent() {
        return {
          messagesCleared: 4,
          replyTokensCleared: 2,
          outboundBodiesCleared: 0,
          privateToken: "reply-token",
        };
      },
    }),
    env: { CRON_SECRET: "cron-secret" },
    respond: (body, init) => ({ body, ...init }),
  });

  const response = await handlers.GET(new Request("https://app.test/api/cron/support-retention", {
    headers: { authorization: "Bearer cron-secret" },
  }));

  assert.deepEqual(response, {
    body: { messagesCleared: 4, replyTokensCleared: 2, outboundBodiesCleared: 0 },
  });
});

test("retention cron masks unexpected cleanup failures", async () => {
  const handlers = createSupportRetentionCronRouteHandlers({
    createService: () => ({
      async purgeExpiredContent() {
        throw new Error("channel-secret access-token reply-token U-customer-id");
      },
    }),
    env: { CRON_SECRET: "cron-secret" },
    respond: (body, init) => ({ body, ...init }),
  });

  const response = await handlers.GET(new Request("https://app.test/api/cron/support-retention", {
    headers: { authorization: "Bearer cron-secret" },
  }));

  assert.deepEqual(response, {
    body: { error: "Retention cleanup failed." },
    status: 500,
  });
});

test("Vercel runs support retention daily without replacing publishing cleanup", async () => {
  const vercel = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));

  assert.deepEqual(vercel.crons, [
    { path: "/api/cron", schedule: "0 1 * * *" },
    { path: "/api/cron/support-retention", schedule: "30 1 * * *" },
  ]);
});

test("retention cron route imports the local support implementation", async () => {
  const route = await readFile(
    new URL("../src/app/api/cron/support-retention/route.js", import.meta.url),
    "utf8",
  );

  assert.match(route, /from "\.\.\/\.\.\/\.\.\/\.\.\/lib\/support\/support-repository\.js"/);
  assert.match(route, /from "\.\.\/\.\.\/\.\.\/\.\.\/lib\/support\/retention\/support-retention-cron\.js"/);
  assert.match(route, /from "\.\.\/\.\.\/\.\.\/\.\.\/lib\/support\/retention\/support-retention-service\.js"/);
});
