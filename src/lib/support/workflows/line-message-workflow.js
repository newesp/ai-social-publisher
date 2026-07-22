import { sleep } from "workflow";
import { start } from "workflow/api";
import {
  acquireConversationClaimStep,
  buildTurnStep,
  claimEventStep,
  completeEvent,
  deliverStep,
  finalizeHandoffStep,
  findFollowUpStep,
  persistHandoffStep,
  providerAttemptStep,
  recoverDeliveryStep,
  releaseConversationClaimStep,
  releaseEventStep,
  renewFences,
  resolveCompetingEventStep,
} from "./line-message-workflow-steps.js";

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
  now,
}) {
  sleepImpl ??= sleep;
  const claimedAt = await workflowNow(now);
  const eventClaim = await claimEventStep(eventStore, { eventId, connectionId, now: claimedAt });
  if (eventClaim?.claimed !== true) return { status: "duplicate" };

  let conversationClaim;
  try {
    conversationClaim = await acquireConversationClaimStep(processingService, {
      eventId, eventClaimId: eventClaim.claimId, connectionId, conversationId, now: claimedAt,
    });
    if (conversationClaim?.acquired !== true) {
      const resolved = await resolveCompetingEventStep(processingService, {
        eventId, connectionId, conversationId, claimId: eventClaim.claimId, now: await workflowNow(now),
      });
      if (!resolved) await releaseEventStep(eventStore, { eventId, connectionId, claimId: eventClaim.claimId });
      return { status: "already_processing" };
    }
    const windowStart = validDate(conversationClaim.windowStart);
    const batchCutoff = new Date(windowStart.getTime() + 3_000);
    await sleepImpl("3s");
    let operationNow = await workflowNow(now);
    await renewFences({ eventStore, processingService, eventId, connectionId, conversationId, eventClaimId: eventClaim.claimId, conversationClaimId: conversationClaim.claimId, now: operationNow });
    let outcome = await recoverDeliveryStep(processingService, {
      eventId,
      eventClaimId: eventClaim.claimId,
      connectionId,
      conversationId,
      conversationClaimId: conversationClaim.claimId,
      now: operationNow,
    });
    if (!outcome) {
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
      operationNow = await workflowNow(now);
      await renewFences({ eventStore, processingService, eventId, connectionId, conversationId, eventClaimId: eventClaim.claimId, conversationClaimId: conversationClaim.claimId, now: operationNow });
      for (let providerAttempt = 0; providerAttempt < 3; providerAttempt += 1) {
        operationNow = await workflowNow(now);
        await renewFences({ eventStore, processingService, eventId, connectionId, conversationId, eventClaimId: eventClaim.claimId, conversationClaimId: conversationClaim.claimId, now: operationNow });
        outcome = await providerAttemptStep(processingService, {
          eventId, connectionId, conversationId, claimId: conversationClaim.claimId, eventClaimId: eventClaim.claimId,
          cutoff: batchCutoff, inboundMessageId: turn.inboundMessageId, handoffReasonCode: turn.handoffReasonCode, now: operationNow,
        });
        if (outcome.status !== "retryable_provider") break;
      }
      if (outcome?.status === "retryable_provider") {
        const handoffNow = await workflowNow(now);
        await renewFences({ eventStore, processingService, eventId, connectionId, conversationId, eventClaimId: eventClaim.claimId, conversationClaimId: conversationClaim.claimId, now: handoffNow });
        outcome = await persistHandoffStep(processingService, {
          eventId, connectionId, conversationId, claimId: conversationClaim.claimId, eventClaimId: eventClaim.claimId,
          inboundMessageId: turn.inboundMessageId, cutoff: batchCutoff,
          reasonCode: "provider_unavailable", now: handoffNow,
        });
      }
    }
    if (outcome.deliveryId) {
      let delivery;
      do {
        const deliveryNow = await workflowNow(now);
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
      if (!["sent", "failed", "human_review"].includes(delivery.status)) {
        throw new Error("Outbound delivery did not reach a terminal state.");
      }
      if (outcome.handoffAcknowledgement === true) {
        const completionNow = await workflowNow(now);
        const finalized = await finalizeHandoffStep(processingService, {
          deliveryId: outcome.deliveryId, eventId, eventClaimId: eventClaim.claimId,
          connectionId, conversationId, conversationClaimId: conversationClaim.claimId, now: completionNow,
        });
        if (finalized !== true) throw new Error("Handoff acknowledgement finalization could not be recorded.");
        return { status: delivery.status };
      }
      const completionNow = await workflowNow(now);
      await renewFences({ eventStore, processingService, eventId, connectionId, conversationId, eventClaimId: eventClaim.claimId, conversationClaimId: conversationClaim.claimId, now: completionNow });
      await completeEvent(eventStore, { eventId, connectionId, claimId: eventClaim.claimId, conversationId, conversationClaimId: conversationClaim.claimId, now: completionNow });
      return { status: delivery.status };
    }
    if (outcome.eventCompleted) return { status: outcome.status };
    const completionNow = await workflowNow(now);
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
      now: await workflowNow(now),
    });
  }
}

function currentDate(now) {
  return validDate(now());
}

async function workflowNow(now) {
  return now ? workflowTestNowStep(currentDate(now)) : workflowNowStep();
}

async function workflowNowStep() {
  "use step";
  return new Date();
}

async function workflowTestNowStep(value) {
  "use step";
  return validDate(value);
}

async function startFollowUpStep(startWorkflow, input) { "use step"; return typeof startWorkflow === "function" ? startWorkflow(input) : startNextLineMessageWorkflow(input); }
