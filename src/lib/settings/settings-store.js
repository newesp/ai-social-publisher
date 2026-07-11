import { createDbClient } from "../db/index.js";
import { createDbUserSettingsRepository } from "./db-user-settings-repository.js";
import { createUserSettingsStore } from "./user-settings-store.js";

export function getUserSettingsStore(env = process.env) {
  return createUserSettingsStore({
    repository: createDbUserSettingsRepository(createDbClient(env)),
    encryptionKey: env.SETTINGS_ENCRYPTION_KEY,
  });
}

export async function readSettings(ownerEmail, options = {}) {
  return (options.store ?? getUserSettingsStore(options.env)).read(ownerEmail);
}

export async function updateSettings(ownerEmail, updates, options = {}) {
  return (options.store ?? getUserSettingsStore(options.env)).update(ownerEmail, updates);
}

export async function getMaskedSettings(ownerEmail, options = {}) {
  return (options.store ?? getUserSettingsStore(options.env)).getMasked(ownerEmail);
}
