import { sleep } from "workflow";
import { commitSupportTransitionStep } from "./support-transition-workflow-steps.js";

export async function supportTransitionWorkflow({ transitionId, conversationId }) {
  "use workflow";
  await sleep("10s");
  return commitSupportTransitionStep({ transitionId, conversationId });
}

export function createSupportTransitionWorkflow({ sleepImpl = sleep, transitionService } = {}) {
  return async function testableSupportTransitionWorkflow({ transitionId, conversationId }) {
    "use workflow";
    await sleepImpl("10s");
    return commitSupportTransitionStep({ transitionId, conversationId }, transitionService);
  };
}
