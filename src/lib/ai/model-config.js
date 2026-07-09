export const DEFAULT_LLM_PROVIDER = "google";
export const DEFAULT_IMAGE_PROVIDER = "google";

export const LLM_MODELS = Object.freeze({
  google: "gemini-3.5-flash",
  openai: "gpt-4o",
});

export const IMAGE_MODELS = Object.freeze({
  google: "gemini-3.1-flash-image",
  openai: "gpt-image-2",
});

export function getLLMModel(provider = DEFAULT_LLM_PROVIDER) {
  return LLM_MODELS[provider] ?? LLM_MODELS[DEFAULT_LLM_PROVIDER];
}

export function getImageModel(provider = DEFAULT_IMAGE_PROVIDER) {
  return IMAGE_MODELS[provider] ?? IMAGE_MODELS[DEFAULT_IMAGE_PROVIDER];
}
