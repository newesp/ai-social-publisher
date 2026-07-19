import { supportWorkflowSmoke } from "../workflows/support-workflow-smoke.js";

export function createSupportWorkflowSmokeHandler({ requireOwner, requireSameOrigin, startWorkflow, enabled }) {
  return async function supportWorkflowSmokeHandler(request) {
    if (enabled !== true) return Response.json({ error: "Not found." }, { status: 404 });

    await requireOwner();
    requireSameOrigin(request);
    const requestId = crypto.randomUUID();
    await startWorkflow(supportWorkflowSmoke, [{ requestId }]);
    return Response.json({ requestId, status: "started" }, { status: 202 });
  };
}
