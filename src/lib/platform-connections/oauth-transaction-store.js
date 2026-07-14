import crypto from "node:crypto";

import { decryptJson, encryptJson } from "../settings/credential-crypto.js";

const EXPIRY_MS = 10 * 60 * 1000;
const EXPIRED_ERROR = "OAuth transaction is expired or already used.";

export function createOAuthTransactionStore({ repository, encryptionKey }) {
  return {
    async create(ownerEmail, provider, payload, returnPath, now) {
      const createdAt = requireDate(now);
      const record = await repository.createOAuthTransaction({
        id: crypto.randomUUID(), ownerEmail: normalizeOwner(ownerEmail), provider: requireProvider(provider),
        encryptedPayload: encryptJson(requirePayload(payload), encryptionKey), returnPath: requireReturnPath(returnPath),
        expiresAt: new Date(createdAt.getTime() + EXPIRY_MS), consumedAt: null, createdAt,
      });
      return { id: record.id, provider: record.provider, returnPath: record.returnPath, expiresAt: record.expiresAt, createdAt: record.createdAt };
    },
    async consume(ownerEmail, id, now) {
      const record = await repository.consumeOAuthTransaction(requireId(id), normalizeOwner(ownerEmail), requireDate(now));
      if (!record) throw new Error(EXPIRED_ERROR);
      return decryptJson(record.encryptedPayload, encryptionKey);
    },
    async read(ownerEmail, id, now) {
      const record = await repository.findOAuthTransactionByIdAndOwner(requireId(id), normalizeOwner(ownerEmail), requireDate(now));
      if (!record) throw new Error(EXPIRED_ERROR);
      return decryptJson(record.encryptedPayload, encryptionKey);
    },
    async purgeExpired(now) { await repository.purgeExpiredOAuthTransactions(requireDate(now)); },
  };
}

function normalizeOwner(ownerEmail) { const value = String(ownerEmail ?? "").trim().toLowerCase(); if (!value) throw new Error("An OAuth transaction owner is required."); return value; }
function requireProvider(provider) { const value = String(provider ?? "").trim().toLowerCase(); if (!value) throw new Error("An OAuth provider is required."); return value; }
function requirePayload(payload) { if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("OAuth transaction payload is required."); return payload; }
function requireReturnPath(returnPath) { const value = String(returnPath ?? "").trim(); if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) throw new Error("OAuth return path must be a local path."); return value; }
function requireId(id) { const value = String(id ?? "").trim(); if (!value) throw new Error(EXPIRED_ERROR); return value; }
function requireDate(value) { const date = value instanceof Date ? value : new Date(value); if (Number.isNaN(date.getTime())) throw new Error("A valid OAuth transaction time is required."); return date; }
