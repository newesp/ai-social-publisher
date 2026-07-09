import assert from "node:assert/strict";
import { test } from "node:test";

import { createDraftTargets } from "../src/lib/content/draft-content.js";

test("creates platform draft content from the latest product information", () => {
  const targets = createDraftTargets({
    productName: "Alpha CRM",
    productFeatures: "自動整理客戶訊息並提醒業務跟進",
    platforms: ["meta", "line"],
  });

  assert.equal(targets[0].content.includes("Alpha CRM"), true);
  assert.equal(targets[0].content.includes("自動整理客戶訊息"), true);
  assert.equal(targets[1].content.includes("Alpha CRM"), true);
  assert.equal(targets[1].content.includes("自動整理客戶訊息"), true);
});

test("does not append a fixed Facebook CTA sentence to draft content", () => {
  const [metaTarget] = createDraftTargets({
    productName: "Alpha CRM",
    productFeatures: "自動整理客戶訊息",
    platforms: ["meta"],
  });

  assert.equal(metaTarget.content.includes("現在就看看這次更新能怎麼幫你的團隊省下時間"), false);
});

test("filters inactive platforms while creating draft content", () => {
  const targets = createDraftTargets({
    productName: "Alpha CRM",
    productFeatures: "自動整理客戶訊息",
    platforms: ["meta", "instagram", "line"],
  });

  assert.deepEqual(
    targets.map((target) => target.platform),
    ["meta", "line"],
  );
});

test("does not add canned hashtags to draft targets", () => {
  const targets = createDraftTargets({
    productName: "Alpha CRM",
    productFeatures: "Saves time",
    platforms: ["meta", "line"],
  });

  assert.deepEqual(
    targets.map((target) => target.hashtags),
    [[], []],
  );
});
