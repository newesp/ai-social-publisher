export const POST_STATUS = Object.freeze({
  DRAFT: "draft",
  SCHEDULED: "scheduled",
  PUBLISHING: "publishing",
  PUBLISHED: "published",
  PARTIAL_FAILED: "partial_failed",
  FAILED: "failed",
  CANCELLED: "cancelled",
});

export function resolvePostStatus(targets) {
  if (targets.every((target) => target.status === POST_STATUS.PUBLISHED)) {
    return POST_STATUS.PUBLISHED;
  }
  if (targets.some((target) => target.status === POST_STATUS.PUBLISHED)) {
    return POST_STATUS.PARTIAL_FAILED;
  }
  return POST_STATUS.FAILED;
}
