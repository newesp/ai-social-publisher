import crypto from "node:crypto";

import { decryptJson, encryptJson } from "../settings/credential-crypto.js";

const CUSTOMER_LOOKUP_PURPOSE = "support.customer-lookup.v1";
const EXTERNAL_ID_PURPOSE = "support.customer-external-id.v1";

export function hashWebhookKey(key) {
  return crypto.createHash("sha256").update(requireText(key, "Webhook key")).digest("hex");
}

export function customerLookupKey(connectionId, externalId, encryptionKey) {
  const connection = requireText(connectionId, "Connection ID");
  const customer = requireText(externalId, "Customer external ID");
  const key = requireText(encryptionKey, "Encryption key");

  return crypto.createHmac("sha256", key)
    .update(CUSTOMER_LOOKUP_PURPOSE)
    .update("\0")
    .update(connection)
    .update("\0")
    .update(customer)
    .digest("hex");
}

export function encryptExternalId(externalId, encryptionKey) {
  return encryptJson({
    purpose: EXTERNAL_ID_PURPOSE,
    externalId: requireText(externalId, "Customer external ID"),
  }, encryptionKey);
}

export function decryptExternalId(encryptedExternalId, encryptionKey) {
  const payload = decryptJson(encryptedExternalId, encryptionKey);
  if (payload?.purpose !== EXTERNAL_ID_PURPOSE || typeof payload.externalId !== "string" || !payload.externalId) {
    throw new Error("Stored customer identifier could not be decrypted.");
  }
  return payload.externalId;
}

function requireText(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${label} is required.`);
  return text;
}
