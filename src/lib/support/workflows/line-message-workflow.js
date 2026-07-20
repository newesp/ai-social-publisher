import { sleep } from "workflow";
import { start } from "workflow/api";

import { createDbClient } from "../../db/index.js";
import { generateText } from "../../ai/llm-service.js";
import { createLineSupportAdapter } from "../channel-adapters/line-support-adapter.js";
import { createSupportDecisionService } from "../decisions/support-decision-service.js";
import { createLineOutboundDeliveryService } from "../outbox/line-outbound-delivery-service.js";
import { createSupportProcessingService } from "../support-processing-service.js";
import { createSupportRepository } from "../support-repository.js";

export async function lineMessageWorkflow(input) {
  "use workflow";
  return runLineMessageWorkflow(input, {
    eventStore: productionEventStore(),
    processingService: productionProcessingService(),
    sleepImpl: sleep,
    startWorkflow: startNextLineMessageWorkflow,
  });
}

export function createLineMessageWorkflow({ eventStore, processingService, sleepImpl = sleep, startWorkflow, processEvent } = {}) {
  if (!processingService && typeof processEvent === "function") {
    return async function legacyTestableLineMessageWorkflow(input) {
      "use workflow";
      return claimInboundEventProcessing(input, { eventStore, processEvent });
    };
  }
  return async function testableLineMessageWorkflow(input) {
    "use workflow";
    return runLineMessageWorkflow(input, { eventStore, processingService, sleepImpl, startWorkflow });
  };
}

async function claimInboundEventProcessing({ eventId, connectionId, conversationId }, { eventStore, processEvent }) {
  "use step";
  const claim = await eventStore.claimEventProcessing({ eventId, connectionId });
  if (claim?.claimed !== true) return { status: "duplicate" };
  const input = { eventId, connectionId, conversationId };
  try {
    await processEvent(input);
  } catch (error) {
    await eventStore.releaseEventProcessing({ eventId, connectionId, claimId: claim.claimId });
    throw error;
  }
  const completed = await eventStore.markEventProcessed({ eventId, connectionId, claimId: claim.claimId });
  if (completed !== true) throw new Error("Event processing completion could not be recorded.");
  return { status: "processed" };
}

async function runLineMessageWorkflow({ eventId, connectionId, conversationId }, {
  eventStore,
  processingService,
  sleepImpl,
  startWorkflow,
}) {
  "use step";
  const eventClaim = await eventStore.claimEventProcessing({ eventId, connectionId });
  if (eventClaim?.claimed !== true) return { status: "duplicate" };

  let conversationClaim;
  try {
    conversationClaim = await processingService.acquireClaim({ eventId, connectionId, conversationId, now: new Date() });
    if (conversationClaim?.acquired !== true) {
      await eventStore.releaseEventProcessing({ eventId, connectionId, claimId: eventClaim.claimId });
      return { status: "already_processing" };
    }
    const windowStart = validDate(conversationClaim.windowStart);
    await sleepImpl("3s");
    const now = windowStart;
    const turn = await processingService.buildTurn({
      eventId,
      connectionId,
      conversationId,
      claimId: conversationClaim.claimId,
      cutoff: new Date(windowStart.getTime() + 3_000),
    });
    if (!turn) {
      await eventStore.markEventProcessed({ eventId, connectionId, claimId: eventClaim.claimId });
      return { status: "no_messages" };
    }
    const outcome = await processingService.decideAndPersist({
      eventId,
      connectionId,
      conversationId,
      claimId: conversationClaim.claimId,
      eventClaimId: eventClaim.claimId,
      ...turn,
      now,
    });
    if (outcome.deliveryId) {
      let deliveryNow = now;
      let delivery;
      do {
        delivery = await processingService.deliver({ deliveryId: outcome.deliveryId, now: deliveryNow });
        if (delivery.status === "retryable" && delivery.retryAt) {
          const retryAt = validDate(delivery.retryAt);
          await sleepImpl(durationUntil(deliveryNow, retryAt));
          deliveryNow = retryAt;
        }
      } while (delivery.status === "retryable" && delivery.retryAt);
      await eventStore.markEventProcessed({ eventId, connectionId, claimId: eventClaim.claimId });
      return { status: delivery.status };
    }
    await eventStore.markEventProcessed({ eventId, connectionId, claimId: eventClaim.claimId });
    return { status: outcome.status };
  } catch (error) {
    await eventStore.releaseEventProcessing({ eventId, connectionId, claimId: eventClaim.claimId });
    throw error;
  } finally {
    if (conversationClaim?.acquired === true) {
      await processingService.releaseClaim({ connectionId, conversationId, claimId: conversationClaim.claimId });
      const followUp = await processingService.findFollowUp({ connectionId, conversationId });
      if (followUp && typeof startWorkflow === "function") await startWorkflow(followUp);
    }
  }
}

function productionEventStore(env = process.env) {
  const repository = createSupportRepository(createDbClient(env), { encryptionKey: env.SETTINGS_ENCRYPTION_KEY });
  return {
    claimEventProcessing: (input) => repository.claimLineEventProcessing(input),
    markEventProcessed: (input) => repository.markLineEventProcessed(input),
    releaseEventProcessing: (input) => repository.releaseLineEventProcessing(input),
  };
}

function productionProcessingService(env = process.env) {
  const repository = createSupportRepository(createDbClient(env), { encryptionKey: env.SETTINGS_ENCRYPTION_KEY });
  const adapter = createLineSupportAdapter();
  const deliveryService = createLineOutboundDeliveryService({
    outboxStore: {
      claimDelivery: (input) => repository.claimLineOutboundDelivery(input),
      markDeliverySent: (input) => repository.markLineOutboundDeliverySent(input),
      markDeliveryRetryable: (input) => repository.markLineOutboundDeliveryRetryable(input),
      markDeliveryFailed: (input) => repository.markLineOutboundDeliveryFailed(input),
    },
    sendPush: async ({ retryKey, body, connectionId }) => {
      const accessToken = await repository.loadLineAccessToken(connectionId);
      return adapter.pushCanonical({ accessToken, canonicalBody: body, retryKey });
    },
    onCredentialRejected: ({ connectionId, now }) => repository.markLineConnectionNeedsReconnect(connectionId, now),
  });
  return createSupportProcessingService({
    repository,
    decisionService: createSupportDecisionService({ generateTextImpl: generateText }),
    deliveryService,
  });
}

function startNextLineMessageWorkflow(input) {
  return start(lineMessageWorkflow, [input]);
}

function validDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("Workflow claim did not include a valid window start.");
  return date;
}

function durationUntil(from, to) {
  const milliseconds = to.getTime() - from.getTime();
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1) throw new Error("Outbound retry time must be in the future.");
  return milliseconds % 1_000 === 0 ? `${milliseconds / 1_000}s` : `${milliseconds}ms`;
}
