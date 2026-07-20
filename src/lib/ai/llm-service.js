import { getLLMModel } from "./model-config.js";
import { filterActivePlatforms } from "../platforms/platform-config.js";

const PROVIDER_TIMEOUT_MS = 15_000;

export async function generatePlatformTargets({
  llmProvider = "google",
  llmModel,
  settings,
  input,
  fetchImpl = fetch,
}) {
  const platforms = filterActivePlatforms(input.platforms ?? ["meta", "line"]);
  const targets = [];

  for (const platform of platforms) {
    const prompt = buildPlatformPrompt(platform, input);
    const content = await generateText({
      llmProvider,
      llmModel,
      settings,
      prompt,
      fetchImpl,
    });

    targets.push({
      platform,
      content,
      hashtags: [],
    });
  }

  return targets;
}

export function generateText({
  llmProvider = "google",
  llmModel,
  settings,
  systemPrompt,
  prompt,
  fetchImpl = fetch,
  signal,
}) {
  const boundedSignal = signal ?? AbortSignal.timeout(PROVIDER_TIMEOUT_MS);
  return llmProvider === "openai"
    ? generateWithOpenAI(prompt, llmModel, settings, fetchImpl, systemPrompt, boundedSignal)
    : generateWithGemini(prompt, llmModel, settings, fetchImpl, systemPrompt, boundedSignal);
}

export function buildPlatformPrompt(platform, input) {
  const platformInstruction =
    platform === "line"
      ? "請寫成 LINE 官方帳號廣播訊息，短、親切、不要 hashtag。"
      : "請寫成 Facebook 粉專貼文，包含清楚 CTA，可包含 2 到 3 個 hashtag。";

  return [
    platformInstruction,
    `產品名稱：${input.productName ?? ""}`,
    `核心特點：${input.productFeatures ?? ""}`,
    `目標受眾：${input.audience ?? "通用"}`,
    `語氣風格：${input.tone ?? "親切"}`,
  ].join("\n");
}

async function generateWithOpenAI(prompt, llmModel, settings, fetchImpl, systemPrompt, signal) {
  if (!settings.openAiApiKey) {
    throw new Error("OPENAI_API_KEY is required.");
  }

  const response = await requestProvider("OpenAI", () =>
    fetchImpl("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.openAiApiKey}`,
      },
      signal,
      body: JSON.stringify({
        model: getLLMModel("openai", llmModel),
        ...(systemPrompt ? { instructions: systemPrompt } : {}),
        input: prompt,
      }),
    }),
  );
  const body = await readJsonResponse(response, "OpenAI generation failed.");

  return extractOpenAIText(body);
}

async function generateWithGemini(prompt, llmModel, settings, fetchImpl, systemPrompt, signal) {
  if (!settings.googleAiApiKey) {
    throw new Error("GOOGLE_AI_API_KEY is required.");
  }

  const model = getLLMModel("google", llmModel);
  const response = await requestProvider("Gemini", () =>
    fetchImpl("https://generativelanguage.googleapis.com/v1beta/interactions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": settings.googleAiApiKey,
      },
      signal,
      body: JSON.stringify({
        model,
        ...(systemPrompt ? { system_instruction: systemPrompt } : {}),
        input: prompt,
      }),
    }),
  );
  const body = await readJsonResponse(response, "Gemini generation failed.");

  return extractGeminiText(body);
}

async function readJsonResponse(response, fallbackMessage) {
  const body = await response.json().catch(async () => ({ raw: await response.text() }));
  if (!response.ok) {
    void body;
    const error = new Error(fallbackMessage);
    error.retryable = response.status === 408 || response.status === 429 || response.status >= 500;
    throw error;
  }
  return body;
}

function extractOpenAIText(body) {
  if (body.output_text) return body.output_text.trim();
  const text = body.output
    ?.flatMap((item) => item.content ?? [])
    ?.map((content) => content.text)
    ?.filter(Boolean)
    ?.join("\n");

  if (!text) throw new Error("OpenAI response did not include text.");
  return text.trim();
}

function extractGeminiText(body) {
  if (typeof body.output === "string") return body.output.trim();
  if (typeof body.output_text === "string") return body.output_text.trim();
  const stepText = body.steps
    ?.flatMap((step) => (Array.isArray(step.content) ? step.content : [step.content]))
    ?.map((content) => content?.text)
    ?.filter(Boolean)
    ?.join("\n");

  if (stepText) return stepText.trim();

  const text = body.candidates?.[0]?.content?.parts
    ?.map((part) => part.text)
    ?.filter(Boolean)
    ?.join("\n");

  if (!text) throw new Error("Gemini response did not include text.");
  return text.trim();
}

async function requestProvider(providerName, request) {
  try {
    return await request();
  } catch (error) {
    const wrapped = new Error(`${providerName} API request failed: ${error.message}`);
    wrapped.retryable = error?.retryable === true
      || error?.name === "AbortError"
      || error?.name === "TimeoutError"
      || error instanceof TypeError;
    throw wrapped;
  }
}
