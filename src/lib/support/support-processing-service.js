import { retrieveFaqs } from "./knowledge/faq-retrieval.js";

const MAX_AI_TURNS_PER_WINDOW = 10;
const MAX_DECISION_ATTEMPTS = 3;

export function createSupportProcessingService({ repository, decisionService, deliveryService } = {}) {
  return {
    async acquireClaim(input) {
      return repository.acquireConversationClaim(input);
    },

    async buildTurn(input) {
      return repository.buildClaimedTurn(input);
    },

    async renewClaim(input) {
      const renewed = await repository.renewConversationClaim(input);
      if (renewed !== true) throw new Error("Conversation processing claim was lost.");
      return true;
    },

    async decideAndPersist(input) {
      const context = await repository.loadCurrentProcessingContext(input);
      const failClosedReason = stateFailure(context);
      if (failClosedReason) return persistHandoff(repository, input, failClosedReason);
      if (Number(context.aiTurnsInLastFiveMinutes) >= MAX_AI_TURNS_PER_WINDOW) {
        return persistHandoff(repository, input, "rate_limit");
      }
      if (!context.configuration || !context.settings || !context.recipient) {
        return persistHandoff(repository, input, "configuration_unready");
      }

      const faqs = retrieveFaqs({
        query: input.customerTexts?.join("\n") ?? "",
        faqs: context.faqs,
      });
      let decision;
      try {
        decision = await decideWithRetry(decisionService, {
          configuration: context.configuration,
          settings: context.settings,
          messages: context.messages,
          faqs,
        });
      } catch (error) {
        return persistHandoff(repository, input, error?.retryable ? "provider_unavailable" : "invalid_ai_decision");
      }
      if (!decision || decision.action !== "reply") {
        return persistHandoff(repository, input, decision?.handoffReasonCode ?? "invalid_ai_decision");
      }

      const canonicalBody = JSON.stringify({
        to: context.recipient,
        messages: [{ type: "text", text: decision.answer }],
      });
      const persisted = await repository.persistDecisionAndOutbound({
        ...input,
        decision,
        canonicalBody,
        now: input.now,
      });
      return { status: "pending_delivery", deliveryId: persisted.deliveryId };
    },

    async deliver({ deliveryId, now = new Date() }) {
      return deliveryService.attemptDelivery({ deliveryId, now });
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

    async resolveBatchedEvents(input) {
      return repository.resolveProcessedCompetingEvents(input);
    },
  };
}

async function decideWithRetry(decisionService, input) {
  for (let attempt = 0; attempt < MAX_DECISION_ATTEMPTS; attempt += 1) {
    try {
      return await decisionService.decide(input);
    } catch (error) {
      if (error?.retryable !== true || attempt === MAX_DECISION_ATTEMPTS - 1) throw error;
    }
  }
  throw new Error("Decision attempts exhausted.");
}

function stateFailure(context) {
  if (!context || context.supportState !== "enabled") return "support_disabled";
  if (context.conversationStatus !== "ai_active") return "human_controlled";
  return null;
}

async function persistHandoff(repository, input, reasonCode) {
  await repository.persistHandoff({
    eventId: input.eventId,
    connectionId: input.connectionId,
    conversationId: input.conversationId,
    claimId: input.claimId,
    inboundMessageId: input.inboundMessageId,
    reasonCode,
    now: input.now,
  });
  return { status: "waiting_human", handoffReasonCode: reasonCode };
}
