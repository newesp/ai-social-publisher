import crypto from "node:crypto";

import { getLLMModelOptions } from "../ai/model-config.js";
import { normalizeEmail } from "../auth/policy.js";
import { createDbClient } from "../db/index.js";
import { createLineSupportAdapter } from "./channel-adapters/line-support-adapter.js";
import { createSupportRepository } from "./support-repository.js";

const CONFIGURATION_KEYS = Object.freeze([
  "platformConnectionId",
  "brandName",
  "assistantName",
  "replyTone",
  "llmProvider",
  "llmModel",
  "redeliveryAcknowledged",
  "nativeRepliesDisabledAcknowledged",
]);
const BROWSER_CONFIGURATION_KEYS = Object.freeze(
  CONFIGURATION_KEYS.filter((key) => key !== "platformConnectionId"),
);
const FAQ_KEYS = Object.freeze(["question", "answer", "category", "keywords", "enabled", "priority"]);
const REPLY_TONES = new Set(["friendly", "professional", "concise"]);
const LLM_PROVIDERS = new Set(["google", "openai"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WEBHOOK_HASH_PATTERN = /^[a-f0-9]{64}$/;
const INBOX_STATUSES = new Set(["ai_active", "waiting_human", "human_active", "resolved", "return_to_ai_pending", "resolve_pending"]);
const INBOX_PAGE_SIZE = 30;

export function createSupportStore({
  repository,
  encryptionKey,
  modelOptions = getLLMModelOptions,
  now = () => new Date(),
  randomUUID = () => crypto.randomUUID(),
  lineAdapter = createLineSupportAdapter(),
}) {
  requireText(encryptionKey, "SETTINGS_ENCRYPTION_KEY", 500);

  async function mutateReadiness(ownerEmail, connectionId, changes, {
    expectedVersion,
    expectedWebhookKeyHash,
  } = {}) {
    const owner = requireOwner(ownerEmail);
    const id = requireText(connectionId, "Platform connection ID");
    const current = await repository.getConfiguration(owner);
    if (!current || current.platformConnectionId !== id) throw notFound();
    if (expectedVersion != null && current.version !== expectedVersion) throw versionConflict();
    if (expectedWebhookKeyHash != null && current.webhookKeyHash !== expectedWebhookKeyHash) {
      throw versionConflict();
    }
    const timestamp = now();
    const updated = await repository.updateConfiguration(owner, current.id, {
      ...changes(current, timestamp),
      version: current.version + 1,
      updatedAt: timestamp,
    }, {
      expectedVersion: current.version,
      ...(expectedWebhookKeyHash == null ? {} : { expectedWebhookKeyHash }),
    });
    if (!updated) {
      throw versionConflict();
    }
    return toConfiguration(updated);
  }

  async function deliverHumanMessage(owner, conversationId, prepared) {
    if (!prepared) return null;
    if (prepared.deliveryStatus === "sent") return toHumanMessage(prepared);
    let response;
    try {
      const accessToken = await repository.loadLineAccessToken(prepared.connectionId);
      response = await lineAdapter.pushCanonical({
        accessToken,
        canonicalBody: prepared.canonicalBody,
        retryKey: prepared.retryKey,
      });
    } catch {
      return toHumanMessage(await repository.markHumanMessageDelivery(
        owner,
        prepared.id,
        "failed",
        "line_push_transport",
        now(),
      ));
    }
    const status = Number(response?.status);
    const acceptedRequestId = response?.headers?.["x-line-accepted-request-id"] || "";
    const accepted = (status >= 200 && status < 300)
      || (status === 409 && acceptedRequestId);
    if (status === 401 && typeof repository.markOwnedLineConnectionNeedsReconnect === "function") {
      await repository.markOwnedLineConnectionNeedsReconnect(
        owner,
        prepared.connectionId,
        conversationId,
        now(),
      );
    }
    return toHumanMessage(await repository.markHumanMessageDelivery(
      owner,
      prepared.id,
      accepted ? "sent" : "failed",
      accepted ? null : safePushFailure(status),
      now(),
    ));
  }

  async function persistConfiguration(owner, configuration) {
    const timestamp = now();
    const current = await repository.getConfiguration(owner);
    const values = {
      platformConnectionId: configuration.platformConnectionId,
      brandName: configuration.brandName,
      assistantName: configuration.assistantName,
      replyTone: configuration.replyTone,
      llmProvider: configuration.llmProvider,
      llmModel: configuration.llmModel,
      redeliveryAcknowledgedAt: timestamp,
      nativeRepliesDisabledAcknowledgedAt: timestamp,
      updatedAt: timestamp,
    };

    if (current) {
      const connectionChanged = current.platformConnectionId !== configuration.platformConnectionId;
      const providerChanged = current.llmProvider !== configuration.llmProvider
        || current.llmModel !== configuration.llmModel;
      const updated = await repository.updateConfiguration(owner, current.id, {
        ...values,
        ...(connectionChanged ? {
          supportState: "disabled",
          webhookKeyHash: null,
          webhookVerifiedAt: null,
          providerTestedAt: null,
        } : {}),
        ...(providerChanged ? {
          supportState: "disabled",
          providerTestedAt: null,
        } : {}),
        version: current.version + 1,
      }, { expectedVersion: current.version });
      if (!updated) throw versionConflict();
      return toConfiguration(updated);
    }

    const created = await repository.createConfiguration(owner, {
      id: randomUUID(),
      ...values,
      supportState: "disabled",
      webhookKeyHash: null,
      webhookVerifiedAt: null,
      providerTestedAt: null,
      version: 0,
      createdAt: timestamp,
    });
    if (!created) throw notFound();
    return toConfiguration(created);
  }

  return {
    async getConfiguration(ownerEmail) {
      const record = await repository.getConfiguration(requireOwner(ownerEmail));
      return record ? toConfiguration(record) : null;
    },

    async updateConfiguration(ownerEmail, input) {
      const owner = requireOwner(ownerEmail);
      const configuration = validateConfiguration(input, modelOptions);
      const connection = await repository.findOwnedLineConnection(owner, configuration.platformConnectionId);
      if (!connection) throw notFound();
      return persistConfiguration(owner, configuration);
    },

    async updateConfigurationForActiveDefault(ownerEmail, input) {
      const owner = requireOwner(ownerEmail);
      requirePlainObject(input, "Configuration");
      requireExactKeys(input, BROWSER_CONFIGURATION_KEYS, "Configuration");
      const connection = await repository.findActiveLineConnection(owner);
      if (!connection?.id) throw noActiveLineConnection();
      const configuration = validateConfiguration({
        ...input,
        platformConnectionId: connection.id,
      }, modelOptions);
      return persistConfiguration(owner, configuration);
    },

    async prepareWebhook(ownerEmail, connectionId, webhookKeyHash) {
      const owner = requireOwner(ownerEmail);
      const id = requireText(connectionId, "Platform connection ID");
      if (!UUID_PATTERN.test(id)) throw badRequest("Platform connection ID must be a UUID.");
      if (typeof webhookKeyHash !== "string" || !WEBHOOK_HASH_PATTERN.test(webhookKeyHash)) {
        throw badRequest("Webhook key hash is invalid.");
      }
      if (!await repository.findOwnedLineConnection(owner, id)) throw notFound();

      const timestamp = now();
      const current = await repository.getConfiguration(owner);
      if (current) {
        const connectionChanged = current.platformConnectionId !== id;
        const updated = await repository.updateConfiguration(owner, current.id, {
          platformConnectionId: id,
          supportState: "disabled",
          webhookKeyHash,
          webhookVerifiedAt: null,
          ...(connectionChanged ? { providerTestedAt: null } : {}),
          version: current.version + 1,
          updatedAt: timestamp,
        }, { expectedVersion: current.version });
        if (!updated) throw versionConflict();
        return toConfiguration(updated);
      }

      const created = await repository.createConfiguration(owner, {
        id: randomUUID(),
        platformConnectionId: id,
        brandName: "",
        assistantName: "",
        replyTone: "friendly",
        llmProvider: null,
        llmModel: null,
        supportState: "disabled",
        webhookKeyHash,
        webhookVerifiedAt: null,
        redeliveryAcknowledgedAt: null,
        nativeRepliesDisabledAcknowledgedAt: null,
        providerTestedAt: null,
        version: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      if (!created) throw notFound();
      return toConfiguration(created);
    },

    async recordWebhookVerification(ownerEmail, connectionId, verified, {
      expectedVersion,
      expectedWebhookKeyHash,
    } = {}) {
      if (typeof verified !== "boolean") throw badRequest("Webhook verification must be a boolean.");
      if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
        throw badRequest("Expected configuration version is required.");
      }
      if (typeof expectedWebhookKeyHash !== "string"
        || !WEBHOOK_HASH_PATTERN.test(expectedWebhookKeyHash)) {
        throw badRequest("Expected webhook key hash is required.");
      }
      return mutateReadiness(
        ownerEmail,
        connectionId,
        (current, timestamp) => ({
          webhookVerifiedAt: verified ? timestamp : null,
          ...(!verified ? { supportState: "disabled" } : {}),
        }),
        { expectedVersion, expectedWebhookKeyHash },
      );
    },

    async recordProviderTest(ownerEmail, connectionId, tested, { expectedVersion } = {}) {
      if (typeof tested !== "boolean") throw badRequest("Provider test state must be a boolean.");
      if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
        throw badRequest("Expected configuration version is required.");
      }
      return mutateReadiness(
        ownerEmail,
        connectionId,
        (current, timestamp) => ({
          providerTestedAt: tested ? timestamp : null,
          ...(!tested ? { supportState: "disabled" } : {}),
        }),
        { expectedVersion },
      );
    },

    async enableIfReady(ownerEmail, connectionId) {
      const owner = requireOwner(ownerEmail);
      const id = requireText(connectionId, "Platform connection ID");
      const enabled = await repository.enableConfigurationIfReady(owner, id, now());
      if (!enabled) throw supportNotReady();
      return toConfiguration(enabled);
    },

    async setSupportState(ownerEmail, connectionId, state) {
      if (state !== "disabled") {
        throw badRequest("Support state is invalid.");
      }
      return mutateReadiness(
        ownerEmail,
        connectionId,
        () => ({ supportState: state }),
      );
    },

    async listFaqs(ownerEmail) {
      return (await repository.listFaqs(requireOwner(ownerEmail))).map(toFaq);
    },

    async createFaq(ownerEmail, input) {
      const owner = requireOwner(ownerEmail);
      const faq = validateFaq(input, { partial: false });
      const timestamp = now();
      return toFaq(await repository.createFaq(owner, {
        id: randomUUID(),
        ...toStoredFaq(faq),
        createdAt: timestamp,
        updatedAt: timestamp,
      }));
    },

    async updateFaq(ownerEmail, id, input) {
      const owner = requireOwner(ownerEmail);
      const faqId = requireText(id, "FAQ ID");
      const changes = validateFaq(input, { partial: true });
      const updated = await repository.updateFaq(owner, faqId, {
        ...toStoredFaq(changes),
        updatedAt: now(),
      });
      if (!updated) throw notFound();
      return toFaq(updated);
    },

    async deleteFaq(ownerEmail, id) {
      const deleted = await repository.deleteFaq(
        requireOwner(ownerEmail),
        requireText(id, "FAQ ID"),
      );
      if (!deleted) throw notFound();
      return toFaq(deleted);
    },

    async listConversations(ownerEmail, { status, cursor } = {}) {
      const owner = requireOwner(ownerEmail);
      if (status != null && !INBOX_STATUSES.has(status)) throw badRequest("Conversation status is invalid.");
      const repositoryCursor = decodeInboxCursor(cursor, owner, status, encryptionKey);
      const [records, attentionCount] = await Promise.all([
        repository.listInboxConversations(owner, { status, cursor: repositoryCursor }),
        repository.countInboxAttention(owner),
      ]);
      const conversations = records.slice(0, INBOX_PAGE_SIZE).map(toInboxSummary);
      const next = records.length > INBOX_PAGE_SIZE ? records[INBOX_PAGE_SIZE - 1] : null;
      return {
        conversations,
        nextCursor: next ? encodeInboxCursor(next, owner, status, encryptionKey) : null,
        attentionCount,
      };
    },

    async listActivePendingTransitions(ownerEmail) {
      const transitions = await repository.listActivePendingSupportTransitions(requireOwner(ownerEmail));
      return Array.isArray(transitions) ? transitions.map((transition) => ({
        id: transition.id, conversationId: transition.conversationId, action: transition.action,
        effectiveAt: transition.effectiveAt, customerLabel: "Customer",
      })) : [];
    },

    async getConversation(ownerEmail, id) {
      const record = await repository.getInboxConversation(requireOwner(ownerEmail), requireText(id, "Conversation ID"));
      return record ? toInboxConversation(record) : null;
    },

    async markConversationRead(ownerEmail, id) {
      return repository.markInboxConversationRead(requireOwner(ownerEmail), requireText(id, "Conversation ID"));
    },

    async takeOver(ownerEmail, id, expectedVersion) {
      const result = await repository.takeOverSupportConversation(requireOwner(ownerEmail), requireText(id, "Conversation ID"), requiredConversationVersion(expectedVersion), now());
      return result ? toActionConversation(result) : null;
    },

    async sendHumanMessage(ownerEmail, id, input) {
      const owner = requireOwner(ownerEmail);
      const conversationId = requireText(id, "Conversation ID");
      const message = validateHumanMessage(input);
      const prepared = await repository.prepareHumanMessage(owner, conversationId, message, now());
      return deliverHumanMessage(owner, conversationId, prepared);
    },

    async retryHumanMessage(ownerEmail, messageId) {
      const owner = requireOwner(ownerEmail);
      const id = requireText(messageId, "Human message ID");
      const prepared = await repository.prepareHumanMessageRetry(owner, id, now());
      return deliverHumanMessage(owner, prepared?.conversationId, prepared);
    },

    async requestTransition(ownerEmail, id, action, expectedVersion) {
      if (action !== "return_to_ai" && action !== "resolve") throw badRequest("Support transition action is invalid.");
      const transition = await repository.requestSupportTransition(
        requireOwner(ownerEmail), requireText(id, "Conversation ID"), action, requiredConversationVersion(expectedVersion), now(), randomUUID(),
      );
      return transition ? { id: transition.id, conversationId: transition.conversationId, action: transition.requestedAction, effectiveAt: transition.effectiveAt } : null;
    },

    async undoTransition(ownerEmail, id, transitionId) {
      const result = await repository.undoSupportTransition(requireOwner(ownerEmail), requireText(id, "Conversation ID"), requireText(transitionId, "Transition ID"), now());
      return result ? toActionConversation(result) : null;
    },

    async recoverTransitionStartFailure(ownerEmail, id, transitionId) {
      const result = await repository.undoSupportTransition(requireOwner(ownerEmail), requireText(id, "Conversation ID"), requireText(transitionId, "Transition ID"), now());
      return result ? toActionConversation(result) : null;
    },
  };
}

export function getSupportStore(env = process.env) {
  return createSupportStore({
    repository: createSupportRepository(createDbClient(env), {
      encryptionKey: env.SETTINGS_ENCRYPTION_KEY,
      modelOptions: getLLMModelOptions,
    }),
    encryptionKey: env.SETTINGS_ENCRYPTION_KEY,
    modelOptions: getLLMModelOptions,
  });
}

function validateConfiguration(input, modelOptions) {
  requirePlainObject(input, "Configuration");
  requireExactKeys(input, CONFIGURATION_KEYS, "Configuration");

  const platformConnectionId = requireText(input.platformConnectionId, "Platform connection ID");
  if (!UUID_PATTERN.test(platformConnectionId)) throw badRequest("Platform connection ID must be a UUID.");
  const brandName = boundedRequiredText(input.brandName, "Brand name", 80);
  const assistantName = boundedRequiredText(input.assistantName, "Assistant name", 40);
  const replyTone = requireText(input.replyTone, "Reply tone");
  if (!REPLY_TONES.has(replyTone)) throw badRequest("Reply tone is invalid.");
  const llmProvider = requireText(input.llmProvider, "LLM provider");
  if (!LLM_PROVIDERS.has(llmProvider)) throw badRequest("LLM provider is invalid.");
  const llmModel = requireText(input.llmModel, "LLM model");
  const options = typeof modelOptions === "function" ? modelOptions(llmProvider) : modelOptions?.[llmProvider];
  if (!Array.isArray(options) || !options.includes(llmModel)) throw badRequest("LLM model is invalid.");
  if (input.redeliveryAcknowledged !== true) throw badRequest("LINE redelivery acknowledgement is required.");
  if (input.nativeRepliesDisabledAcknowledged !== true) {
    throw badRequest("LINE native replies acknowledgement is required.");
  }

  return {
    platformConnectionId,
    brandName,
    assistantName,
    replyTone,
    llmProvider,
    llmModel,
  };
}

function validateFaq(input, { partial }) {
  requirePlainObject(input, "FAQ");
  const inputKeys = Object.keys(input);
  if (inputKeys.some((key) => !FAQ_KEYS.includes(key))) throw badRequest("FAQ contains unsupported fields.");
  if (partial && inputKeys.length === 0) throw badRequest("At least one FAQ field is required.");
  const has = (key) => Object.hasOwn(input, key);

  const faq = {};
  if (!partial || has("question")) {
    faq.question = boundedRequiredText(input.question, "FAQ question", 500);
  }
  if (!partial || has("answer")) {
    faq.answer = boundedRequiredText(input.answer, "FAQ answer", 4_000);
  }
  if (has("category")) {
    faq.category = boundedOptionalText(input.category, "FAQ category", 80);
  } else if (!partial) {
    faq.category = "";
  }
  if (has("keywords")) {
    faq.keywords = validateKeywords(input.keywords);
  } else if (!partial) {
    faq.keywords = [];
  }
  if (has("enabled")) {
    if (typeof input.enabled !== "boolean") throw badRequest("FAQ enabled must be a boolean.");
    faq.enabled = input.enabled;
  } else if (!partial) {
    faq.enabled = true;
  }
  if (has("priority")) {
    if (!Number.isInteger(input.priority) || input.priority < -100 || input.priority > 100) {
      throw badRequest("FAQ priority must be an integer from -100 to 100.");
    }
    faq.priority = input.priority;
  } else if (!partial) {
    faq.priority = 0;
  }
  return faq;
}

function validateKeywords(value) {
  if (!Array.isArray(value)) {
    throw badRequest("FAQ keywords must contain at most 20 strings.");
  }
  const deduplicated = [];
  const seen = new Set();
  for (const candidate of value) {
    if (typeof candidate !== "string") throw badRequest("FAQ keywords must be strings.");
    const keyword = candidate.trim();
    if (!keyword || keyword.length > 80) throw badRequest("FAQ keywords must be 1 to 80 characters.");
    const normalized = keyword.toLowerCase();
    if (!seen.has(normalized)) {
      seen.add(normalized);
      deduplicated.push(keyword);
    }
  }
  if (deduplicated.length > 20) throw badRequest("FAQ keywords must contain at most 20 strings.");
  return deduplicated;
}

function toStoredFaq(faq) {
  const stored = { ...faq };
  if (Object.hasOwn(stored, "keywords")) {
    stored.keywordsJson = JSON.stringify(stored.keywords);
    delete stored.keywords;
  }
  return stored;
}

function toConfiguration(record) {
  return {
    id: record.id,
    platformConnectionId: record.platformConnectionId,
    brandName: record.brandName,
    assistantName: record.assistantName,
    replyTone: record.replyTone,
    llmProvider: record.llmProvider,
    llmModel: record.llmModel,
    supportState: record.supportState,
    webhookVerified: Boolean(record.webhookVerifiedAt),
    redeliveryAcknowledged: Boolean(record.redeliveryAcknowledgedAt),
    nativeRepliesDisabledAcknowledged: Boolean(record.nativeRepliesDisabledAcknowledgedAt),
    providerTested: Boolean(record.providerTestedAt),
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function toFaq(record) {
  return {
    id: record.id,
    question: record.question,
    answer: record.answer,
    category: record.category,
    keywords: parseStringArray(record.keywordsJson),
    enabled: Boolean(record.enabled),
    priority: record.priority,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function parseStringArray(value) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : [];
  } catch {
    return [];
  }
}

function toInboxSummary(record) {
  return {
    id: record.id, customerLabel: "Customer", status: record.status, unreadCount: record.unreadCount,
    handoffReason: record.handoffReason, lastMessagePreview: record.lastMessagePreview, deliveryFailed: record.deliveryFailed === true,
    lastInboundAt: record.lastInboundAt, lastOutboundAt: record.lastOutboundAt, updatedAt: record.updatedAt,
    pendingTransition: record.pendingTransition ? { id: record.pendingTransition.id, action: record.pendingTransition.action, effectiveAt: record.pendingTransition.effectiveAt } : null,
  };
}

function toInboxConversation(record) {
  return {
    ...toInboxSummary(record),
    version: Number.isInteger(record.version) ? record.version : 0,
    messages: Array.isArray(record.messages) ? record.messages.map((message) => ({
      id: message.id, direction: message.direction, senderType: message.senderType, messageType: message.messageType,
      text: message.text, deliveryStatus: message.deliveryStatus, safeErrorCode: message.safeErrorCode,
      createdAt: message.createdAt, sentAt: message.sentAt, failedAt: message.failedAt,
    })) : [],
    decisions: Array.isArray(record.decisions) ? record.decisions.map((decision) => ({
      id: decision.id, action: decision.action, category: decision.category, reasonCode: decision.reasonCode,
      faqSourceIds: Array.isArray(decision.faqSourceIds) ? decision.faqSourceIds : [], createdAt: decision.createdAt,
    })) : [],
    faqSources: Array.isArray(record.faqSources) ? record.faqSources.map((faq) => ({ id: faq.id, question: faq.question, category: faq.category })) : [],
    pendingTransition: record.pendingTransition ? { id: record.pendingTransition.id, action: record.pendingTransition.action, effectiveAt: record.pendingTransition.effectiveAt } : null,
  };
}

function requiredConversationVersion(value) { if (!Number.isInteger(value) || value < 0) throw badRequest("Expected conversation version is required."); return value; }
function validateHumanMessage(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw badRequest("Human reply is invalid.");
  const text = boundedRequiredText(input.text, "Human reply", 5_000);
  const idempotencyKey = boundedRequiredText(input.idempotencyKey, "Human reply key", 100);
  return { text, idempotencyKey };
}
function safePushFailure(status) { return status >= 500 && status < 600 ? "line_push_5xx" : "line_push_4xx"; }
function toActionConversation(value) { return { id: value.id, status: value.status, version: value.version }; }
function toHumanMessage(value) { return { id: value?.id ?? "", deliveryStatus: value?.deliveryStatus ?? "failed", safeErrorCode: value?.safeErrorCode ?? "line_push_transport" }; }

function encodeInboxCursor(record, owner, status, encryptionKey) {
  const payload = {
    version: 1,
    updatedAt: dateCursorValue(record.updatedAt),
    id: record.id,
  };
  return Buffer.from(JSON.stringify({
    ...payload,
    signature: inboxCursorSignature(payload, owner, status, encryptionKey),
  }), "utf8").toString("base64url");
}

function decodeInboxCursor(cursor, owner, status, encryptionKey) {
  if (cursor == null) return null;
  if (typeof cursor !== "string" || cursor.length > 500) throw badRequest("Conversation cursor is invalid.");
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    const payload = {
      version: value.version,
      updatedAt: value.updatedAt,
      id: value.id,
    };
    if (payload.version !== 1
      || !Number.isSafeInteger(payload.updatedAt) || payload.updatedAt < 0
      || typeof payload.id !== "string" || !payload.id || payload.id.length > 100
      || typeof value.signature !== "string") {
      throw new Error("invalid");
    }
    const expected = inboxCursorSignature(payload, owner, status, encryptionKey);
    const signature = Buffer.from(value.signature, "utf8");
    const expectedSignature = Buffer.from(expected, "utf8");
    if (signature.length !== expectedSignature.length
      || !crypto.timingSafeEqual(signature, expectedSignature)) {
      throw new Error("scope");
    }
    return {
      updatedAt: payload.updatedAt,
      id: payload.id,
    };
  } catch {
    throw badRequest("Conversation cursor is invalid.");
  }
}

function inboxCursorSignature(payload, owner, status, encryptionKey) {
  return crypto.createHmac("sha256", encryptionKey)
    .update(JSON.stringify([owner, status ?? null, payload]))
    .digest("base64url");
}

function dateCursorValue(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function requireOwner(ownerEmail) {
  const owner = normalizeEmail(ownerEmail);
  if (!owner) throw routeError("Authentication is required.", 401);
  return owner;
}

function requireExactKeys(input, keys, label) {
  const actual = Object.keys(input);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) {
    throw badRequest(`${label} contains unsupported or missing fields.`);
  }
}

function requirePlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw badRequest(`${label} must be an object.`);
}

function boundedRequiredText(value, label, maxLength) {
  const text = requireText(value, label);
  if (text.length > maxLength) throw badRequest(`${label} must be at most ${maxLength} characters.`);
  return text;
}

function boundedOptionalText(value, label, maxLength) {
  if (typeof value !== "string") throw badRequest(`${label} must be a string.`);
  const text = value.trim();
  if (text.length > maxLength) throw badRequest(`${label} must be at most ${maxLength} characters.`);
  return text;
}

function requireText(value, label, status = 400) {
  if (typeof value !== "string") throw routeError(`${label} is required.`, status);
  const text = value.trim();
  if (!text) throw routeError(`${label} is required.`, status);
  return text;
}

function badRequest(message) {
  return routeError(message, 400);
}

function notFound() {
  return routeError("Support resource not found.", 404);
}

function versionConflict() {
  return routeError("Support configuration changed. Refresh readiness and try again.", 409);
}

function noActiveLineConnection() {
  return routeError("Connect LINE before saving support settings.", 409);
}

function supportNotReady() {
  return routeError("AI support is not ready to be enabled.", 409);
}

function routeError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}
