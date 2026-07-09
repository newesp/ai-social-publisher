import assert from "node:assert/strict";
import { test } from "node:test";

import {
  decryptSecretBundle,
  encryptSecretBundle,
  mergeSecrets,
  previewSecretImport,
} from "../src/lib/settings/secret-bundle.js";

const secrets = {
  googleAiApiKey: "google-key",
  openAiApiKey: "openai-key",
  imgurClientId: "imgur-id",
  metaPageAccessToken: "meta-token",
  lineChannelAccessToken: "line-token",
};

test("exports secrets as an encrypted portable bundle", () => {
  const bundle = encryptSecretBundle(secrets, "correct horse battery staple");

  assert.equal(bundle.schemaVersion, 1);
  assert.equal(bundle.app, "ai-social-publisher");
  assert.equal(bundle.cipher, "aes-256-gcm");
  assert.equal(bundle.kdf, "pbkdf2-sha256");
  assert.ok(bundle.exportedAt);
  assert.ok(!JSON.stringify(bundle).includes("google-key"));
});

test("decrypts an encrypted portable bundle with the passphrase", () => {
  const bundle = encryptSecretBundle(secrets, "correct horse battery staple");

  assert.deepEqual(decryptSecretBundle(bundle, "correct horse battery staple"), secrets);
});

test("rejects an encrypted portable bundle with the wrong passphrase", () => {
  const bundle = encryptSecretBundle(secrets, "correct horse battery staple");

  assert.throws(() => decryptSecretBundle(bundle, "wrong passphrase"), /Unable to decrypt/);
});

test("previews secret import without exposing raw values", () => {
  const preview = previewSecretImport(
    { googleAiApiKey: "new-google", openAiApiKey: "new-openai" },
    { googleAiApiKey: "old-google" },
  );

  assert.deepEqual(preview, [
    { key: "googleAiApiKey", action: "conflict", maskedValue: "new...gle" },
    { key: "openAiApiKey", action: "create", maskedValue: "new...nai" },
  ]);
});

test("merges imported secrets without overwriting unless requested", () => {
  const current = { googleAiApiKey: "old-google" };
  const incoming = { googleAiApiKey: "new-google", openAiApiKey: "new-openai" };

  assert.deepEqual(mergeSecrets(current, incoming, "create-missing"), {
    googleAiApiKey: "old-google",
    openAiApiKey: "new-openai",
  });

  assert.deepEqual(mergeSecrets(current, incoming, "overwrite"), {
    googleAiApiKey: "new-google",
    openAiApiKey: "new-openai",
  });
});
