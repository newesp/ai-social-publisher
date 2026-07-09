import crypto from "node:crypto";

const APP_NAME = "ai-social-publisher";
const SCHEMA_VERSION = 1;
const CIPHER = "aes-256-gcm";
const KDF = "pbkdf2-sha256";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const SALT_BYTES = 16;
const PBKDF2_ITERATIONS = 210000;

export function encryptSecretBundle(secrets, passphrase, now = new Date()) {
  assertPassphrase(passphrase);

  const salt = crypto.randomBytes(SALT_BYTES);
  const iv = crypto.randomBytes(IV_BYTES);
  const key = deriveKey(passphrase, salt);
  const cipher = crypto.createCipheriv(CIPHER, key, iv);
  const plaintext = Buffer.from(JSON.stringify(secrets), "utf8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  return {
    schemaVersion: SCHEMA_VERSION,
    app: APP_NAME,
    cipher: CIPHER,
    kdf: KDF,
    iterations: PBKDF2_ITERATIONS,
    exportedAt: now.toISOString(),
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: encrypted.toString("base64"),
  };
}

export function decryptSecretBundle(bundle, passphrase) {
  assertPassphrase(passphrase);
  assertBundle(bundle);

  try {
    const salt = Buffer.from(bundle.salt, "base64");
    const iv = Buffer.from(bundle.iv, "base64");
    const tag = Buffer.from(bundle.tag, "base64");
    const ciphertext = Buffer.from(bundle.ciphertext, "base64");
    const key = deriveKey(passphrase, salt);
    const decipher = crypto.createDecipheriv(CIPHER, key, iv);
    decipher.setAuthTag(tag);

    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(decrypted.toString("utf8"));
  } catch {
    throw new Error("Unable to decrypt secret bundle.");
  }
}

export function previewSecretImport(incoming, current = {}) {
  return Object.keys(incoming)
    .sort()
    .map((key) => ({
      key,
      action: Object.hasOwn(current, key) ? "conflict" : "create",
      maskedValue: maskSecret(incoming[key]),
    }));
}

export function mergeSecrets(current, incoming, mode) {
  if (mode !== "create-missing" && mode !== "overwrite") {
    throw new Error("Unsupported merge mode.");
  }

  const merged = { ...current };
  for (const [key, value] of Object.entries(incoming)) {
    if (mode === "overwrite" || !Object.hasOwn(merged, key)) {
      merged[key] = value;
    }
  }
  return merged;
}

export function maskSecret(value) {
  const text = String(value ?? "");
  if (text.length <= 6) return "*".repeat(text.length);
  return `${text.slice(0, 3)}...${text.slice(-3)}`;
}

function deriveKey(passphrase, salt) {
  return crypto.pbkdf2Sync(passphrase, salt, PBKDF2_ITERATIONS, KEY_BYTES, "sha256");
}

function assertPassphrase(passphrase) {
  if (!passphrase || String(passphrase).length < 8) {
    throw new Error("Passphrase must be at least 8 characters.");
  }
}

function assertBundle(bundle) {
  if (
    !bundle ||
    bundle.schemaVersion !== SCHEMA_VERSION ||
    bundle.app !== APP_NAME ||
    bundle.cipher !== CIPHER ||
    bundle.kdf !== KDF
  ) {
    throw new Error("Unsupported secret bundle.");
  }
}
