import { normalizeEmail } from "../../auth/policy.js";

const ACTIONS = new Set(["return_to_ai", "resolve"]);

export function createSupportHumanActionRouteHandlers({
  requireOwner, requireSameOrigin = () => {}, getStore, startTransition = async () => {},
  respond = (body, init) => Response.json(body, init),
}) {
  return {
    async takeOver(request, id) {
      const owner = await authenticatedOwner(requireOwner); requireSameOrigin(request);
      const result = await (await getStore()).takeOver(owner, requiredId(id), requiredVersion(await jsonBody(request)));
      return result ? respond({ conversation: safeConversation(result) }) : notFound(respond);
    },
    async sendMessage(request, id) {
      const owner = await authenticatedOwner(requireOwner); requireSameOrigin(request);
      const message = await (await getStore()).sendHumanMessage(owner, requiredId(id), humanMessageBody(await jsonBody(request)));
      return message ? respond({ message: safeMessage(message) }) : notFound(respond);
    },
    async requestTransition(request, id) {
      const owner = await authenticatedOwner(requireOwner); requireSameOrigin(request);
      const body = await jsonBody(request);
      if (!ACTIONS.has(body?.action)) throw routeError("Support transition action is invalid.", 400);
      const transition = await (await getStore()).requestTransition(owner, requiredId(id), body.action, requiredVersion(body));
      if (!transition) return notFound(respond);
      await startTransition({ transitionId: transition.id, conversationId: transition.conversationId });
      return respond({ transition: safeTransition(transition) });
    },
    async undoTransition(request, id, transitionId) {
      const owner = await authenticatedOwner(requireOwner); requireSameOrigin(request);
      const result = await (await getStore()).undoTransition(owner, requiredId(id), requiredId(transitionId));
      return result ? respond({ conversation: safeConversation(result) }) : respond({ error: "Support transition can no longer be undone." }, { status: 409 });
    },
  };
}

async function authenticatedOwner(requireOwner) { const owner = normalizeEmail(await requireOwner()); if (!owner) throw routeError("Authentication is required.", 401); return owner; }
async function jsonBody(request) { try { return await request.json(); } catch { throw routeError("A JSON request body is required.", 400); } }
function requiredId(value) { const id = String(value ?? "").trim(); if (!id || id.length > 100) throw routeError("Conversation ID is invalid.", 400); return id; }
function requiredVersion(body) { if (!Number.isInteger(body?.expectedVersion) || body.expectedVersion < 0) throw routeError("Expected conversation version is required.", 400); return body.expectedVersion; }
function humanMessageBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 2) throw routeError("Human reply is invalid.", 400);
  const text = typeof body.text === "string" ? body.text.trim() : "";
  const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim() : "";
  if (!text || text.length > 5_000 || !idempotencyKey || idempotencyKey.length > 100) throw routeError("Human reply is invalid.", 400);
  return { text, idempotencyKey };
}
function safeConversation(value) { return { id: String(value.id ?? ""), status: String(value.status ?? ""), version: Number.isInteger(value.version) ? value.version : 0 }; }
function safeMessage(value) { return { id: String(value.id ?? ""), deliveryStatus: String(value.deliveryStatus ?? "failed"), safeErrorCode: value.safeErrorCode ?? null }; }
function safeTransition(value) { return { id: String(value.id ?? ""), conversationId: String(value.conversationId ?? ""), action: String(value.action ?? ""), effectiveAt: new Date(value.effectiveAt).toISOString() }; }
function notFound(respond) { return respond({ error: "Support conversation not found." }, { status: 404 }); }
function routeError(message, status) { const error = new Error(message); error.status = status; return error; }
