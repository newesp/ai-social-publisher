import assert from "node:assert/strict";
import test from "node:test";
import {
  getInitialPostForm,
  shouldGenerateOnPreviewAdvance,
} from "../src/lib/wizard/wizard-flow.js";

test("starts product fields blank and audience as general", () => {
  const form = getInitialPostForm();

  assert.equal(form.productName, "");
  assert.equal(form.productFeatures, "");
  assert.equal(form.audience, "general");
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
