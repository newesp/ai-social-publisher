import assert from "node:assert/strict";
import test from "node:test";
import {
  getInitialPostForm,
  reconcileConnectedPlatforms,
  shouldGenerateOnPreviewAdvance,
} from "../src/lib/wizard/wizard-flow.js";

test("starts product fields blank and audience as general", () => {
  const form = getInitialPostForm();

  assert.equal(form.productName, "");
  assert.equal(form.productFeatures, "");
  assert.equal(form.audience, "general");
});

test("initial form selects only valid connected publishing platforms", () => {
  const form = getInitialPostForm({}, ["line", "instagram", "meta", "line"]);

  assert.deepEqual(form.platforms, ["line", "meta"]);
  assert.deepEqual(getInitialPostForm({}, []).platforms, []);
});

test("availability removes stale selections and defaults to remaining connected platforms", () => {
  assert.deepEqual(reconcileConnectedPlatforms(["meta", "line"], ["line"]), ["line"]);
  assert.deepEqual(reconcileConnectedPlatforms([], ["meta", "line"]), ["meta", "line"]);
  assert.deepEqual(reconcileConnectedPlatforms(["instagram"], ["meta"]), ["meta"]);
});

test("generates AI content only when advancing from provider step without generated content", () => {
  assert.equal(
    shouldGenerateOnPreviewAdvance({
      currentStep: 1,
      nextStep: 2,
      hasGeneratedTargets: false,
    }),
    true,
  );
  assert.equal(
    shouldGenerateOnPreviewAdvance({
      currentStep: 2,
      nextStep: 2,
      hasGeneratedTargets: false,
    }),
    false,
  );
  assert.equal(
    shouldGenerateOnPreviewAdvance({
      currentStep: 1,
      nextStep: 2,
      hasGeneratedTargets: true,
    }),
    false,
  );
});
