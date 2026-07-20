import { NextResponse } from "next/server";
import { start } from "workflow/api";

import { createDbClient } from "../../../../../lib/db/index.js";
import { createLineSupportAdapter } from "../../../../../lib/support/channel-adapters/line-support-adapter.js";
import { createSupportRepository } from "../../../../../lib/support/support-repository.js";
import { createLineWebhookHandler } from "../../../../../lib/support/routes/line-webhook-handler.js";

export async function POST(request, { params }) {
  try {
    const { webhookKey } = await params;
    return await createHandler()(request, webhookKey);
  } catch {
    return NextResponse.json(
      { error: "Webhook ingestion is temporarily unavailable." },
      { status: 503 },
    );
  }
}

function createHandler(env = process.env) {
  const repository = createSupportRepository(createDbClient(env), {
    encryptionKey: env.SETTINGS_ENCRYPTION_KEY,
  });
  return createLineWebhookHandler({
    findConnection: (webhookKeyHash) => repository.findActiveLineConnectionByWebhookKeyHash(webhookKeyHash),
    lineAdapter: createLineSupportAdapter(),
    eventStore: {
      ingestUserEvent: (input) => repository.ingestLineUserEvent(input),
      recordIgnoredEvent: (input) => repository.recordIgnoredLineEvent(input),
      claimWorkflowDispatch: (input) => repository.claimLineWorkflowDispatch(input),
      markWorkflowDispatched: (input) => repository.markLineWorkflowDispatched(input),
      releaseWorkflowDispatch: (input) => repository.releaseLineWorkflowDispatch(input),
    },
    startWorkflow: startLineMessageWorkflow,
    respond: (body, init) => NextResponse.json(body, init),
  });
}

async function startLineMessageWorkflow(input) {
  const workflowName = "line-message-workflow";
  const { lineMessageWorkflow } = await import(
    `../../../../../lib/support/workflows/${workflowName}.js`
  );
  return start(lineMessageWorkflow, [input]);
}
