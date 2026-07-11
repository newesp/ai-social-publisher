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

  if (mode === "production" && !String(env.ALLOWED_GOOGLE_EMAILS ?? "").trim()) {
    throw new Error("ALLOWED_GOOGLE_EMAILS must be configured when AUTH_MODE=production.");
  }
}

function loadLocalEnv(env) {
  try {
    for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
      const match = line.match(/^\s*([^#=\s]+)\s*=\s*(.*)$/);
      if (match && !env[match[1]]) env[match[1]] = match[2];
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

if (process.argv[1]?.endsWith("runtime-config.mjs")) {
  loadLocalEnv(process.env);
  validateRuntimeConfig(process.env);
  console.log("Runtime configuration is valid.");
}
