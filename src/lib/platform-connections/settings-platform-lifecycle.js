const BLOCKED_MESSAGE = "請取消待發布貼文或等待發布完成後，再中斷此平台連線。";
const META_NOTICE = "已在本系統中斷 Meta 連線；如有需要，可另至 Meta 撤銷應用程式存取權。";
const LINE_WARNING = "已在本系統中斷 LINE 連線，但無法確認存取權杖是否已撤銷。";

export function disconnectFeedback(platform, status, payload) {
  if (status === 409) return { error: BLOCKED_MESSAGE, notice: "" };
  if (status >= 200 && status < 300 && platform === "meta" && payload?.notice) return { error: "", notice: META_NOTICE };
  if (status >= 200 && status < 300 && platform === "line" && payload?.warning) return { error: "", notice: LINE_WARNING };
  return { error: "", notice: "" };
}

export function platformLifecycleStatus(connection) {
  if (connection?.state !== "active") return "";
  if (connection.platform === "meta") {
    return "發布前會檢查粉絲專頁授權；系統會嘗試更新授權，但仍可能需要重新連線。";
  }
  if (connection.platform === "line") {
    const expiry = toSafeDate(connection.expiresAt);
    return expiry
      ? `已啟用自動更新，目前存取權杖有效至 ${expiry}。`
      : "已啟用自動更新。";
  }
  return "";
}

function toSafeDate(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString("zh-TW", { dateStyle: "medium", timeZone: "UTC" });
}
