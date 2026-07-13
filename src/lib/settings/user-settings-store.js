import { decryptJson, encryptJson } from "./credential-crypto.js";
import { maskSecret } from "./secret-bundle.js";

const PUBLIC_SETTING_KEYS = new Set();
const SETTING_KEYS = new Set([
  "googleAiApiKey",
  "openAiApiKey",
]);

export function createUserSettingsStore({ repository, encryptionKey }) {
  return {
    async read(ownerEmail) {
      const record = await repository.findByOwnerEmail(assertOwnerEmail(ownerEmail));
      return record ? decryptJson(record.encryptedSettings, encryptionKey) : {};
    },

    async getMasked(ownerEmail) {
      const settings = await this.read(ownerEmail);
      return maskSettings(settings);
    },

    async update(ownerEmail, updates) {
      const normalizedOwnerEmail = assertOwnerEmail(ownerEmail);
      const currentRecord = await repository.findByOwnerEmail(normalizedOwnerEmail);
      const current = currentRecord ? decryptJson(currentRecord.encryptedSettings, encryptionKey) : {};
      const next = applyUpdates(current, updates);

      await repository.save({
        ownerEmail: normalizedOwnerEmail,
        encryptedSettings: encryptJson(next, encryptionKey),
        updatedAt: new Date(),
      });

      return next;
    },
  };
}

export function maskSettings(settings) {
  return Object.fromEntries(
    Object.entries(settings).map(([key, value]) => [
      key,
      PUBLIC_SETTING_KEYS.has(key) ? value : maskSecret(value),
    ]),
  );
}

function applyUpdates(current, updates) {
  const next = { ...current };

  for (const [key, value] of Object.entries(updates ?? {})) {
    if (!SETTING_KEYS.has(key)) throw new Error(`Unsupported settings key: ${key}.`);
    if (typeof value !== "string") throw new Error(`Settings value for ${key} must be a string.`);
    if (!value.trim()) continue;
    if (!PUBLIC_SETTING_KEYS.has(key) && isMaskedPlaceholder(value)) {
      throw new Error(`Masked placeholder values cannot be saved for ${key}.`);
    }
    next[key] = value;
  }

  return next;
}

function isMaskedPlaceholder(value) {
  return /^\*+$/.test(value) || /^.{3}\.\.\..{3}$/.test(value);
}

function assertOwnerEmail(ownerEmail) {
  const value = String(ownerEmail ?? "").trim().toLowerCase();
  if (!value) throw new Error("A settings owner is required.");
  return value;
}
