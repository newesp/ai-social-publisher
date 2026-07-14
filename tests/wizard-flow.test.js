import assert from "node:assert/strict";
import test from "node:test";
import {
  canSelectWizardStep,
  getInitialPostForm,
  reconcileConnectedPlatforms,
  isProductStepComplete,
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
      currentStep: 0,
      nextStep: 2,
      hasGeneratedTargets: false,
    }),
    true,
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

test("requires every product field before later steps can be selected", () => {
  const complete = {
    ...getInitialPostForm(),
    productName: "  新商品  ",
    productFeatures: "  輕巧耐用  ",
    platforms: ["meta"],
  };

  assert.equal(isProductStepComplete(complete), true);
  assert.equal(canSelectWizardStep({ step: 1, form: complete }), true);
  assert.equal(canSelectWizardStep({ step: 2, form: complete }), true);

  for (const incomplete of [
    { ...complete, productName: "   " },
    { ...complete, productFeatures: "\n" },
    { ...complete, audience: "" },
    { ...complete, tone: null },
    { ...complete, platforms: [] },
  ]) {
    assert.equal(isProductStepComplete(incomplete), false);
    assert.equal(canSelectWizardStep({ step: 1, form: incomplete }), false);
    assert.equal(canSelectWizardStep({ step: 2, form: incomplete }), false);
    assert.equal(canSelectWizardStep({ step: 0, form: incomplete }), true);
  }
});
