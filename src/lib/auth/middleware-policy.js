export function isLocalAuthBypassEnabled(env = process.env) {
  return env.NODE_ENV === "development" && env.DISABLE_AUTH_FOR_LOCAL_DEV === "true";
}
