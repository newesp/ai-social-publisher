import { getImageModel, getLLMModel } from "./model-config.js";
import { generateGeminiImage } from "./image-service.js";
import { generatePlatformTargets } from "./llm-service.js";
import { uploadGeneratedImage } from "../blob/blob-upload-service.js";
import { buildPlatformPreviews } from "../platform-preview/build-platform-previews.js";

export async function buildGeneratedResponse({
  body,
  settings,
  generateTargets = generatePlatformTargets,
  generateImage = generateGeminiImage,
  uploadImage = uploadGeneratedImage,
}) {
  const targets = await generateTargets({
    llmProvider: body.llmProvider,
    llmModel: body.llmModel,
    settings,
    input: body,
  });
  let imageUrl = null;
  let imageError = null;

  if (body.imageProvider !== "openai") {
    try {
      const generatedImageUrl = await generateImage({
        prompt: buildImagePrompt(body),
        imageModel: body.imageModel,
        settings,
      });
      imageUrl = await uploadImage({ imageUrl: generatedImageUrl });
    } catch (error) {
      imageError = error.message;
    }
  }

  return {
    llmModel: getLLMModel(body.llmProvider, body.llmModel),
    imageModel: getImageModel(body.imageProvider, body.imageModel),
    imageUrl,
    imageError,
    targets,
    previews: buildPlatformPreviews({ imageUrl, targets }),
  };
}

export function buildImagePrompt(body) {
  return [
    "Create a clean product marketing image suitable for social media.",
    `Product name: ${body.productName ?? ""}`,
    `Product features: ${body.productFeatures ?? ""}`,
    "No text overlays. Keep it realistic and brand-safe.",
  ].join("\n");
}
