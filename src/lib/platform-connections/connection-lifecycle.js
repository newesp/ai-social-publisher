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

export async function fetchWithDeadline(fetchImpl, url, options = {}, timeoutMs = 10_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } catch {
    throw retryableLifecycleError();
  } finally {
    clearTimeout(timer);
  }
}
