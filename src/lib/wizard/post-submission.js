export const SCHEDULE_TIME = "09:00";

export function buildPostSubmission({ form, targets, imageUrl = null, now = new Date() }) {
  const mode = form.mode === "scheduled" ? "scheduled" : "now";
  const payload = {
    productName: String(form.productName ?? ""),
    productFeatures: String(form.productFeatures ?? ""),
    imageUrl,
    mode,
    targets: Array.isArray(targets) ? targets.map((target) => ({
      platform: target.platform,
      content: String(target.content ?? ""),
      hashtags: Array.isArray(target.hashtags) ? target.hashtags : [],
    })) : [],
  };

  if (mode === "scheduled") {
    const scheduledTime = form.scheduledTime ?? SCHEDULE_TIME;
    if (scheduledTime !== SCHEDULE_TIME) {
      throw new Error(`排程時間必須為 ${SCHEDULE_TIME}。`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(form.scheduledDate ?? ""))) {
      throw new Error("請選擇排程日期。");
    }
    if (form.scheduledDate < taipeiDate(now)) {
      throw new Error("排程日期不能早於今天。");
    }
    payload.scheduledDate = form.scheduledDate;
    payload.scheduledTime = scheduledTime;
  }

  return payload;
}

function taipeiDate(now) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}
