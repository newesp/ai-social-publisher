import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("inbox contains queue, thread, drawer, visible-tab poll, and mobile back navigation", async () => {
  const source = await readFile(new URL("../src/components/support/SupportInbox.js", import.meta.url), "utf8");
  for (const marker of ["ConversationList", "ConversationThread", "ConversationDetailsDrawer", "visibilitychange", "15000", "Back"]) {
    assert.equal(source.includes(marker), true);
  }
});

test("support page and navigation expose the responsive inbox without sensitive customer fields", async () => {
  const [page, shell, inbox] = await Promise.all([
    readFile(new URL("../src/app/support/page.js", import.meta.url), "utf8"),
    readFile(new URL("../src/components/AppShellFrame.js", import.meta.url), "utf8"),
    readFile(new URL("../src/components/support/SupportInbox.js", import.meta.url), "utf8"),
  ]);
  assert.match(page, /SupportInbox/);
  assert.match(shell, /href:\s*"\/support"/);
  for (const forbidden of ["encryptedCustomerExternalId", "ownerEmail", "channelAccessToken", "customerExternalId"]) {
    assert.equal(inbox.includes(forbidden), false);
  }
});
