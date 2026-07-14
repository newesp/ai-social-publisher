// Coupled to the daily `0 1 * * *` schedule in vercel.json.
export const SCHEDULER_HOUR_UTC = 1;

export function nextScheduledRetryAt(now) {
  const time = now instanceof Date ? new Date(now) : new Date(now);
  if (Number.isNaN(time.getTime())) throw new Error("A valid retry calculation time is required.");
  const next = new Date(time);
  next.setUTCHours(SCHEDULER_HOUR_UTC, 0, 0, 0);
  if (next.getTime() <= time.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next;
}
