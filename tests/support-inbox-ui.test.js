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

test("inbox exposes stale and reconnect recovery states while the shell refreshes the safe total", async () => {
  const [inbox, shell] = await Promise.all([
    readFile(new URL("../src/components/support/SupportInbox.js", import.meta.url), "utf8"),
    readFile(new URL("../src/components/AppShellFrame.js", import.meta.url), "utf8"),
  ]);
  for (const marker of ["stale", "reconnecting", "recovery", "15000"]) assert.equal(inbox.includes(marker), true);
  for (const marker of ["attentionCount", "setInterval", "15000"]) assert.equal(shell.includes(marker), true);
});

test("composer input is enabled only for server-confirmed human handling without adding send behavior", async () => {
  const source = await readFile(new URL("../src/components/support/ConversationThread.js", import.meta.url), "utf8");
  assert.match(source, /TextInput[^>]+disabled=\{!composerEnabled\}/);
  assert.match(source, /Button disabled/);
  assert.doesNotMatch(source, /fetch\(/);
  assert.match(source, /<Button disabled>Sending unavailable<\/Button>/);
});
