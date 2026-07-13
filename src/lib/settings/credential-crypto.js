import crypto from "node:crypto";

const CIPHER = "aes-256-gcm";
const IV_BYTES = 12;

export function encryptJson(value, encryptionKey) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(CIPHER, deriveEncryptionKey(encryptionKey), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), ciphertext.toString("base64")].join(".");
}

export function decryptJson(encryptedValue, encryptionKey) {
  const [version, ivText, tagText, ciphertextText] = String(encryptedValue).split(".");
  if (version !== "v1" || !ivText || !tagText || !ciphertextText) throw new Error("Stored credentials could not be decrypted.");
  try {
    const decipher = crypto.createDecipheriv(CIPHER, deriveEncryptionKey(encryptionKey), Buffer.from(ivText, "base64"));
    decipher.setAuthTag(Buffer.from(tagText, "base64"));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(ciphertextText, "base64")), decipher.final()]).toString("utf8"));
  } catch {
    throw new Error("Stored credentials could not be decrypted.");
  }
}

function deriveEncryptionKey(encryptionKey) {
  if (!String(encryptionKey ?? "").trim()) throw new Error("SETTINGS_ENCRYPTION_KEY must be configured.");
  return crypto.createHash("sha256").update(String(encryptionKey)).digest();
}
