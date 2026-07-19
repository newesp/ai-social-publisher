import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("settings panel exposes only supported per-user settings", async () => {
  const source = await readFile(
    new URL("../src/components/SettingsPanel.js", import.meta.url),
    "utf8",
  );

  assert.equal(source.toLowerCase().includes("imgur"), false);
  assert.equal(source.toLowerCase().includes("instagram"), false);
  assert.equal(source.toLowerCase().includes("admin-only"), false);
  assert.equal(source.includes("IconDownload"), false);
  assert.equal(source.includes("IconUpload"), false);
});

test("settings uses safe per-user connection APIs instead of stored publishing credentials", async () => {
  const source = await readFile(new URL("../src/components/SettingsPanel.js", import.meta.url), "utf8");

  assert.equal(source.includes('fetch("/api/platform-connections")'), true);
  assert.equal(source.includes('/api/platform-connections/meta/start'), true);
  assert.equal(source.includes('/api/platform-connections/meta/select'), true);
  assert.equal(source.includes('/api/platform-connections/line'), true);
  assert.equal(source.includes('/disconnect'), true);
  for (const forbidden of ["Meta Page Access Token", "LINE Channel Access Token", "Meta Page ID", "client_id", "client_secret"]) {
    assert.equal(source.includes(forbidden), false, `must not render ${forbidden}`);
  }
});

test("Meta connection starts with a native POST form and consumes only a safe error flag", async () => {
  const source = await readFile(new URL("../src/components/SettingsPanel.js", import.meta.url), "utf8");

  assert.equal(source.includes('action="/api/platform-connections/meta/start"'), true);
  assert.equal(source.includes('method="post"'), true);
  assert.equal(source.includes('name="returnPath"'), true);
  assert.equal(source.includes('type="submit"'), true);
  assert.equal(source.includes('fetch("/api/platform-connections/meta/start"'), false);
  assert.equal(source.includes('params.get("meta") === "start_error"'), true);
  assert.equal(source.includes('params.delete("meta")'), true);
});

test("LINE credential form explains where to find Channel ID and Channel secret", async () => {
  const source = await readFile(new URL("../src/components/SettingsPanel.js", import.meta.url), "utf8");

  for (const expected of [
    "如何取得 Channel ID／Channel Secret",
    "https://developers.line.biz/",
    "Messaging API",
    "Basic settings",
    "LINE Official Account",
    "請勿貼上 Channel access token",
    'rel="noreferrer noopener"',
  ]) {
    assert.equal(source.includes(expected), true, `missing ${expected}`);
  }
  assert.equal(source.includes("<details"), true);
  assert.equal(source.includes("<summary"), true);

  const disclosureStart = source.indexOf("<details>");
  const disclosureEnd = source.indexOf("</details>", disclosureStart);
  const disclosure = source.slice(disclosureStart, disclosureEnd + "</details>".length);
  assert.equal((disclosure.match(/<ol\b/g) ?? []).length, 1);
  assert.equal((disclosure.match(/<li\b/g) ?? []).length, 4);
  let previousStep = -1;
  for (const step of [
    "登入",
    "選擇 Provider",
    "開啟 <strong>Basic settings</strong>",
    "將兩個值貼至下方",
  ]) {
    const stepIndex = disclosure.indexOf(step);
    assert.equal(stepIndex > previousStep, true, `LINE disclosure step is missing or out of order: ${step}`);
    previousStep = stepIndex;
  }

  const channelIdInput = source.indexOf('label="Channel ID"');
  const channelSecretInput = source.indexOf('label="Channel Secret"');
  assert.equal(disclosureEnd < channelIdInput, true);
  assert.equal(channelIdInput < channelSecretInput, true);
});

