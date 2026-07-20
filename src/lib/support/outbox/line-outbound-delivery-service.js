const REVIEW_WINDOW_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_BASE_RETRY_DELAY_MS = 1_000;
const DEFAULT_MAX_RETRY_DELAY_MS = 30 * 60 * 1_000;

export function createLineOutboundDeliveryService({
  outboxStore,
  sendPush,
  onCredentialRejected = async () => {},
  baseRetryDelayMs = DEFAULT_BASE_RETRY_DELAY_MS,
  maxRetryDelayMs = DEFAULT_MAX_RETRY_DELAY_MS,
} = {}) {
  if (!outboxStore || typeof outboxStore.claimDelivery !== "function") {
    throw new Error("An outbound delivery store is required.");
  }
  if (typeof sendPush !== "function") throw new Error("A LINE Push sender is required.");
  if (typeof onCredentialRejected !== "function") throw new Error("Credential rejection handler must be a function.");
  validateDelay(baseRetryDelayMs, "Base retry delay");
  validateDelay(maxRetryDelayMs, "Maximum retry delay");

  return {
    async attemptDelivery({
      deliveryId, now = new Date(), eventId, eventClaimId, connectionId, conversationId, conversationClaimId,
    } = {}) {
      const attemptedAt = validDate(now);
      const claim = await outboxStore.claimDelivery({ deliveryId: requiredId(deliveryId), now: attemptedAt });
      if (!claim?.claimed) return { status: claim?.status ?? "duplicate" };

      let response;
      try {
        response = await sendPush({
          retryKey: claim.retryKey,
          body: claim.canonicalBody,
          ...(claim.connectionId ? { connectionId: claim.connectionId } : {}),
        });
      } catch (error) {
        if (error?.retryable === true) {
          return recordRetryable({
            outboxStore,
            claim,
            deliveryId,
            attemptedAt,
            baseRetryDelayMs,
            maxRetryDelayMs,
            safeErrorCode: "line_push_transport",
          });
        }
        await outboxStore.markDeliveryFailed({
          deliveryId,
          claimId: claim.claimId,
          safeErrorCode: "line_push_unclassified_failure",
          now: attemptedAt,
        });
        return { status: "failed" };
      }

      const status = Number(response?.status);
      const acceptedRequestId = readHeader(response?.headers, "x-line-accepted-request-id");
      if ((status >= 200 && status < 300) || (status === 409 && acceptedRequestId)) {
        await outboxStore.markDeliverySent({
          deliveryId,
          claimId: claim.claimId,
          acceptedRequestId: acceptedRequestId || null,
          now: attemptedAt,
        });
        return { status: "sent", acceptedRequestId: acceptedRequestId || null };
      }
      if (status >= 500 && status < 600) {
        return recordRetryable({
          outboxStore,
          claim,
          deliveryId,
          attemptedAt,
          baseRetryDelayMs,
          maxRetryDelayMs,
          safeErrorCode: "line_push_5xx",
        });
      }
      let credentialHandoff;
      if (status === 401 && claim.connectionId) {
        if (eventId && eventClaimId && conversationClaimId && connectionId && conversationId) {
          credentialHandoff = await onCredentialRejected({
            connectionId, conversationId, eventId, eventClaimId, claimId: conversationClaimId, now: attemptedAt,
          });
        }
      }
      await outboxStore.markDeliveryFailed({
        deliveryId,
        claimId: claim.claimId,
        safeErrorCode: "line_push_4xx",
        now: attemptedAt,
      });
      return { status: "failed", ...(credentialHandoff?.eventCompleted === true ? { eventCompleted: true } : {}) };
    },
  };
}

async function recordRetryable({
  outboxStore,
  claim,
  deliveryId,
  attemptedAt,
  baseRetryDelayMs,
  maxRetryDelayMs,
  safeErrorCode,
}) {
  const exponent = Math.max(0, Number(claim.attemptCount) - 1);
  const delay = Math.min(maxRetryDelayMs, baseRetryDelayMs * (2 ** exponent));
  const retryAt = new Date(attemptedAt.getTime() + delay);
  await outboxStore.markDeliveryRetryable({
    deliveryId,
    claimId: claim.claimId,
    retryAt,
    safeErrorCode,
    now: attemptedAt,
  });
  return { status: "retryable", retryAt };
}

function readHeader(headers, name) {
  if (headers && typeof headers.get === "function") return headers.get(name) || "";
  if (!headers || typeof headers !== "object") return "";
  return String(headers[name] ?? headers[name.toLowerCase()] ?? "");
}

function validDate(value) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("A valid attempt time is required.");
  return value;
}

function requiredId(value) {
  if (typeof value !== "string" || !value) throw new Error("An outbound delivery ID is required.");
  return value;
}

function validateDelay(value, label) {
  if (!Number.isSafeInteger(value) || value < 1 || value > REVIEW_WINDOW_MS) {
    throw new Error(`${label} must be a positive safe integer within the review window.`);
  }
}
