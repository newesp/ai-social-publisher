import { toSafeSupportReadiness } from "../support-onboarding-service.js";

export function createSupportOnboardingRouteHandlers({
  requireOwner,
  requireSameOrigin,
  getServices,
  respond = (body, init) => Response.json(body, init),
}) {
  return {
    async getState() {
      const ownerEmail = await requireOwner();
      const { supportStore, onboarding } = await getServices();
      const configuration = await supportStore.getConfiguration(ownerEmail);
      const readiness = await onboarding.getReadiness(
        ownerEmail,
        configuration?.platformConnectionId ?? null,
      );
      return respond({ readiness: toSafeSupportReadiness(readiness) });
    },

    async refreshReadiness(request) {
      const ownerEmail = await requireOwner();
      requireSameOrigin(request);
      const { connections, onboarding } = await getServices();
      const connection = await connections.getDefault(ownerEmail, "line");
      if (!connection?.id) throw routeError("Connect LINE before checking readiness.", 409);

      try {
        const result = await onboarding.provisionLineWebhook(ownerEmail, connection.id);
        return respond({
          setup: {
            status: result?.setupStatus === "verified" ? "verified" : "needs_action",
            retryable: result?.setupStatus !== "verified",
          },
          readiness: toSafeSupportReadiness(result?.readiness),
        });
      } catch (error) {
        if (!error?.setupRetryable) throw error;
        try {
          await onboarding.setSupportEnabled(ownerEmail, connection.id, false);
        } catch {
          // Provisioning already disables support; this is a defensive best effort.
        }
        const readiness = await onboarding.getReadiness(ownerEmail, connection.id);
        return respond({
          setup: { status: "retryable", retryable: true },
          readiness: toSafeSupportReadiness(readiness),
        }, { status: 502 });
      }
    },

    async testProvider(request) {
      const ownerEmail = await requireOwner();
      requireSameOrigin(request);
      const { supportStore, onboarding } = await getServices();
      const configuration = await supportStore.getConfiguration(ownerEmail);
      if (!configuration?.platformConnectionId) {
        throw routeError("Save support settings before testing the AI provider.", 409);
      }

      try {
        const result = await onboarding.testAiProvider(
          ownerEmail,
          configuration.platformConnectionId,
        );
        return respond({
          providerTest: {
            status: result?.status === "passed" ? "passed" : "failed",
            providerTested: result?.providerTested === true,
          },
        });
      } catch (error) {
        const clientError = providerClientError(error);
        if (clientError) {
          return respond({
            error: clientError.message,
            providerTest: { status: "not_ready", providerTested: false },
          }, { status: clientError.status });
        }
        return respond({
          error: "AI provider test failed.",
          providerTest: { status: "failed", providerTested: false },
        }, { status: 502 });
      }
    },

    async setState(request) {
      const ownerEmail = await requireOwner();
      requireSameOrigin(request);
      const { supportStore, onboarding } = await getServices();
      const input = await enabledBody(request);
      const configuration = await supportStore.getConfiguration(ownerEmail);
      if (!configuration?.platformConnectionId) {
        throw routeError("Save support settings before changing AI support.", 409);
      }

      try {
        const result = await onboarding.setSupportEnabled(
          ownerEmail,
          configuration.platformConnectionId,
          input.enabled,
        );
        return respond({
          support: {
            enabled: result?.supportEnabled === true,
            state: result?.state === "enabled" ? "enabled" : "disabled",
          },
          ...(result?.checks ? { readiness: toSafeSupportReadiness(result) } : {}),
        });
      } catch (error) {
        if (error?.status === 409 && error?.readiness) {
          return respond({
            error: "AI support is not ready to be enabled.",
            readiness: toSafeSupportReadiness(error.readiness),
          }, { status: 409 });
        }
        throw error;
      }
    },
  };
}

function providerClientError(error) {
  const safeErrors = new Map([
    ["Support configuration was not found.", 404],
    ["AI provider is not configured.", 409],
    ["AI provider test is already in progress.", 409],
    ["Support configuration changed. Refresh readiness and try again.", 409],
  ]);
  const status = safeErrors.get(error?.message);
  return Number.isInteger(status) && status === error?.status
    ? { message: error.message, status }
    : null;
}

async function enabledBody(request) {
  let input;
  try {
    input = await request.json();
  } catch {
    throw routeError("A JSON request body is required.", 400);
  }
  const keys = input && typeof input === "object" && !Array.isArray(input)
    ? Object.keys(input)
    : [];
  if (keys.length !== 1 || keys[0] !== "enabled" || typeof input.enabled !== "boolean") {
    throw routeError("Support enabled must be a boolean.", 400);
  }
  return input;
}

function routeError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}
