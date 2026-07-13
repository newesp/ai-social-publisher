import { readFileSync } from "node:fs";

export function validateRuntimeConfig(env) {
  const mode = String(env.AUTH_MODE ?? "").trim().toLowerCase();
  if (mode !== "demo" && mode !== "production") {
    throw new Error("AUTH_MODE must be set to demo or production.");
  }

  for (const key of ["SETTINGS_ENCRYPTION_KEY", "TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN"]) {
    if (!String(env[key] ?? "").trim()) {
      throw new Error(`${key} must be configured.`);
    }
  }

  validateBlobCredentials(env);

  validateTursoUrl(env.TURSO_DATABASE_URL);

  if (mode === "production" && !hasAllowedGoogleEmail(env.ALLOWED_GOOGLE_EMAILS)) {
    throw new Error("ALLOWED_GOOGLE_EMAILS must be configured when AUTH_MODE=production.");
  }
}

function validateBlobCredentials(env) {
  if (String(env.BLOB_READ_WRITE_TOKEN ?? "").trim()) return;

  if (!String(env.VERCEL_OIDC_TOKEN ?? "").trim()) {
    throw new Error("BLOB_READ_WRITE_TOKEN must be configured, or configure VERCEL_OIDC_TOKEN with BLOB_STORE_ID.");
  }

  if (!String(env.BLOB_STORE_ID ?? "").trim()) {
    throw new Error("BLOB_STORE_ID must be configured when using VERCEL_OIDC_TOKEN.");
  }
}

export function loadEnvironmentText(text, env) {
  for (const line of String(text).split(/\r?\n/)) {
    const match = line.match(/^\s*([^#=\s]+)\s*=\s*(.*)$/);
    if (match && !env[match[1]]) env[match[1]] = parseEnvironmentValue(match[2]);
  }
}

function loadLocalEnv(env) {
  try {
    loadEnvironmentText(readFileSync(".env.local", "utf8"), env);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function hasAllowedGoogleEmail(value) {
  return String(value ?? "").split(",").some((email) => email.trim());
}

function validateTursoUrl(value) {
  try {
    const url = new URL(String(value));
    if (!url.hostname || !["libsql:", "https:"].includes(url.protocol)) throw new Error();
  } catch {
    throw new Error("TURSO_DATABASE_URL must be a valid libsql:// or https:// URL.");
  }
}

function parseEnvironmentValue(value) {
  const text = String(value).trim();
  if ((text.startsWith('"') && text.includes('"', 1)) || (text.startsWith("'") && text.includes("'", 1))) {
    const quote = text[0];
    return text.slice(1, text.indexOf(quote, 1));
  }
  return text.replace(/\s+#.*$/, "").trim();
}

if (process.argv[1]?.endsWith("runtime-config.mjs")) {
  loadLocalEnv(process.env);
  validateRuntimeConfig(process.env);
  console.log("Runtime configuration is valid.");
}
