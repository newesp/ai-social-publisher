import crypto from "node:crypto";

import { maskSecret } from "./secret-bundle.js";

const PUBLIC_SETTING_KEYS = new Set(["metaPageId"]);
const SETTING_KEYS = new Set([
  "googleAiApiKey",
  "openAiApiKey",
  "metaPageId",
  "metaPageAccessToken",
  "lineChannelAccessToken",
]);
const CIPHER = "aes-256-gcm";
const IV_BYTES = 12;

export function createUserSettingsStore({ repository, encryptionKey }) {
  const key = deriveEncryptionKey(encryptionKey);

  return {
    async read(ownerEmail) {
      const record = await repository.findByOwnerEmail(assertOwnerEmail(ownerEmail));
      return record ? decryptSettings(record.encryptedSettings, key) : {};
    },

    async getMasked(ownerEmail) {
      const settings = await this.read(ownerEmail);
      return maskSettings(settings);
    },

    async update(ownerEmail, updates) {
      const normalizedOwnerEmail = assertOwnerEmail(ownerEmail);
      const currentRecord = await repository.findByOwnerEmail(normalizedOwnerEmail);
      const current = currentRecord ? decryptSettings(currentRecord.encryptedSettings, key) : {};
      const next = applyUpdates(current, updates);

      await repository.save({
        ownerEmail: normalizedOwnerEmail,
        encryptedSettings: encryptSettings(next, key),
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

function encryptSettings(settings, key) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(CIPHER, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(settings), "utf8"),
    cipher.final(),
  ]);

  return [
    "v1",
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    ciphertext.toString("base64"),
  ].join(".");
}

function decryptSettings(encryptedSettings, key) {
  const [version, ivText, tagText, ciphertextText] = String(encryptedSettings).split(".");
  if (version !== "v1" || !ivText || !tagText || !ciphertextText) {
    throw new Error("Stored settings could not be decrypted.");
  }

  try {
    const decipher = crypto.createDecipheriv(CIPHER, key, Buffer.from(ivText, "base64"));
    decipher.setAuthTag(Buffer.from(tagText, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ciphertextText, "base64")),
      decipher.final(),
    ]);
    return JSON.parse(plaintext.toString("utf8"));
  } catch {
    throw new Error("Stored settings could not be decrypted.");
  }
}

function deriveEncryptionKey(encryptionKey) {
  if (!String(encryptionKey ?? "").trim()) {
    throw new Error("SETTINGS_ENCRYPTION_KEY must be configured.");
  }
  return crypto.createHash("sha256").update(String(encryptionKey)).digest();
}

function assertOwnerEmail(ownerEmail) {
  const value = String(ownerEmail ?? "").trim().toLowerCase();
  if (!value) throw new Error("A settings owner is required.");
  return value;
}
