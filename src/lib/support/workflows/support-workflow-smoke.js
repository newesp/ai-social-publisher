export async function supportWorkflowSmoke({ requestId }) {
  "use workflow";
  return runSmokeStep(requestId);
}

async function runSmokeStep(requestId) {
  "use step";
  return { requestId, status: "ok" };
}
