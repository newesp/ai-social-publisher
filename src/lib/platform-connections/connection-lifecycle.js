export class ConnectionLifecycleError extends Error {
  constructor(message, { retryable = false, authorizationRejected = false, status = retryable ? 503 : 409 } = {}) {
    super(message);
    this.name = "ConnectionLifecycleError";
    this.status = status;
    this.retryable = retryable;
    this.authorizationRejected = authorizationRejected;
  }
}

export function retryableLifecycleError(message = "Platform credentials are temporarily unavailable. Please retry shortly.") {
  return new ConnectionLifecycleError(message, { retryable: true, status: 503 });
}

export function authorizationLifecycleError(message) {
  return new ConnectionLifecycleError(message, { authorizationRejected: true, status: 409 });
}

export function permanentConnectionFailureError(message = "The selected platform connection needs to be reconnected.") {
  const error = new ConnectionLifecycleError(message, { status: 409 });
  error.permanentConnectionFailure = true;
  return error;
}

export async function fetchWithDeadline(fetchImpl, url, options = {}, timeoutMs = 10_000, consumeResponse = async (response) => response) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...options, signal: controller.signal });
    return await consumeResponse(response, controller.signal);
  } catch {
    throw retryableLifecycleError();
  } finally {
    clearTimeout(timer);
  }
}
