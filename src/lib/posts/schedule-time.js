export function computeScheduledFor({ scheduledDate, scheduledTime, now = new Date() }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(scheduledDate ?? ""))) {
    throw new Error("scheduledDate must use YYYY-MM-DD format.");
  }
  if (scheduledTime !== "09:00") {
    throw new Error("Unsupported scheduled time.");
  }

  const scheduledFor = new Date(`${scheduledDate}T01:00:00.000Z`);
  if (Number.isNaN(scheduledFor.getTime()) || scheduledFor.toISOString().slice(0, 10) !== scheduledDate) {
    throw new Error("scheduledDate is invalid.");
  }
  if (scheduledFor <= now) {
    throw new Error("Scheduled date and time is already in the past.");
  }
  return scheduledFor;
}
