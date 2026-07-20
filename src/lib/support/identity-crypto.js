import crypto from "node:crypto";

import { decryptJson, encryptJson } from "../settings/credential-crypto.js";

const CUSTOMER_LOOKUP_PURPOSE = "support.customer-lookup.v1";
const EXTERNAL_ID_PURPOSE = "support.customer-external-id.v1";
const REPLY_TOKEN_PURPOSE = "support.reply-token.v1";

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
  return decryptPurposeText(encryptedExternalId, encryptionKey, EXTERNAL_ID_PURPOSE, "externalId", "Stored customer identifier");
}

export function encryptReplyToken(replyToken, encryptionKey) {
  return encryptJson({
    purpose: REPLY_TOKEN_PURPOSE,
    replyToken: requireText(replyToken, "LINE reply token"),
  }, encryptionKey);
}

export function decryptReplyToken(encryptedReplyToken, encryptionKey) {
  return decryptPurposeText(encryptedReplyToken, encryptionKey, REPLY_TOKEN_PURPOSE, "replyToken", "Stored reply token");
}

function decryptPurposeText(encryptedValue, encryptionKey, purpose, field, label) {
  const payload = decryptJson(encryptedValue, encryptionKey);
  if (payload?.purpose !== purpose || typeof payload[field] !== "string" || !payload[field]) {
    throw new Error(`${label} could not be decrypted.`);
  }
  return payload[field];
}

function requireText(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${label} is required.`);
  return text;
}
