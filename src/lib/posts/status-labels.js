const STATUS_LABELS = Object.freeze({
  draft: "草稿",
  scheduled: "已排程",
  publishing: "發布中",
  published: "已發布",
  partial_failed: "部分失敗",
  failed: "失敗",
  cancelled: "已取消",
});

const PLATFORM_LABELS = Object.freeze({
  meta: "Meta",
  instagram: "Instagram",
  line: "LINE",
  system: "系統",
});

export function getStatusLabel(status) {
  return STATUS_LABELS[status] ?? status ?? "未知";
}

export function getPlatformLabel(platform) {
  return PLATFORM_LABELS[platform] ?? platform ?? "未知";
}
