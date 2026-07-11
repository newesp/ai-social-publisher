import { normalizeEmail } from "./policy.js";

export function parseAdminEmails(env = process.env) {
  return new Set(
    String(env.ADMIN_EMAILS ?? "")
      .split(",")
      .map((email) => normalizeEmail(email))
      .filter(Boolean),
  );
}

export { canSignInWithGoogle, normalizeEmail } from "./policy.js";

export function isAdminEmail(email, env = process.env) {
  const normalized = normalizeEmail(email);
  return Boolean(normalized) && parseAdminEmails(env).has(normalized);
}

export function getRoleForEmail(email, env = process.env) {
  return isAdminEmail(email, env) ? "admin" : "user";
}

export function requireAdminEmail(email, env = process.env) {
  if (!isAdminEmail(email, env)) {
    const error = new Error("Admin privileges are required.");
    error.status = 403;
    throw error;
  }
}
