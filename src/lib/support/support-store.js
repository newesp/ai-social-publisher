import crypto from "node:crypto";

import { getLLMModelOptions } from "../ai/model-config.js";
import { normalizeEmail } from "../auth/policy.js";
import { createDbClient } from "../db/index.js";
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
const FAQ_KEYS = Object.freeze(["question", "answer", "category", "keywords", "enabled", "priority"]);
const REPLY_TONES = new Set(["friendly", "professional", "concise"]);
const LLM_PROVIDERS = new Set(["google", "openai"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createSupportStore({
  repository,
  encryptionKey,
  modelOptions = getLLMModelOptions,
  now = () => new Date(),
  randomUUID = () => crypto.randomUUID(),
}) {
  requireText(encryptionKey, "SETTINGS_ENCRYPTION_KEY", 500);

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
        });
        if (!updated) throw notFound();
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
  };
}

export function getSupportStore(env = process.env) {
  return createSupportStore({
    repository: createSupportRepository(createDbClient(env)),
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

  const faq = {};
  if (!partial || Object.hasOwn(input, "question")) {
    faq.question = boundedRequiredText(input.question, "FAQ question", 500);
  }
  if (!partial || Object.hasOwn(input, "answer")) {
    faq.answer = boundedRequiredText(input.answer, "FAQ answer", 4_000);
  }
  if (!partial || Object.hasOwn(input, "category")) {
    faq.category = boundedOptionalText(input.category, "FAQ category", 80);
  }
  if (!partial || Object.hasOwn(input, "keywords")) {
    faq.keywords = validateKeywords(input.keywords);
  }
  if (!partial || Object.hasOwn(input, "enabled")) {
    const enabled = input.enabled ?? true;
    if (typeof enabled !== "boolean") throw badRequest("FAQ enabled must be a boolean.");
    faq.enabled = enabled;
  }
  if (!partial || Object.hasOwn(input, "priority")) {
    const priority = input.priority ?? 0;
    if (!Number.isInteger(priority) || priority < -100 || priority > 100) {
      throw badRequest("FAQ priority must be an integer from -100 to 100.");
    }
    faq.priority = priority;
  }
  return faq;
}

function validateKeywords(value) {
  const keywords = value ?? [];
  if (!Array.isArray(keywords) || keywords.length > 20) {
    throw badRequest("FAQ keywords must contain at most 20 strings.");
  }
  const deduplicated = [];
  const seen = new Set();
  for (const value of keywords) {
    if (typeof value !== "string") throw badRequest("FAQ keywords must be strings.");
    const keyword = value.trim();
    if (!keyword || keyword.length > 80) throw badRequest("FAQ keywords must be 1 to 80 characters.");
    const normalized = keyword.toLowerCase();
    if (!seen.has(normalized)) {
      seen.add(normalized);
      deduplicated.push(keyword);
    }
  }
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
  const text = String(value ?? "").trim();
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

function routeError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}
