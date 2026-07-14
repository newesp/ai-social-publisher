export const WIZARD_DRAFT_KEY = "ai-social-publisher:wizard-draft";

const WIZARD_DRAFT_VERSION = 2;

export function readWizardDraft(storage, owner) {
  try {
    const targetStorage = storage ?? getBrowserStorage();
    if (!targetStorage) return null;

    const value = targetStorage.getItem(getWizardDraftKey(owner));
    if (!value) return null;

    const parsed = JSON.parse(value);
    if (
      parsed?.version !== WIZARD_DRAFT_VERSION
      || parsed.owner !== normalizeOwner(owner)
      || !isRecord(parsed.snapshot)
    ) return null;

    return normalizeTransientStates(parsed.snapshot);
  } catch {
    return null;
  }
}

export function writeWizardDraft(storage, snapshot, owner) {
  try {
    const targetStorage = storage ?? getBrowserStorage();
    if (!targetStorage || !isRecord(snapshot)) return false;

    targetStorage.setItem(getWizardDraftKey(owner), JSON.stringify({
      version: WIZARD_DRAFT_VERSION,
      owner: normalizeOwner(owner),
      snapshot: normalizeTransientStates(snapshot),
    }));
    return true;
  } catch {
    return false;
  }
}

export function normalizeWizardDraftOwner(owner) {
  return normalizeOwner(owner);
}

export function getWizardDraftKey(owner) {
  return `${WIZARD_DRAFT_KEY}:${encodeURIComponent(normalizeOwner(owner))}`;
}

export function clearWizardDraft(storage, owner) {
  try {
    const targetStorage = storage ?? getBrowserStorage();
    if (!targetStorage) return false;
    targetStorage.removeItem(getWizardDraftKey(owner));
    return true;
  } catch {
    return false;
  }
}

function normalizeTransientStates(snapshot) {
  const transientPublishStatuses = new Set(["loading", "checking", "publishing"]);
  return {
    ...snapshot,
    ...(snapshot.generationStatus === "loading" ? { generationStatus: "idle" } : {}),
    ...(transientPublishStatuses.has(snapshot.publishStatus) ? { publishStatus: "idle" } : {}),
  };
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeOwner(owner) {
  return typeof owner === "string" && owner.trim()
    ? owner.trim().toLowerCase()
    : "anonymous";
}

function getBrowserStorage() {
  if (typeof window === "undefined") return null;
  return window.sessionStorage;
}
