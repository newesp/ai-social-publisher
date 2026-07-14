import { proofreadTargets } from "../ai/proofread-service.js";
import { getLLMModelOptions } from "../ai/model-config.js";

const SAFE_PROOFREAD_ERROR = "AI 錯字檢查失敗，請稍後再試。";

export function createProofreadRouteHandler({
  requireOwner,
  store,
  getStore = () => store,
  proofread = ({ body, settings }) => proofreadTargets({ ...body, settings }),
  respond = jsonResponse,
}) {
  return async function POST(request) {
    const ownerEmail = await requireOwner();

    try {
      const body = await request.json();
      validateProofreadRequest(body);
      const settingsStore = await getStore();
      const settings = await settingsStore.read(ownerEmail);
      return respond(await proofread({ body, settings }));
    } catch {
      return respond({ error: SAFE_PROOFREAD_ERROR }, { status: 400 });
    }
  };
}

function validateProofreadRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid body");
  if (!["google", "openai"].includes(body.llmProvider)) throw new Error("invalid provider");
  if (!getLLMModelOptions(body.llmProvider).includes(body.llmModel)) throw new Error("invalid model");
  if (!Array.isArray(body.targets) || body.targets.length < 1 || body.targets.length > 3) {
    throw new Error("invalid targets");
  }

  const platforms = new Set();
  let totalLength = 0;
  for (const target of body.targets) {
    if (!target || !["meta", "line"].includes(target.platform) || platforms.has(target.platform)) {
      throw new Error("invalid platform");
    }
    if (typeof target.content !== "string" || !target.content.trim() || target.content.length > 5000) {
      throw new Error("invalid content");
    }
    platforms.add(target.platform);
    totalLength += target.content.length;
  }
  if (totalLength > 10000) throw new Error("content too large");
}

function jsonResponse(body, init) {
  return Response.json(body, init);
}
