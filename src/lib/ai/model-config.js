export const DEFAULT_LLM_PROVIDER = "google";
export const DEFAULT_IMAGE_PROVIDER = "google";

export const LLM_MODEL_OPTIONS = Object.freeze({
  google: Object.freeze(["gemini-2.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3.5-flash"]),
  openai: Object.freeze(["gpt-4o"]),
});

export const IMAGE_MODEL_OPTIONS = Object.freeze({
  google: Object.freeze(["gemini-3.1-flash-lite-image", "gemini-3.1-flash-image"]),
  openai: Object.freeze(["gpt-image-2"]),
});

export const LLM_MODELS = getDefaultModels(LLM_MODEL_OPTIONS);
export const IMAGE_MODELS = getDefaultModels(IMAGE_MODEL_OPTIONS);

export function getLLMModel(provider = DEFAULT_LLM_PROVIDER, requestedModel) {
  if (requestedModel) return requestedModel;
  return LLM_MODELS[provider] ?? LLM_MODELS[DEFAULT_LLM_PROVIDER];
}

export function getImageModel(provider = DEFAULT_IMAGE_PROVIDER, requestedModel) {
  if (requestedModel) return requestedModel;
  return IMAGE_MODELS[provider] ?? IMAGE_MODELS[DEFAULT_IMAGE_PROVIDER];
}

export function getLLMModelOptions(provider = DEFAULT_LLM_PROVIDER) {
  return LLM_MODEL_OPTIONS[provider] ?? LLM_MODEL_OPTIONS[DEFAULT_LLM_PROVIDER];
}

export function getImageModelOptions(provider = DEFAULT_IMAGE_PROVIDER) {
  return IMAGE_MODEL_OPTIONS[provider] ?? IMAGE_MODEL_OPTIONS[DEFAULT_IMAGE_PROVIDER];
}

function getDefaultModels(modelOptions) {
  return Object.freeze(
    Object.fromEntries(Object.entries(modelOptions).map(([provider, options]) => [provider, options[0]])),
  );
}
