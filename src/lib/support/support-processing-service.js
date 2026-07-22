import { retrieveRagKnowledge } from "./knowledge/rag-retrieval.js";

const MAX_AI_TURNS_PER_WINDOW = 10;

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

      const sources = retrieveRagKnowledge({
        query: context.customerTexts?.join("\n") ?? "",
        knowledge: context.faqs,
      });

      let decision;
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
