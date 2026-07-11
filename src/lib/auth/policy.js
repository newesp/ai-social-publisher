export function normalizeEmail(email) {
  return String(email ?? "").trim().toLowerCase();
}

export function getAuthMode(env = process.env) {
  const mode = String(env.AUTH_MODE ?? "").trim().toLowerCase();
  return mode === "demo" || mode === "production" ? mode : null;
}

export function parseAllowedGoogleEmails(env = process.env) {
  return new Set(
    String(env.ALLOWED_GOOGLE_EMAILS ?? "")
      .split(",")
      .map((email) => normalizeEmail(email))
      .filter(Boolean),
  );
}

export function isAllowedProductionEmail(email, env = process.env) {
  const normalized = normalizeEmail(email);
  return Boolean(normalized) && parseAllowedGoogleEmails(env).has(normalized);
}

export function canSignInWithGoogle(email, env = process.env) {
  const normalized = normalizeEmail(email);
  if (!normalized) return false;

  const authMode = getAuthMode(env);
  if (authMode === "demo") return true;
  if (authMode === "production") return isAllowedProductionEmail(normalized, env);
  return false;
}

export function canUseApp(email, env = process.env) {
  return canSignInWithGoogle(email, env);
}

export function canPublish(email, env = process.env) {
  return canSignInWithGoogle(email, env);
}

export function canManageSettings(email, env = process.env) {
  return canSignInWithGoogle(email, env);
}
