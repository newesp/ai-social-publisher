import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";

import {
  customerLookupKey,
  decryptExternalId,
  encryptExternalId,
  hashWebhookKey,
} from "../src/lib/support/identity-crypto.js";

const ENCRYPTION_KEY = "support-identity-test-key";

test("webhook keys use a stable SHA-256 digest without retaining the key", () => {
  const webhookKey = crypto.randomBytes(32).toString("base64url");
  const digest = hashWebhookKey(webhookKey);

  assert.equal(digest, crypto.createHash("sha256").update(webhookKey).digest("hex"));
  assert.equal(digest.includes(webhookKey), false);
});

test("customer lookup is stable and domain-separated by connection while external identifiers are encrypted", () => {
  const first = customerLookupKey("line-1", "U123", ENCRYPTION_KEY);

  assert.equal(first, customerLookupKey("line-1", "U123", ENCRYPTION_KEY));
  assert.notEqual(first, customerLookupKey("line-2", "U123", ENCRYPTION_KEY));

  const encrypted = encryptExternalId("U123", ENCRYPTION_KEY);
  assert.equal(encrypted.includes("U123"), false);
  assert.equal(decryptExternalId(encrypted, ENCRYPTION_KEY), "U123");
});

test("identity crypto rejects empty inputs and the wrong decryption key", () => {
  assert.throws(() => hashWebhookKey(""), /required/i);
  assert.throws(() => customerLookupKey("", "U123", ENCRYPTION_KEY), /required/i);
  assert.throws(() => encryptExternalId("", ENCRYPTION_KEY), /required/i);

  const encrypted = encryptExternalId("U123", ENCRYPTION_KEY);
  assert.throws(() => decryptExternalId(encrypted, "wrong-key"), /could not be decrypted/i);
});
