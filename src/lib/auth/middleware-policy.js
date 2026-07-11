import { canUseApp, normalizeEmail } from "./policy.js";

export function isLocalAuthBypassEnabled(env = process.env) {
  return env.NODE_ENV === "development" && env.DISABLE_AUTH_FOR_LOCAL_DEV === "true";
}

export function isBrowserRequestAuthorized({ token }, env = process.env) {
  return canUseApp(normalizeEmail(token?.email), env);
}
