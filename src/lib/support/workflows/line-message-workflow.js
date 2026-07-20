import { createDbClient } from "../../db/index.js";
import { createSupportRepository } from "../support-repository.js";

// Task 5 prerequisite: Task 7 supplies the actual side-effecting processing hook.
export async function lineMessageWorkflow(input) {
  "use workflow";
  return claimInboundEventProcessing(input, {
    eventStore: productionEventStore(),
    processEvent: async () => {},
  });
}

export function createLineMessageWorkflow({ eventStore, processEvent = async () => {} }) {
  return async function testableLineMessageWorkflow(input) {
    "use workflow";
    return claimInboundEventProcessing(input, { eventStore, processEvent });
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
    await eventStore.releaseEventProcessing({
      eventId,
      connectionId,
      claimId: claim.claimId,
    });
    throw error;
  }
  const completed = await eventStore.markEventProcessed({
    eventId,
    connectionId,
    claimId: claim.claimId,
  });
  if (completed !== true) throw new Error("Event processing completion could not be recorded.");
  return { status: "processed" };
}

function productionEventStore(env = process.env) {
  const repository = createSupportRepository(createDbClient(env), {
    encryptionKey: env.SETTINGS_ENCRYPTION_KEY,
  });
  return {
    claimEventProcessing: (input) => repository.claimLineEventProcessing(input),
    markEventProcessed: (input) => repository.markLineEventProcessed(input),
    releaseEventProcessing: (input) => repository.releaseLineEventProcessing(input),
  };
}
