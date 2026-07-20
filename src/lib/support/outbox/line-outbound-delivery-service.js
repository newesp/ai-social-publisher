const REVIEW_WINDOW_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_BASE_RETRY_DELAY_MS = 1_000;
const DEFAULT_MAX_RETRY_DELAY_MS = 30 * 60 * 1_000;

export function createLineOutboundDeliveryService({
  outboxStore,
  sendPush,
  onCredentialRejected = async () => {},
  baseRetryDelayMs = DEFAULT_BASE_RETRY_DELAY_MS,
  maxRetryDelayMs = DEFAULT_MAX_RETRY_DELAY_MS,
  now: clock = null,
} = {}) {
  if (!outboxStore || typeof outboxStore.claimDelivery !== "function") {
    throw new Error("An outbound delivery store is required.");
  }
  if (typeof sendPush !== "function") throw new Error("A LINE Push sender is required.");
  if (typeof onCredentialRejected !== "function") throw new Error("Credential rejection handler must be a function.");
  if (clock != null && typeof clock !== "function") throw new Error("Delivery clock must be a function.");
  validateDelay(baseRetryDelayMs, "Base retry delay");
  validateDelay(maxRetryDelayMs, "Maximum retry delay");

  return {
    async attemptDelivery({
      deliveryId, now = new Date(), eventId, eventClaimId, connectionId, conversationId, conversationClaimId,
    } = {}) {
      const attemptedAt = validDate(now);
      const claim = await outboxStore.claimDelivery({
        deliveryId: requiredId(deliveryId),
        now: attemptedAt,
        ...(eventId ? { eventId } : {}),
        ...(eventClaimId ? { eventClaimId } : {}),
        ...(connectionId ? { connectionId } : {}),
        ...(conversationId ? { conversationId } : {}),
        ...(conversationClaimId ? { conversationClaimId } : {}),
      });
      if (!claim?.claimed) return { status: claim?.status ?? "duplicate" };

      let response;
      try {
        response = await sendPush({
          retryKey: claim.retryKey,
          body: claim.canonicalBody,
          ...(claim.connectionId ? { connectionId: claim.connectionId } : {}),
        });
      } catch (error) {
        const completedAt = currentAttemptTime(clock, attemptedAt);
        if (error?.retryable === true) {
          return recordRetryable({
            outboxStore,
            claim,
            deliveryId,
            attemptedAt: completedAt,
            baseRetryDelayMs,
            maxRetryDelayMs,
            safeErrorCode: "line_push_transport",
          });
        }
        const updated = await outboxStore.markDeliveryFailed({
          deliveryId,
          claimId: claim.claimId,
          safeErrorCode: "line_push_unclassified_failure",
          now: completedAt,
        });
        return updated === false
          ? authoritativeDelivery(outboxStore, deliveryId)
          : { status: "failed" };
      }

      const status = Number(response?.status);
      const completedAt = currentAttemptTime(clock, attemptedAt);
      const acceptedRequestId = readHeader(response?.headers, "x-line-accepted-request-id");
      if ((status >= 200 && status < 300) || (status === 409 && acceptedRequestId)) {
        const updated = await outboxStore.markDeliverySent({
          deliveryId,
          claimId: claim.claimId,
          acceptedRequestId: acceptedRequestId || null,
          now: completedAt,
        });
        return updated === false
          ? authoritativeDelivery(outboxStore, deliveryId)
          : { status: "sent", acceptedRequestId: acceptedRequestId || null };
      }
      if (status >= 500 && status < 600) {
        return recordRetryable({
          outboxStore,
          claim,
          deliveryId,
          attemptedAt: completedAt,
          baseRetryDelayMs,
          maxRetryDelayMs,
          safeErrorCode: "line_push_5xx",
        });
      }
      const updated = await outboxStore.markDeliveryFailed({
        deliveryId,
        claimId: claim.claimId,
        safeErrorCode: "line_push_4xx",
        now: completedAt,
      });
      if (updated === false) return authoritativeDelivery(outboxStore, deliveryId);
      let credentialHandoff;
      if (status === 401 && claim.connectionId
        && eventId && eventClaimId && conversationClaimId && connectionId && conversationId) {
        credentialHandoff = await onCredentialRejected({
          connectionId, conversationId, eventId, eventClaimId, claimId: conversationClaimId, now: completedAt,
        });
      }
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
  const updated = await outboxStore.markDeliveryRetryable({
    deliveryId,
    claimId: claim.claimId,
    retryAt,
    safeErrorCode,
    now: attemptedAt,
  });
  if (updated === false) return authoritativeDelivery(outboxStore, deliveryId);
  return { status: "retryable", retryAt };
}

async function authoritativeDelivery(outboxStore, deliveryId) {
  if (typeof outboxStore.getDeliveryStatus !== "function") return { status: "duplicate" };
  return { status: await outboxStore.getDeliveryStatus(deliveryId) };
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

function currentAttemptTime(now, fallback) {
  return now == null ? fallback : validDate(now());
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
