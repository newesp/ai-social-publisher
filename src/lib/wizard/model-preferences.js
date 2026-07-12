import { getImageModelOptions, getLLMModelOptions } from "../ai/model-config.js";

export const MODEL_PREFERENCES_KEY = "ai-social-publisher:model-preferences";

export function readModelPreferences(storage) {
  try {
    const targetStorage = storage ?? getBrowserStorage();
    if (!targetStorage) return {};

    const value = targetStorage.getItem(MODEL_PREFERENCES_KEY);
    if (!value) return {};

    const preferences = JSON.parse(value);
    return preferences && typeof preferences === "object" && !Array.isArray(preferences) ? preferences : {};
  } catch {
    return {};
  }
}

export function writeModelPreferences(preferences, storage) {
  try {
    const targetStorage = storage ?? getBrowserStorage();
    if (!targetStorage) return false;

    targetStorage.setItem(MODEL_PREFERENCES_KEY, JSON.stringify(preferences));
    return true;
  } catch {
    return false;
  }
}

export function getPreferredModel(kind, provider, preferences = {}) {
  const options = kind === "image" ? getImageModelOptions(provider) : getLLMModelOptions(provider);
  const rememberedModel = preferences[kind]?.[provider];

  return options.includes(rememberedModel) ? rememberedModel : options[0];
}

function getBrowserStorage() {
  if (typeof window === "undefined") return null;
  return window.localStorage;
}
