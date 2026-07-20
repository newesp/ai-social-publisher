import { sleep } from "workflow";

export async function supportTransitionWorkflow({ transitionId, conversationId }) {
  "use workflow";
  await sleep("10s");
  return commitTransitionStep({ transitionId, conversationId });
}

export function createSupportTransitionWorkflow({ sleepImpl = sleep, transitionService } = {}) {
  return async function testableSupportTransitionWorkflow({ transitionId, conversationId }) {
    "use workflow";
    await sleepImpl("10s");
    return commitTransitionStep({ transitionId, conversationId }, transitionService);
  };
}

async function commitTransitionStep(input, transitionService) {
  "use step";
  return (transitionService ?? await getSupportTransitionService()).commitIfCurrent(input);
}

export async function getSupportTransitionService(env = process.env) {
  const [{ createDbClient }, { createSupportRepository }] = await Promise.all([
    import("../../db/index.js"),
    import("../support-repository.js"),
  ]);
  const repository = createSupportRepository(createDbClient(env), { encryptionKey: env.SETTINGS_ENCRYPTION_KEY });
  return { commitIfCurrent: (input) => repository.commitSupportTransition(input) };
}
