const CONTENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_BATCHES = 10;

export function createSupportRetentionService({
  repository,
  now = () => new Date(),
  batchSize = 100,
  maxBatches = DEFAULT_MAX_BATCHES,
}) {
  if (!repository || typeof repository.clearExpiredSupportContent !== "function") {
    throw new TypeError("A support retention repository is required.");
  }
  requirePositiveInteger(batchSize, "Retention batch size");
  requirePositiveInteger(maxBatches, "Retention max batches");

  return {
    async purgeExpiredContent() {
      const current = validDate(now());
      const contentBefore = new Date(current.getTime() - CONTENT_RETENTION_MS);
      let messagesCleared = 0;
      let replyTokensCleared = 0;
      let outboundBodiesCleared = 0;
      let changed;
      let batches = 0;
      do {
        changed = safeCounts(await repository.clearExpiredSupportContent({
          contentBefore,
          replyTokenBefore: current,
          batchSize,
        }));
        messagesCleared += changed.messagesCleared;
        replyTokensCleared += changed.replyTokensCleared;
        outboundBodiesCleared += changed.outboundBodiesCleared;
        batches += 1;
      } while (batches < maxBatches && (
        changed.messagesCleared === batchSize
        || changed.replyTokensCleared === batchSize
        || changed.outboundBodiesCleared === batchSize
      ));
      return { messagesCleared, replyTokensCleared, outboundBodiesCleared };
    },
  };
}

function validDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError("Retention cleanup requires a valid timestamp.");
  return date;
}

function safeCounts(value) {
  return {
    messagesCleared: safeCount(value?.messagesCleared),
    replyTokensCleared: safeCount(value?.replyTokensCleared),
    outboundBodiesCleared: safeCount(value?.outboundBodiesCleared),
  };
}

function requirePositiveInteger(value, label) {
  if (!Number.isInteger(value) || value < 1 || value > 1_000) {
    throw new TypeError(`${label} must be an integer from 1 to 1000.`);
  }
}

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
