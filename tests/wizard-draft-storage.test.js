import assert from "node:assert/strict";
import test from "node:test";

import {
  clearWizardDraft,
  getWizardDraftKey,
  readWizardDraft,
  writeWizardDraft,
} from "../src/lib/wizard/wizard-draft-storage.js";

test("round-trips a versioned wizard snapshot through session storage", () => {
  const storage = createStorage();
  const snapshot = {
    active: 2,
    form: { productName: "新品", platforms: ["meta"] },
    generatedTargets: [{ platform: "meta", content: "文案" }],
    imageUrl: "https://example.test/image.png",
    generationStatus: "success",
    publishResult: null,
  };

  assert.equal(writeWizardDraft(storage, snapshot, "owner@example.com"), true);
  assert.deepEqual(readWizardDraft(storage, "owner@example.com"), snapshot);
  assert.match(storage.getItem(getWizardDraftKey("owner@example.com")), /"version":2/);
});

test("does not restore a draft for a different signed-in owner", () => {
  const storage = createStorage();
  writeWizardDraft(storage, { active: 2, form: { productName: "Private draft" } }, "first@example.com");

  assert.equal(readWizardDraft(storage, "second@example.com"), null);
  assert.deepEqual(readWizardDraft(storage, " FIRST@example.com "), {
    active: 2,
    form: { productName: "Private draft" },
  });
  assert.notEqual(getWizardDraftKey("first@example.com"), getWizardDraftKey("second@example.com"));
});

test("ignores malformed or unsupported wizard snapshots", () => {
  const storage = createStorage();

  storage.setItem(getWizardDraftKey(), "not-json");
  assert.equal(readWizardDraft(storage), null);

  storage.setItem(getWizardDraftKey(), JSON.stringify({ version: 999, snapshot: {} }));
  assert.equal(readWizardDraft(storage), null);
});

test("does not restore transient loading states and can clear the draft", () => {
  for (const publishStatus of ["loading", "checking", "publishing"]) {
    const storage = createStorage();
    writeWizardDraft(storage, {
      active: 2,
      form: { productName: "新品" },
      generationStatus: "loading",
      publishStatus,
    });

    assert.deepEqual(readWizardDraft(storage), {
      active: 2,
      form: { productName: "新品" },
      generationStatus: "idle",
      publishStatus: "idle",
    });
  }

  const storage = createStorage();
  writeWizardDraft(storage, { active: 1, form: { productName: "新品" } });
  assert.equal(clearWizardDraft(storage), true);
  assert.equal(readWizardDraft(storage), null);
});

function createStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}