test("retryable support setup after LINE connect is surfaced with an explicit support retry path", async () => {
  const source = await readFile(new URL("../src/components/SettingsPanel.js", import.meta.url), "utf8");
  const connectStart = source.indexOf("async function connectLine()");
  const connectEnd = source.indexOf("async function disconnectPlatform", connectStart);
  const connectSource = source.slice(connectStart, connectEnd);

  assert.equal(connectSource.includes("supportSetup?.retryable"), true);
  assert.equal(connectSource.includes('setActiveTab("support")'), true);
  assert.equal(connectSource.includes('"/settings?tab=support"'), true);
  assert.equal(connectSource.includes("webhookUrl"), false);
  assert.equal(connectSource.includes("webhookKey"), false);
  assert.equal(connectSource.includes("credentials"), false);
});

test("settings renders actionable loading, disconnected, active, reconnect, and error states", async () => {
  const source = await readFile(new URL("../src/components/SettingsPanel.js", import.meta.url), "utf8");
  const lifecycleSource = await readFile(new URL("../src/lib/platform-connections/settings-platform-lifecycle.js", import.meta.url), "utf8");

  for (const expected of ["正在載入發布平台連線", "尚未連線", "已連線", "重新連線", "更換粉絲專頁", "重試", "Channel ID", "Channel Secret"]) {
    assert.equal(source.includes(expected), true, `missing ${expected}`);
  }
  assert.equal(source.includes("setLineCredentials({ channelId: \"\", channelSecret: \"\" })"), true);
  assert.equal(source.includes("response.status === 409"), true);
  assert.equal(lifecycleSource.includes("請取消待發布貼文"), true);
  assert.equal(source.includes('role="status"'), true);
  assert.equal(source.includes("disconnectFeedback"), true);
  assert.equal(source.includes("platformLifecycleStatus"), true);
});

test("successful Meta Page selection removes the opaque callback query before refreshing availability", async () => {
  const source = await readFile(new URL("../src/components/SettingsPanel.js", import.meta.url), "utf8");
  const cleanup = source.indexOf('window.history.replaceState({}, "", "/settings?tab=publishing")');
  const refresh = source.indexOf("await loadConnections()", cleanup);

  assert.notEqual(cleanup, -1);
  assert.equal(refresh > cleanup, true);
});

test("settings adds the approved 客服 tab without exposing an arbitrary system prompt", async () => {
  const settingsSource = await readFile(
    new URL("../src/components/SettingsPanel.js", import.meta.url),
    "utf8",
  );
  const supportSource = await readFile(
    new URL("../src/components/support/SupportSettingsPanel.js", import.meta.url),
    "utf8",
  );

  assert.equal(settingsSource.includes('value="support"'), true);
  assert.equal(settingsSource.includes(">客服</Tabs.Tab>"), true);
  assert.equal(settingsSource.includes("<SupportSettingsPanel"), true);
  assert.equal(settingsSource.includes('params.get("tab") === "support"'), true);
  for (const expected of [
    'label="品牌名稱"',
    'label="客服名稱"',
    'label="回覆語氣"',
    'label="AI 供應商"',
    'label="AI 模型"',
    "/api/support/configuration",
    "/api/support/configuration/state",
    "/api/support/configuration/test-provider",
    "/api/support/configuration/readiness",
  ]) {
    assert.equal(supportSource.includes(expected), true, `missing ${expected}`);
  }
  assert.equal(supportSource.includes("systemPrompt"), false);
  assert.equal(supportSource.includes("system prompt"), false);
  assert.equal(supportSource.includes("LLM_MODEL_OPTIONS"), true);
  assert.equal(supportSource.includes('"gemini-3.5-flash"'), false);
  assert.equal(supportSource.includes("platformConnectionId"), false);
  assert.equal(supportSource.includes("JSON.stringify(form)"), false);
  assert.equal(supportSource.includes("writableConfiguration(form)"), true);
  assert.equal(supportSource.includes("自訂提示詞"), false);
});

