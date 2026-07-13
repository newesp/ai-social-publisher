import { getPreferredModel } from "./model-preferences.js";
import { filterActivePlatforms } from "../platforms/platform-config.js";

export const WIZARD_STEPS = {
  PRODUCT: 0,
  PROVIDER: 1,
  PREVIEW: 2,
};

export function getInitialPostForm(modelPreferences = {}, connectedPlatforms = []) {
  return {
    productName: "",
    productFeatures: "",
    audience: "general",
    tone: "friendly",
    platforms: connectedValues(connectedPlatforms),
    llmProvider: "google",
    llmModel: getPreferredModel("llm", "google", modelPreferences),
    imageProvider: "google",
    imageModel: getPreferredModel("image", "google", modelPreferences),
    mode: "now",
  };
}

export function reconcileConnectedPlatforms(selectedPlatforms = [], connectedPlatforms = []) {
  const connected = connectedValues(connectedPlatforms);
  const connectedSet = new Set(connected);
  const remaining = connectedValues(selectedPlatforms).filter((platform) => connectedSet.has(platform));
  return remaining.length > 0 ? remaining : connected;
}

function connectedValues(platforms) {
  return [...new Set(filterActivePlatforms(Array.isArray(platforms) ? platforms : []))];
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
