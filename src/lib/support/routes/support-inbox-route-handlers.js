import { normalizeEmail } from "../../auth/policy.js";

const ALLOWED_STATUSES = new Set(["ai_active", "waiting_human", "human_active", "resolved"]);

export function createSupportInboxRouteHandlers({
  requireOwner,
  requireSameOrigin = () => {},
  store,
  getStore = () => store,
  respond = (body, init) => Response.json(body, init),
}) {
  return {
    async listConversations(request) {
      const owner = await normalizedOwner(requireOwner);
      const supportStore = await getStore();
      const url = new URL(request.url);
      const status = url.searchParams.get("status") || undefined;
      const cursor = url.searchParams.get("cursor") || undefined;
      if (status && !ALLOWED_STATUSES.has(status)) throw routeError("Conversation status is invalid.", 400);
      const result = await supportStore.listConversations(owner, { status, cursor });
      return respond({
        conversations: Array.isArray(result?.conversations) ? result.conversations.map(toSummary) : [],
        nextCursor: typeof result?.nextCursor === "string" ? result.nextCursor : null,
        attentionCount: safeCount(result?.attentionCount),
      });
    },

    async getConversation(_request, id) {
      const owner = await normalizedOwner(requireOwner);
      const supportStore = await getStore();
      const conversation = await supportStore.getConversation(owner, requiredId(id));
      if (!conversation) return respond({ error: "Support conversation not found." }, { status: 404 });
      return respond({ conversation: toConversation(conversation) });
    },

    async markConversationRead(request, id) {
      const owner = await normalizedOwner(requireOwner);
      requireSameOrigin(request);
      const supportStore = await getStore();
      const conversation = await supportStore.markConversationRead(owner, requiredId(id));
      if (!conversation) return respond({ error: "Support conversation not found." }, { status: 404 });
      return respond({ conversation: { id: conversation.id, unreadCount: 0 } });
    },
  };
}

function toSummary(value) {
  return {
    id: safeText(value?.id),
    customerLabel: safeText(value?.customerLabel) || "Customer",
    status: safeText(value?.status),
    unreadCount: safeCount(value?.unreadCount),
    handoffReason: nullableText(value?.handoffReason),
    lastMessagePreview: nullableText(value?.lastMessagePreview),
    deliveryFailed: value?.deliveryFailed === true,
    lastInboundAt: safeDate(value?.lastInboundAt),
    lastOutboundAt: safeDate(value?.lastOutboundAt),
    updatedAt: safeDate(value?.updatedAt),
    pendingTransition: value?.pendingTransition ? { id: safeText(value.pendingTransition.id), action: safeText(value.pendingTransition.action), effectiveAt: safeDate(value.pendingTransition.effectiveAt) } : null,
  };
}

function toConversation(value) {
  return {
    ...toSummary(value),
    version: Number.isInteger(value?.version) && value.version >= 0 ? value.version : 0,
    messages: Array.isArray(value?.messages) ? value.messages.map((message) => ({
      id: safeText(message?.id), direction: safeText(message?.direction), senderType: safeText(message?.senderType),
      messageType: safeText(message?.messageType), text: nullableText(message?.text),
      deliveryStatus: safeText(message?.deliveryStatus), safeErrorCode: nullableText(message?.safeErrorCode),
      createdAt: safeDate(message?.createdAt), sentAt: safeDate(message?.sentAt), failedAt: safeDate(message?.failedAt),
    })) : [],
    decisions: Array.isArray(value?.decisions) ? value.decisions.map((decision) => ({
      id: safeText(decision?.id), action: safeText(decision?.action), category: nullableText(decision?.category),
      reasonCode: nullableText(decision?.reasonCode), createdAt: safeDate(decision?.createdAt),
      faqSourceIds: Array.isArray(decision?.faqSourceIds) ? decision.faqSourceIds.map(safeText).filter(Boolean) : [],
    })) : [],
    faqSources: Array.isArray(value?.faqSources) ? value.faqSources.map((faq) => ({
      id: safeText(faq?.id), question: safeText(faq?.question), category: safeText(faq?.category),
    })) : [],
    pendingTransition: value?.pendingTransition ? {
      id: safeText(value.pendingTransition.id), action: safeText(value.pendingTransition.action),
      effectiveAt: safeDate(value.pendingTransition.effectiveAt),
    } : null,
  };
}

function safeText(value) { return typeof value === "string" ? value.slice(0, 4_000) : ""; }
function nullableText(value) { const text = safeText(value); return text || null; }
function safeCount(value) { return Number.isSafeInteger(value) && value > 0 ? value : 0; }
function safeDate(value) { return value instanceof Date || typeof value === "string" || typeof value === "number" ? new Date(value).toISOString() : null; }
function requiredId(value) { const id = safeText(value).trim(); if (!id || id.length > 100) throw routeError("Conversation ID is invalid.", 400); return id; }
async function normalizedOwner(requireOwner) { const owner = normalizeEmail(await requireOwner()); if (!owner) throw routeError("Authentication is required.", 401); return owner; }
function routeError(message, status) { const error = new Error(message); error.status = status; return error; }
