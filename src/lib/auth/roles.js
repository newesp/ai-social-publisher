export function parseAdminEmails(env = process.env) {
  return new Set(
    String(env.ADMIN_EMAILS ?? "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function canSignInWithGoogle() {
  return true;
}

export function isAdminEmail(email, env = process.env) {
  if (!email) return false;
  return parseAdminEmails(env).has(String(email).trim().toLowerCase());
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
