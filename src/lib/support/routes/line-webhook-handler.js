import { hashWebhookKey } from "../identity-crypto.js";

const RESPONSES = Object.freeze({
  accepted: { ok: true },
  notFound: { error: "Webhook endpoint was not found." },
  unauthorized: { error: "Webhook signature was not accepted." },
  malformed: { error: "Webhook payload was invalid." },
  unavailable: { error: "Webhook ingestion is temporarily unavailable." },
});

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

    let rawBody;
    try {
      rawBody = await request.text();
    } catch {
      return safeResponse(respond, RESPONSES.malformed, 400);
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
        if (event.sourceType === "group" || event.sourceType === "room") {
          await eventStore.recordIgnoredEvent({
            connectionId: connection.id,
            eventId: event.eventId,
            sourceType: event.sourceType,
          });
          continue;
        }
        const result = await eventStore.ingestUserEvent({
          ownerEmail: connection.ownerEmail,
          connectionId: connection.id,
          eventId: event.eventId,
          externalUserId: event.externalUserId,
          replyToken: event.replyToken,
          message: event.message,
          receivedAt: event.receivedAt,
        });
        if (result?.inserted !== true) continue;
        await startWorkflow({
          eventId: result.eventId,
          connectionId: connection.id,
          conversationId: result.conversationId,
        });
      }
    } catch {
      return safeResponse(respond, RESPONSES.unavailable, 503);
    }
    return safeResponse(respond, RESPONSES.accepted, 200);
  };
}

function parseEvents(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || !Array.isArray(payload.events)) {
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
  if (!Number.isFinite(value) || value < 0) throw new Error("Invalid LINE timestamp.");
  return new Date(value);
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

function safeResponse(respond, body, status) {
  return respond(body, { status });
}
