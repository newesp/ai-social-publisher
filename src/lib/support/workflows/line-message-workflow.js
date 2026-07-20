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
  return runLineMessageWorkflow(input, {});
}

export function createLineMessageWorkflow({ eventStore, processingService, sleepImpl = sleep, startWorkflow, processEvent, now = () => new Date() } = {}) {
  if (!processingService && typeof processEvent === "function") {
    return async function legacyTestableLineMessageWorkflow(input) {
      "use workflow";
      return claimInboundEventProcessing(input, { eventStore, processEvent });
    };
  }
  return async function testableLineMessageWorkflow(input) {
    "use workflow";
    return runLineMessageWorkflow(input, { eventStore, processingService, sleepImpl, startWorkflow, now });
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
  now = () => new Date(),
}) {
  sleepImpl ??= sleep;
  const claimedAt = await workflowNowStep(now);
  const eventClaim = await claimEventStep(eventStore, { eventId, connectionId, now: claimedAt });
  if (eventClaim?.claimed !== true) return { status: "duplicate" };

  let conversationClaim;
  try {
    conversationClaim = await acquireConversationClaimStep(processingService, { eventId, connectionId, conversationId, now: claimedAt });
    if (conversationClaim?.acquired !== true) {
      const resolved = await resolveCompetingEventStep(processingService, {
        eventId, connectionId, conversationId, claimId: eventClaim.claimId, now: await workflowNowStep(now),
      });
      if (!resolved) await releaseEventStep(eventStore, { eventId, connectionId, claimId: eventClaim.claimId });
      return { status: "already_processing" };
    }
    const windowStart = validDate(conversationClaim.windowStart);
    const batchCutoff = new Date(windowStart.getTime() + 3_000);
    await sleepImpl("3s");
    let operationNow = await workflowNowStep(now);
    await renewFences({ eventStore, processingService, eventId, connectionId, conversationId, eventClaimId: eventClaim.claimId, conversationClaimId: conversationClaim.claimId, now: operationNow });
    const turn = await buildTurnStep(processingService, {
      eventId,
      connectionId,
      conversationId,
      claimId: conversationClaim.claimId,
      cutoff: batchCutoff,
    });
    if (!turn) {
      await completeEvent(eventStore, {
        eventId, connectionId, claimId: eventClaim.claimId, conversationId,
        conversationClaimId: conversationClaim.claimId, now: operationNow,
      });
      return { status: "no_messages" };
    }
    operationNow = await workflowNowStep(now);
    await renewFences({ eventStore, processingService, eventId, connectionId, conversationId, eventClaimId: eventClaim.claimId, conversationClaimId: conversationClaim.claimId, now: operationNow });
    let outcome;
    for (let providerAttempt = 0; providerAttempt < 3; providerAttempt += 1) {
      operationNow = await workflowNowStep(now);
      await renewFences({ eventStore, processingService, eventId, connectionId, conversationId, eventClaimId: eventClaim.claimId, conversationClaimId: conversationClaim.claimId, now: operationNow });
      outcome = await providerAttemptStep(processingService, {
        eventId, connectionId, conversationId, claimId: conversationClaim.claimId, eventClaimId: eventClaim.claimId,
        cutoff: batchCutoff, inboundMessageId: turn.inboundMessageId, now: operationNow,
      });
      if (outcome.status !== "retryable_provider") break;
    }
    if (outcome?.status === "retryable_provider") {
      const handoffNow = await workflowNowStep(now);
      await renewFences({ eventStore, processingService, eventId, connectionId, conversationId, eventClaimId: eventClaim.claimId, conversationClaimId: conversationClaim.claimId, now: handoffNow });
      outcome = await persistHandoffStep(processingService, {
        eventId, connectionId, conversationId, claimId: conversationClaim.claimId, eventClaimId: eventClaim.claimId,
        inboundMessageId: turn.inboundMessageId, cutoff: batchCutoff,
        reasonCode: "provider_unavailable", now: handoffNow,
      });
    }
    if (outcome.deliveryId) {
      let delivery;
      do {
        const deliveryNow = await workflowNowStep(now);
        await renewFences({ eventStore, processingService, eventId, connectionId, conversationId, eventClaimId: eventClaim.claimId, conversationClaimId: conversationClaim.claimId, now: deliveryNow });
        delivery = await deliverStep(processingService, {
          deliveryId: outcome.deliveryId, eventId, eventClaimId: eventClaim.claimId,
          connectionId, conversationId, conversationClaimId: conversationClaim.claimId, now: deliveryNow,
        });
        if (delivery.status === "retryable" && delivery.retryAt) {
          const retryAt = validDate(delivery.retryAt);
          await sleepWithRenewedFences({
            from: deliveryNow, to: retryAt, sleepImpl, eventStore, processingService,
            eventId, connectionId, conversationId, eventClaimId: eventClaim.claimId,
            conversationClaimId: conversationClaim.claimId, now,
          });
        }
      } while (delivery.status === "retryable" && delivery.retryAt);
      if (delivery.eventCompleted) return { status: delivery.status };
      const completionNow = await workflowNowStep(now);
      await renewFences({ eventStore, processingService, eventId, connectionId, conversationId, eventClaimId: eventClaim.claimId, conversationClaimId: conversationClaim.claimId, now: completionNow });
      await completeEvent(eventStore, { eventId, connectionId, claimId: eventClaim.claimId, conversationId, conversationClaimId: conversationClaim.claimId, now: completionNow });
      return { status: delivery.status };
    }
    if (outcome.eventCompleted) return { status: outcome.status };
    const completionNow = await workflowNowStep(now);
    await renewFences({ eventStore, processingService, eventId, connectionId, conversationId, eventClaimId: eventClaim.claimId, conversationClaimId: conversationClaim.claimId, now: completionNow });
    await completeEvent(eventStore, { eventId, connectionId, claimId: eventClaim.claimId, conversationId, conversationClaimId: conversationClaim.claimId, now: completionNow });
    return { status: outcome.status };
  } catch (error) {
    await releaseEventStep(eventStore, { eventId, connectionId, claimId: eventClaim.claimId });
    throw error;
  } finally {
    if (conversationClaim?.acquired === true) {
      await releaseConversationClaimStep(processingService, { connectionId, conversationId, claimId: conversationClaim.claimId });
      const followUp = await findFollowUpStep(processingService, { connectionId, conversationId });
      if (followUp) await startFollowUpStep(startWorkflow, followUp);
    }
  }
}

