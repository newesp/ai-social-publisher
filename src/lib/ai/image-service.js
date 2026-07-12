import { getImageModel } from "./model-config.js";

const GEMINI_INTERACTIONS_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";

export async function generateGeminiImage({ prompt, imageModel, settings, fetchImpl = fetch }) {
  if (!settings.googleAiApiKey) {
    throw new Error("GOOGLE_AI_API_KEY is required.");
  }

  const response = await requestGeminiImage(() =>
    fetchImpl(GEMINI_INTERACTIONS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": settings.googleAiApiKey,
      },
      body: JSON.stringify({
        model: getImageModel("google", imageModel),
        input: [{ type: "text", text: prompt }],
        response_format: { type: "image", mime_type: "image/jpeg", delivery: "inline" },
      }),
    }),
  );
  const body = await readJsonResponse(response);

  return extractImagePayload(body);
}

async function requestGeminiImage(request) {
  try {
    return await request();
  } catch (error) {
    throw new Error(`Gemini image API request failed: ${error.message}`);
  }
}

async function readJsonResponse(response) {
  const body = await response.json().catch(async () => ({ raw: await response.text() }));
  if (!response.ok) {
    throw new Error(body.error?.message ?? body.message ?? "Gemini image generation failed.");
  }
  return body;
}

function extractImagePayload(body) {
  if (body.output_image?.data) {
    return toDataUrl(body.output_image.data, body.output_image.mime_type ?? body.output_image.mimeType);
  }
  if (typeof body.image === "string") return toDataUrl(body.image);
  const imageItem = Array.isArray(body.output)
    ? body.output.find((item) => item.type === "image" && item.image)
    : null;

  if (imageItem?.image) return toDataUrl(imageItem.image);
  const imageFromSteps = findImagePayload(body.steps);
  if (imageFromSteps) return imageFromSteps;

  throw new Error("Gemini image response did not include image data.");
}

function findImagePayload(value) {
  if (!value) return null;

  if (Array.isArray(value)) {
    for (const item of value) {
      const result = findImagePayload(item);
      if (result) return result;
    }
    return null;
  }

  if (typeof value !== "object") return null;

  if (typeof value.image === "string") return toDataUrl(value.image);
  if (typeof value.b64_json === "string") return toDataUrl(value.b64_json);
  if (value.type === "image" && typeof value.data === "string") {
    return toDataUrl(value.data, value.mime_type ?? value.mimeType);
  }
  if (value.inline_data?.data) return toDataUrl(value.inline_data.data, value.inline_data.mime_type);
  if (value.inlineData?.data) return toDataUrl(value.inlineData.data, value.inlineData.mimeType);

  for (const child of Object.values(value)) {
    const result = findImagePayload(child);
    if (result) return result;
  }

  return null;
}

function toDataUrl(image, mimeType = "image/png") {
  if (image.startsWith("data:")) return image;
  return `data:${mimeType};base64,${image}`;
}
