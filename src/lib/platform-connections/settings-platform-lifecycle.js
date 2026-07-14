const BLOCKED_MESSAGE = "Cancel or wait for pending posts before disconnecting this platform.";
const META_NOTICE = "Meta was disconnected locally. You can separately revoke app access in Meta.";
const LINE_WARNING = "LINE was disconnected locally, but token revocation could not be confirmed.";

export function disconnectFeedback(platform, status, payload) {
  if (status === 409) return { error: BLOCKED_MESSAGE, notice: "" };
  if (status >= 200 && status < 300 && platform === "meta" && payload?.notice) return { error: "", notice: META_NOTICE };
  if (status >= 200 && status < 300 && platform === "line" && payload?.warning) return { error: "", notice: LINE_WARNING };
  return { error: "", notice: "" };
}

export function platformLifecycleStatus(connection) {
  if (connection?.state !== "active") return "";
  if (connection.platform === "meta") {
    return "Page authorization is checked before publishing; renewal is best effort and reconnecting may still be required.";
  }
  if (connection.platform === "line") {
    const expiry = toSafeDate(connection.expiresAt);
    return expiry
      ? `Automatic renewal is enabled. The current token is valid until ${expiry}.`
      : "Automatic renewal is enabled.";
  }
  return "";
}

function toSafeDate(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString("en-US", { dateStyle: "medium", timeZone: "UTC" });
}