function productionEventStore(env = process.env) {
  const repository = createSupportRepository(createDbClient(env), { encryptionKey: env.SETTINGS_ENCRYPTION_KEY });
  return {
    claimEventProcessing: (input) => repository.claimLineEventProcessing(input),
    renewEventProcessing: (input) => repository.renewLineEventProcessing(input),
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
    onCredentialRejected: (input) => repository.handleLineCredentialRejected(input),
    now: () => new Date(),
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

async function completeEvent(eventStore, input) {
  "use step";
  const completed = await currentEventStore(eventStore).markEventProcessed(input);
  if (completed !== true) throw new Error("Event processing completion could not be recorded.");
}

async function renewFences({
  eventStore, processingService, eventId, connectionId, conversationId, eventClaimId, conversationClaimId, now,
}) {
  "use step";
  const activeEventStore = currentEventStore(eventStore);
  const activeProcessingService = currentProcessingService(processingService);
  if (typeof activeEventStore.renewEventProcessing === "function") {
    const renewed = await activeEventStore.renewEventProcessing({ eventId, connectionId, claimId: eventClaimId, now });
    if (renewed !== true) throw new Error("Event processing claim was lost.");
  }
  if (typeof activeProcessingService.renewClaim === "function") {
    await activeProcessingService.renewClaim({ eventId, connectionId, conversationId, claimId: conversationClaimId, now });
  }
}

async function sleepWithRenewedFences({
  from, to, sleepImpl, eventStore, processingService, eventId, connectionId, conversationId, eventClaimId, conversationClaimId, now,
}) {
  "use workflow";
  let cursor = from;
  while (cursor < to) {
    const next = new Date(Math.min(to.getTime(), cursor.getTime() + 25_000));
    await sleepImpl(durationUntil(cursor, next));
    cursor = next;
    await renewFences({
      eventStore, processingService, eventId, connectionId, conversationId, eventClaimId, conversationClaimId,
      now: await workflowNowStep(now),
    });
  }
}

function currentDate(now) {
  return validDate(now());
}

async function workflowNowStep(now) {
  "use step";
  return currentDate(now);
}

async function claimEventStep(eventStore, input) { "use step"; return currentEventStore(eventStore).claimEventProcessing(input); }
async function acquireConversationClaimStep(processingService, input) { "use step"; return currentProcessingService(processingService).acquireClaim(input); }
async function resolveCompetingEventStep(processingService, input) { "use step"; const service = currentProcessingService(processingService); return typeof service.resolveCompetingEvent === "function" && service.resolveCompetingEvent(input); }
async function releaseEventStep(eventStore, input) { "use step"; return currentEventStore(eventStore).releaseEventProcessing(input); }
async function buildTurnStep(processingService, input) { "use step"; return currentProcessingService(processingService).buildTurn(input); }
async function providerAttemptStep(processingService, input) { "use step"; return currentProcessingService(processingService).decideAndPersist(input); }
async function persistHandoffStep(processingService, input) { "use step"; return currentProcessingService(processingService).persistHandoff(input); }
async function deliverStep(processingService, input) { "use step"; return currentProcessingService(processingService).deliver(input); }
async function releaseConversationClaimStep(processingService, input) { "use step"; return currentProcessingService(processingService).releaseClaim(input); }
async function findFollowUpStep(processingService, input) { "use step"; return currentProcessingService(processingService).findFollowUp(input); }
async function startFollowUpStep(startWorkflow, input) { "use step"; return typeof startWorkflow === "function" ? startWorkflow(input) : startNextLineMessageWorkflow(input); }

function currentEventStore(eventStore) {
  return eventStore ?? productionEventStore();
}

function currentProcessingService(processingService) {
  return processingService ?? productionProcessingService();
}
