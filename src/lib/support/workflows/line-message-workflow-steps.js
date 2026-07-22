import { createDbClient } from "../../db/index.js";
import { generateText } from "../../ai/llm-service.js";
import { createLineSupportAdapter } from "../channel-adapters/line-support-adapter.js";
import { createSupportDecisionService } from "../decisions/support-decision-service.js";
import { createLineOutboundDeliveryService } from "../outbox/line-outbound-delivery-service.js";
import { createSupportProcessingService } from "../support-processing-service.js";
import { createSupportRepository } from "../support-repository.js";

export async function claimEventStep(eventStore, input) {
  "use step";
  return resolveEventStore(eventStore).claimEventProcessing(input);
}

export async function acquireConversationClaimStep(processingService, input) {
  "use step";
  return resolveProcessingService(processingService).acquireClaim(input);
}

export async function resolveCompetingEventStep(processingService, input) {
  "use step";
  const service = resolveProcessingService(processingService);
  return typeof service.resolveCompetingEvent === "function" && service.resolveCompetingEvent(input);
}

export async function releaseEventStep(eventStore, input) {
  "use step";
  return resolveEventStore(eventStore).releaseEventProcessing(input);
}

export async function recoverDeliveryStep(processingService, input) {
  "use step";
  const service = resolveProcessingService(processingService);
  return typeof service.recoverDelivery === "function" ? service.recoverDelivery(input) : null;
}

export async function buildTurnStep(processingService, input) {
  "use step";
  return resolveProcessingService(processingService).buildTurn(input);
}

export async function providerAttemptStep(processingService, input) {
  "use step";
  return resolveProcessingService(processingService).decideAndPersist(input);
}

export async function persistHandoffStep(processingService, input) {
  "use step";
  return resolveProcessingService(processingService).persistHandoff(input);
}

export async function deliverStep(processingService, input) {
  "use step";
  return resolveProcessingService(processingService).deliver(input);
}

export async function finalizeHandoffStep(processingService, input) {
  "use step";
  return resolveProcessingService(processingService).finalizeHandoff(input);
}

export async function releaseConversationClaimStep(processingService, input) {
  "use step";
  return resolveProcessingService(processingService).releaseClaim(input);
}

export async function findFollowUpStep(processingService, input) {
  "use step";
  return resolveProcessingService(processingService).findFollowUp(input);
}

export async function completeEvent(eventStore, input) {
  "use step";
  const completed = await resolveEventStore(eventStore).markEventProcessed(input);
  if (completed !== true) throw new Error("Event processing completion could not be recorded.");
}

export async function renewFences({
  eventStore, processingService, eventId, connectionId, conversationId, eventClaimId, conversationClaimId, now,
}) {
  "use step";
  const activeEventStore = resolveEventStore(eventStore);
  const activeProcessingService = resolveProcessingService(processingService);
  if (typeof activeEventStore.renewEventProcessing === "function") {
    const renewed = await activeEventStore.renewEventProcessing({ eventId, connectionId, claimId: eventClaimId, now });
    if (renewed !== true) throw new Error("Event processing claim was lost.");
  }
  if (typeof activeProcessingService.renewClaim === "function") {
    await activeProcessingService.renewClaim({
      eventId,
      eventClaimId,
      connectionId,
      conversationId,
      claimId: conversationClaimId,
      now,
    });
  }
}

function resolveEventStore(eventStore) {
  if (eventStore) return eventStore;
  const repository = createProductionRepository();
  return {
    claimEventProcessing: (input) => repository.claimLineEventProcessing(input),
    renewEventProcessing: (input) => repository.renewLineEventProcessing(input),
    markEventProcessed: (input) => repository.markLineEventProcessed(input),
    releaseEventProcessing: (input) => repository.releaseLineEventProcessing(input),
  };
}

function resolveProcessingService(processingService) {
  if (processingService) return processingService;
  const repository = createProductionRepository();
  const adapter = createLineSupportAdapter();
  const deliveryService = createLineOutboundDeliveryService({
    outboxStore: {
      claimDelivery: (input) => repository.claimLineOutboundDelivery(input),
      markDeliverySent: (input) => repository.markLineOutboundDeliverySent(input),
      markDeliveryRetryable: (input) => repository.markLineOutboundDeliveryRetryable(input),
      markDeliveryFailed: (input) => repository.markLineOutboundDeliveryFailed(input),
      getDeliveryStatus: (deliveryId) => repository.getLineOutboundDeliveryStatus(deliveryId),
    },
    sendPush: async ({ retryKey, body, connectionId }) => {
      const accessToken = await repository.loadLineAccessToken(connectionId);
      return adapter.pushCanonical({ accessToken, canonicalBody: body, retryKey });
    },
    onCredentialRejected: (input) => repository.handleLineCredentialRejected(input),
    now: () => new Date(),
  });
  return createSupportProcessingService({
    repository,
    decisionService: createSupportDecisionService({ generateTextImpl: generateText }),
    deliveryService,
  });
}

function createProductionRepository(env = process.env) {
  return createSupportRepository(createDbClient(env), { encryptionKey: env.SETTINGS_ENCRYPTION_KEY });
}
