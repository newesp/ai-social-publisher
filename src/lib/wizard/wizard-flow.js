export const WIZARD_STEPS = {
  PRODUCT: 0,
  PROVIDER: 1,
  PREVIEW: 2,
};

export function getInitialPostForm() {
  return {
    productName: "",
    productFeatures: "",
    audience: "general",
    tone: "friendly",
    platforms: ["meta", "line"],
    llmProvider: "google",
    imageProvider: "google",
    mode: "now",
  };
}

export function shouldGenerateOnPreviewAdvance({
  currentStep,
  nextStep,
  hasGeneratedTargets,
}) {
  return (
    currentStep === WIZARD_STEPS.PROVIDER &&
    nextStep === WIZARD_STEPS.PREVIEW &&
    !hasGeneratedTargets
  );
}
