import crypto from "node:crypto";

import { decryptJson, encryptJson } from "../settings/credential-crypto.js";
import { permanentConnectionFailureError } from "./connection-lifecycle.js";

const PLATFORMS = new Set(["meta", "line"]);

export function createPlatformConnectionStore({ repository, encryptionKey }) {
  return {
    async create(ownerEmail, input) {
      const record = await repository.createConnection(toNewRecord(ownerEmail, input, encryptionKey));
      return toConnection(record, encryptionKey);
    },
    async replaceDefault(ownerEmail, input) {
      const record = await repository.replaceDefaultConnection(toNewRecord(ownerEmail, input, encryptionKey));
      return toConnection(record, encryptionKey);
    },
    async replaceDefaultFromOAuth(ownerEmail, input, transactionId, now) {
      const owner = normalizeOwner(ownerEmail);
      const record = await repository.replaceDefaultConnectionFromOAuth(
        toNewRecord(owner, input, encryptionKey), requireId(transactionId), owner, "meta", toDate(now),
      );
      return record ? toConnection(record, encryptionKey) : null;
    },
    async getDefault(ownerEmail, platform) {
      const record = await repository.findDefaultByOwnerAndPlatform(normalizeOwner(ownerEmail), requirePlatform(platform));
      return record ? toConnection(record, encryptionKey) : null;
    },
    async getById(ownerEmail, connectionId) {
      const record = await repository.findConnectionByIdAndOwner(requireId(connectionId), normalizeOwner(ownerEmail));
      return record ? toConnection(record, encryptionKey) : null;
    },
    async acquireRenewalLease(ownerEmail, connectionId, leaseId, leaseExpiresAt, acquiredAt) {
      const record = await repository.acquireRenewalLease(
        requireId(connectionId), normalizeOwner(ownerEmail), requireId(leaseId), toDate(leaseExpiresAt), toDate(acquiredAt),
      );
      return record ? toConnection(record, encryptionKey) : null;
    },
    async completeRenewalLease(ownerEmail, connectionId, leaseId, credentials) {
      const record = await repository.completeRenewalLease(requireId(connectionId), normalizeOwner(ownerEmail), requireId(leaseId), {
        encryptedCredentials: encryptJson(requireCredentials(credentials), encryptionKey),
        credentialExpiresAt: toDateOrNull(credentials?.expiresAt ?? credentials?.credentialExpiresAt), updatedAt: new Date(),
      });
      return record ? toConnection(record, encryptionKey) : null;
    },
    async releaseRenewalLease(ownerEmail, connectionId, leaseId) {
      return Boolean(await repository.releaseRenewalLease(requireId(connectionId), normalizeOwner(ownerEmail), requireId(leaseId)));
    },
    async markNeedsReconnect(ownerEmail, connectionId) {
      const record = await repository.markConnectionNeedsReconnect(requireId(connectionId), normalizeOwner(ownerEmail), new Date());
      return record ? toConnection(record, encryptionKey) : null;
    },
    async disconnectDefault(ownerEmail, platform) {
      const result = await repository.disconnectActiveConnection(
        normalizeOwner(ownerEmail), requirePlatform(platform), encryptJson({}, encryptionKey), new Date(),
      );
      if (result.status !== "disconnected") return result;
      return { status: "disconnected", credentials: decryptJson(result.connection.encryptedCredentials, encryptionKey) };
    },
    async listAvailability(ownerEmail) {
      return (await repository.listConnectionAvailability(normalizeOwner(ownerEmail))).map(toAvailability);
    },
  };
}

function toNewRecord(ownerEmail, input, encryptionKey) {
  const now = new Date();
  return {
    id: crypto.randomUUID(), ownerEmail: normalizeOwner(ownerEmail), platform: requirePlatform(input?.platform),
    displayName: requireDisplayName(input?.displayName), state: "active",
    encryptedCredentials: encryptJson(requireCredentials(input?.credentials), encryptionKey),
    credentialExpiresAt: toDateOrNull(input?.expiresAt ?? input?.credentialExpiresAt), createdAt: now, updatedAt: now,
  };
}

function toConnection(record, encryptionKey) {
  return { id: record.id, ownerEmail: record.ownerEmail, platform: record.platform, displayName: record.displayName,
    state: record.state, credentials: decryptConnectionCredentials(record.encryptedCredentials, encryptionKey), expiresAt: record.credentialExpiresAt ?? null,
    createdAt: record.createdAt, updatedAt: record.updatedAt };
}
function decryptConnectionCredentials(encryptedCredentials, encryptionKey) {
  try {
    return decryptJson(encryptedCredentials, encryptionKey);
  } catch {
    throw permanentConnectionFailureError();
  }
}
function toAvailability(record) { return { platform: record.platform, state: record.state, displayName: record.displayName, expiresAt: record.credentialExpiresAt ?? null }; }
function normalizeOwner(ownerEmail) { const value = String(ownerEmail ?? "").trim().toLowerCase(); if (!value) throw new Error("A connection owner is required."); return value; }
function requirePlatform(platform) { const value = String(platform ?? "").trim().toLowerCase(); if (!PLATFORMS.has(value)) throw new Error("Unsupported platform connection."); return value; }
function requireDisplayName(displayName) { const value = String(displayName ?? "").trim(); if (!value) throw new Error("A connection display name is required."); return value; }
function requireCredentials(credentials) { if (!credentials || typeof credentials !== "object" || Array.isArray(credentials)) throw new Error("Connection credentials are required."); return credentials; }
function requireId(connectionId) { const value = String(connectionId ?? "").trim(); if (!value) throw new Error("A platform connection is required."); return value; }
function toDateOrNull(value) { if (value == null) return null; const date = value instanceof Date ? value : new Date(value); if (Number.isNaN(date.getTime())) throw new Error("Connection credential expiry must be a valid date."); return date; }
function toDate(value) { if (value == null) throw new Error("A connection update time is required."); return toDateOrNull(value); }
