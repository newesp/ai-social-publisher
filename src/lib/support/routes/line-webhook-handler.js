import { hashWebhookKey } from "../identity-crypto.js";

const RESPONSES = Object.freeze({
  accepted: { ok: true },
  notFound: { error: "Webhook endpoint was not found." },
  unauthorized: { error: "Webhook signature was not accepted." },
  malformed: { error: "Webhook payload was invalid." },
  tooLarge: { error: "Webhook payload was too large." },
  unavailable: { error: "Webhook ingestion is temporarily unavailable." },
});
const MAX_BODY_BYTES = 1_000_000;
const MAX_EVENTS = 100;

export function createLineWebhookHandler({
  findConnection,
  lineAdapter,
  eventStore,
  startWorkflow,
  respond = (body, init) => Response.json(body, init),
}) {
  return async function lineWebhookHandler(request, webhookKey) {
    let connection;
    try {
      connection = await findConnection(hashWebhookKey(webhookKey));
    } catch {
      return safeResponse(respond, RESPONSES.unavailable, 503);
    }
    if (!connection || !validConnection(connection)) {
      return safeResponse(respond, RESPONSES.notFound, 404);
    }

    const contentLength = Number(request.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
      return safeResponse(respond, RESPONSES.tooLarge, 413);
    }

    let rawBody;
    try {
      rawBody = await readBodyWithinLimit(request);
    } catch (error) {
      if (error instanceof RangeError) return safeResponse(respond, RESPONSES.tooLarge, 413);
      return safeResponse(respond, RESPONSES.malformed, 400);
    }
    if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) {
      return safeResponse(respond, RESPONSES.tooLarge, 413);
    }
    if (!lineAdapter?.verifySignature?.({
      channelSecret: connection.channelSecret,
      rawBody,
      signature: request.headers.get("x-line-signature"),
    })) {
      return safeResponse(respond, RESPONSES.unauthorized, 401);
    }

    let events;
    try {
      const payload = JSON.parse(rawBody);
      events = parseEvents(payload);
    } catch {
      return safeResponse(respond, RESPONSES.malformed, 400);
    }
    if (events.length === 0) return safeResponse(respond, RESPONSES.accepted, 200);

    try {
      for (const event of events) {
        if (event.sourceType === "group" || event.sourceType === "room" || event.sourceType === "user_event") {
          await eventStore.recordIgnoredEvent({
            connectionId: connection.id,
            eventId: event.eventId,
            sourceType: event.sourceType,
          });
          continue;
        }
        const customerDisplayName = await loadCustomerDisplayName(lineAdapter, connection, event.externalUserId);
        const result = await eventStore.ingestUserEvent({
          ownerEmail: connection.ownerEmail,
          connectionId: connection.id,
          eventId: event.eventId,
          externalUserId: event.externalUserId,
          customerDisplayName,
          replyToken: event.replyToken,
          message: event.message,
          receivedAt: event.receivedAt,
        });
        const dispatch = await eventStore.claimWorkflowDispatch({
          connectionId: connection.id,
          eventId: result?.eventId ?? event.eventId,
        });
        if (dispatch?.claimed !== true) continue;
        try {
          await startWorkflow({
            eventId: dispatch.eventId,
            connectionId: dispatch.connectionId,
            conversationId: dispatch.conversationId,
          });
        } catch {
          await eventStore.releaseWorkflowDispatch({
            connectionId: dispatch.connectionId,
            eventId: dispatch.eventId,
            claimId: dispatch.claimId,
          });
          throw new Error("Workflow start failed.");
        }
        const marked = await eventStore.markWorkflowDispatched({
          connectionId: dispatch.connectionId,
          eventId: dispatch.eventId,
          claimId: dispatch.claimId,
        });
        if (marked !== true) throw new Error("Workflow dispatch could not be recorded.");
      }
    } catch {
      return safeResponse(respond, RESPONSES.unavailable, 503);
    }
    return safeResponse(respond, RESPONSES.accepted, 200);
  };
}

function parseEvents(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || !Array.isArray(payload.events)
    || payload.events.length > MAX_EVENTS) {
    throw new Error("Invalid LINE payload.");
  }
  return payload.events.map(parseEvent);
}

function parseEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) throw new Error("Invalid LINE event.");
  const eventId = boundedText(event.webhookEventId, 256);
  const sourceType = event.source?.type;
  if (sourceType !== "user" && sourceType !== "group" && sourceType !== "room") {
    throw new Error("Invalid LINE event source.");
  }
  if (sourceType !== "user") return { eventId, sourceType };
  if (event.type !== "message") return { eventId, sourceType: "user_event" };

  const externalUserId = boundedText(event.source?.userId, 256);
  const replyToken = optionalText(event.replyToken, 512);
  const receivedAt = timestamp(event.timestamp);
  const message = safeMessage(event.message, event.type);
  return { eventId, sourceType, externalUserId, replyToken, receivedAt, message };
}

function safeMessage(message, eventType) {
  const type = typeof message?.type === "string" && message.type.length <= 64
    ? message.type
    : eventType === "message" ? null : "event";
  if (!type) throw new Error("Invalid LINE message.");
  if (type === "text") {
    if (typeof message?.text !== "string" || message.text.length > 5_000) {
      throw new Error("Invalid LINE text.");
    }
    return { type, text: message.text, safeMetadata: {} };
  }
  return { type, text: null, safeMetadata: { type }, handoffReasonCode: "non_text" };
}

function timestamp(value) {
  const maximumUnixMilliseconds = 8_640_000_000_000_000;
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximumUnixMilliseconds) {
    throw new Error("Invalid LINE timestamp.");
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("Invalid LINE timestamp.");
  return date;
}

function boundedText(value, maxLength) {
  if (typeof value !== "string" || !value || value.length > maxLength) {
    throw new Error("Invalid LINE field.");
  }
  return value;
}

function optionalText(value, maxLength) {
  if (value == null) return null;
  return boundedText(value, maxLength);
}

function validConnection(connection) {
  return typeof connection.id === "string" && connection.id
    && typeof connection.ownerEmail === "string" && connection.ownerEmail
    && typeof connection.channelSecret === "string" && connection.channelSecret;
}

async function loadCustomerDisplayName(lineAdapter, connection, externalUserId) {
  if (typeof connection.accessToken !== "string" || !connection.accessToken
    || typeof lineAdapter?.getUserProfile !== "function") return null;
  try {
    const profile = await lineAdapter.getUserProfile({ accessToken: connection.accessToken, userId: externalUserId });
    return typeof profile?.displayName === "string" && profile.displayName.trim()
      ? profile.displayName.trim().slice(0, 512)
      : null;
  } catch {
    // Profile lookup is optional; a failure must never reject a verified webhook.
    return null;
  }
}

function safeResponse(respond, body, status) {
  return respond(body, { status });
}

async function readBodyWithinLimit(request) {
  if (!request?.body?.getReader) throw new Error("Invalid body.");
  const reader = request.body.getReader(); const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      size += chunk.byteLength; if (size > MAX_BODY_BYTES) throw new RangeError("too large");
      chunks.push(chunk);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
