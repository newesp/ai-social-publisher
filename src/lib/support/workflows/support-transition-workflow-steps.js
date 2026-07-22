import { createDbClient } from "../../db/index.js";
import { createSupportRepository } from "../support-repository.js";

export async function commitSupportTransitionStep(input, transitionService) {
  "use step";
  return (transitionService ?? productionTransitionService()).commitIfCurrent(input);
}

function productionTransitionService(env = process.env) {
  const repository = createSupportRepository(createDbClient(env), { encryptionKey: env.SETTINGS_ENCRYPTION_KEY });
  return { commitIfCurrent: (input) => repository.commitSupportTransition(input) };
}