test("LINE support instructions preserve the approved order and acknowledgement controls", async () => {
  const source = await readFile(
    new URL("../src/components/support/SupportReadinessPanel.js", import.meta.url),
    "utf8",
  );

  const disclosureStart = source.indexOf("<details");
  const disclosureEnd = source.indexOf("</details>", disclosureStart);
  const disclosure = source.slice(disclosureStart, disclosureEnd + "</details>".length);
  assert.notEqual(disclosureStart, -1);
  assert.equal((disclosure.match(/<li\b/g) ?? []).length, 7);
  let previousStep = -1;
  for (const step of [
    "Messaging API",
    "Use webhook",
    "Webhook redelivery",
    "Official Account Manager",
    "Greeting messages",
    "Auto-reply messages",
    "回到本頁執行「檢查 LINE 就緒狀態」",
  ]) {
    const stepIndex = disclosure.indexOf(step);
    assert.equal(stepIndex > previousStep, true, `instruction missing or out of order: ${step}`);
    previousStep = stepIndex;
  }
  assert.equal(source.includes("我已啟用 Webhook redelivery"), true);
  assert.equal(source.includes("我已停用 Greeting messages 與 Auto-reply messages"), true);
  assert.equal(source.includes("LINE 連線狀態"), true);
  assert.equal(source.includes("AI 客服狀態"), true);
  assert.equal(source.includes("測試 AI 供應商會送出一次最小請求，可能使用供應商額度"), true);
  assert.equal(source.includes('aria-live="polite"'), true);
});

test("FAQ manager implements explicit CRUD, filtering, and safe loading/error/empty states", async () => {
  const source = await readFile(
    new URL("../src/components/support/FaqManager.js", import.meta.url),
    "utf8",
  );

  for (const expected of [
    'fetch("/api/support/faqs")',
    'method: "POST"',
    'method: "PATCH"',
    'method: "DELETE"',
    'label="搜尋 FAQ"',
    'label="問題"',
    'label="答案"',
    'label="分類"',
    'label="關鍵字"',
    'label="優先順序"',
    "尚未建立 FAQ",
    "載入 FAQ",
    "儲存 FAQ",
    "刪除 FAQ",
    'role="status"',
    'aria-live="polite"',
  ]) {
    assert.equal(source.includes(expected), true, `missing ${expected}`);
  }
  assert.equal(source.includes("response.status === 204"), true);
  assert.equal(source.includes("window.confirm"), true);
});

test("FAQ manager announces its initial load error to assistive technology", async () => {
  const source = await readFile(
    new URL("../src/components/support/FaqManager.js", import.meta.url),
    "utf8",
  );
  const loadErrorBranch = source.match(/\{status === "error"[\s\S]*?\) : null\}/)?.[0] ?? "";

  assert.match(loadErrorBranch, /<Group[^>]*role="alert"[^>]*aria-live="assertive"/);
});

test("support settings use structural narrow-screen wrapping without page-level horizontal overflow", async () => {
  const sources = await Promise.all([
    "SupportSettingsPanel.js",
    "FaqManager.js",
    "SupportReadinessPanel.js",
  ].map((name) => readFile(
    new URL(`../src/components/support/${name}`, import.meta.url),
    "utf8",
  )));
  const combined = sources.join("\n");

  assert.equal(combined.includes('cols={{ base: 1'), true);
  assert.equal(combined.includes('wrap="wrap"'), true);
  assert.equal(combined.includes("minWidth: 0"), true);
  assert.equal(combined.includes('overflowWrap: "anywhere"'), true);
  assert.equal(combined.includes("overflowX"), false);
  assert.equal(combined.includes('loading='), true);
  assert.equal(combined.includes('disabled='), true);
});

test("login explains that each signed-in account connects its own platforms", async () => {
  const source = await readFile(new URL("../src/app/login/page.js", import.meta.url), "utf8");

  assert.equal(source.includes("每個登入帳號都會連結自己的發布平台"), true);
  assert.equal(source.toLowerCase().includes("admin-only"), false);
});
