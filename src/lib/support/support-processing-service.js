import { retrieveRagKnowledge } from "./knowledge/rag-retrieval.js";

const MAX_AI_TURNS_PER_WINDOW = 10;
const CLOSURE_CONFIRMATION_TEXT = "以上說明是否解決您的問題？若沒有其他問題，我可以為您結案。";
const CLOSURE_FAREWELL_TEXT = "感謝您的確認。這次對話已為您結案；之後若還需要協助，隨時再傳訊息給我們。";

export function createSupportProcessingService({ repository, decisionService, deliveryService, now = () => new Date() } = {}) {
  return {
    async acquireClaim(input) {
      return repository.acquireConversationClaim(input);
    },

    async buildTurn(input) {
      const turn = await repository.buildClaimedTurn(input);
      return turn ? {
        inboundMessageId: turn.inboundMessageId,
        ...(turn.handoffReasonCode ? { handoffReasonCode: turn.handoffReasonCode } : {}),
      } : null;
    },

    async recoverDelivery(input) {
      const recovered = await repository.recoverExistingDelivery(input);
      return recovered ? {
        status: "pending_delivery",
        deliveryId: recovered.deliveryId,
        ...(recovered.handoffAcknowledgement === true ? { handoffAcknowledgement: true } : {}),
      } : null;
    },

    async renewClaim(input) {
      const renewed = await repository.renewConversationClaim(input);
      if (renewed !== true) throw new Error("Conversation processing claim was lost.");
      return true;
    },

    async decideAndPersist(input) {
      if (input.handoffReasonCode) return persistHandoff(repository, input, input.handoffReasonCode);
      let context = await repository.loadCurrentProcessingContext(input);
      const failClosedReason = stateFailure(context);
      if (failClosedReason) return persistHandoff(repository, input, failClosedReason);
      if (Number(context.aiTurnsInLastFiveMinutes) >= MAX_AI_TURNS_PER_WINDOW) {
        return persistHandoff(repository, input, "rate_limit");
      }
      if (context.configurationReady === false || !context.configuration || !context.settings || !context.recipient) {
        return persistHandoff(repository, input, "configuration_unready");
      }

      let decision;
      if (context.aiClosureConfirmationMessageId
        && closureConfirmationIsCurrent(context.aiClosureConfirmationExpiresAt, currentDate(now))
        && customerConfirmedClosure(context.customerTexts)) {
        decision = {
          action: "reply",
          answer: CLOSURE_FAREWELL_TEXT,
          category: null,
          handoffReasonCode: null,
          knowledgeSourceIds: [],
          conversationDisposition: "resolve_after_delivery",
        };
      } else {
        const sources = retrieveRagKnowledge({
          query: context.customerTexts?.join("\n") ?? "",
          knowledge: context.faqs,
        });
        try {
          decision = await decisionService.decide({
            configuration: context.configuration,
            settings: context.settings,
            messages: context.messages,
            faqs: sources,
          });
        } catch (error) {
          if (error?.retryable === true) return { status: "retryable_provider" };
          return persistHandoff(repository, { ...input, now: currentDate(now) }, "invalid_ai_decision");
        }
        if (decision?.action === "reply") {
          decision = {
            ...decision,
            answer: `${decision.answer}\n\n${CLOSURE_CONFIRMATION_TEXT}`,
            conversationDisposition: "ask_close_confirmation",
          };
        } else if (decision) {
          decision = { ...decision, conversationDisposition: "continue_ai" };
        }
      }
      if (!decision || !["reply", "clarify"].includes(decision.action)) {
        return persistHandoff(repository, { ...input, now: currentDate(now) }, decision?.handoffReasonCode ?? "invalid_ai_decision");
      }

      // Provider work may outlive a lease and configuration can be changed while it runs.
      // Reload protected state immediately before the fenced decision/outbox transaction.
      context = await repository.loadCurrentProcessingContext({ ...input, now: currentDate(now) });
      const afterProviderFailure = stateFailure(context);
      if (afterProviderFailure) return persistHandoff(repository, { ...input, now: currentDate(now) }, afterProviderFailure);
      if (context.configurationReady === false || !context.configuration || !context.settings || !context.recipient) {
        return persistHandoff(repository, { ...input, now: currentDate(now) }, "configuration_unready");
      }

      const canonicalBody = JSON.stringify({
        to: context.recipient,
        messages: [{ type: "text", text: decision.answer }],
      });
      const persisted = await repository.persistDecisionAndOutbound({
        ...input,
        decision,
        canonicalBody,
        now: currentDate(now),
      });
      return { status: "pending_delivery", deliveryId: persisted.deliveryId };
    },

    async deliver(input) {
      return deliveryService.attemptDelivery(input);
    },

    async releaseClaim(input) {
      return repository.releaseConversationClaim(input);
    },

    async findFollowUp(input) {
      return repository.findNextUnprocessedEvent(input);
    },

    async resolveCompetingEvent(input) {
      return repository.resolveLineEventAfterConversationLoss(input);
    },

    async finalizeHandoff(input) {
      return repository.finalizeHandoffDelivery({
        deliveryId: input.deliveryId,
        eventId: input.eventId,
        eventClaimId: input.eventClaimId,
        connectionId: input.connectionId,
        conversationId: input.conversationId,
        claimId: input.conversationClaimId,
        now: input.now,
      });
    },

    async persistHandoff(input) {
      return persistHandoff(repository, input, input.reasonCode);
    },
  };
}

function stateFailure(context) {
  if (!context || context.supportState !== "enabled") return "support_disabled";
  if (context.conversationStatus !== "ai_active") return "human_controlled";
  return null;
}

async function persistHandoff(repository, input, reasonCode) {
  const persisted = await repository.persistHandoff({
    eventId: input.eventId,
    ...(input.eventClaimId ? { eventClaimId: input.eventClaimId } : {}),
    connectionId: input.connectionId,
    conversationId: input.conversationId,
    claimId: input.claimId,
    inboundMessageId: input.inboundMessageId,
    ...(input.cutoff ? { cutoff: input.cutoff } : {}),
    reasonCode,
    now: input.now,
  });
  if (persisted?.deliveryId) {
    return {
      status: "pending_delivery",
      deliveryId: persisted.deliveryId,
      handoffAcknowledgement: true,
    };
  }
  return {
    status: "waiting_human", handoffReasonCode: reasonCode,
    ...(persisted?.eventCompleted === true ? { eventCompleted: true } : {}),
  };
}

function currentDate(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("Processing clock returned an invalid time.");
  return date;
}

function customerConfirmedClosure(texts) {
  const latest = Array.isArray(texts) ? texts.at(-1) : "";
  const normalized = String(latest ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, "")
    .trim();
  return /(?:\u6c92\u6709\u4e86|\u6c92\u6709\u5176\u4ed6\u554f\u984c|\u6c92\u554f\u984c\u4e86|\u6c92\u554f\u984c|\u6c92\u6709\u554f\u984c|\u5df2\u89e3\u6c7a|\u89e3\u6c7a\u4e86|\u53ef\u4ee5\u7d50\u6848|\u4e0d\u7528\u4e86|\u4e0d\u9700\u8981\u4e86|\u5148\u9019\u6a23|\u8b1d\u8b1d|thanks|thankyou)$/u.test(normalized);
}

function closureConfirmationIsCurrent(expiresAt, timestamp) {
  const expiration = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
  return !Number.isNaN(expiration.getTime()) && expiration.getTime() > timestamp.getTime();
}
