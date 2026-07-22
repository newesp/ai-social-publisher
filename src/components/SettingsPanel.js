"use client";

import { useEffect, useState } from "react";
import { Badge, Button, Group, Paper, PasswordInput, Select, SimpleGrid, Stack, Tabs, Text, TextInput, Title } from "@mantine/core";
import { IconKey } from "@tabler/icons-react";
import { disconnectFeedback, platformLifecycleStatus } from "../lib/platform-connections/settings-platform-lifecycle.js";
import { SupportSettingsPanel } from "./support/SupportSettingsPanel.js";
import { FloatingAlert } from "./FloatingAlert.js";

export function SettingsPanel() {
  const [values, setValues] = useState({});
  const [maskedSettings, setMaskedSettings] = useState({});
  const [settingsStatus, setSettingsStatus] = useState("idle");
  const [activeTab, setActiveTab] = useState("ai");
  const [connections, setConnections] = useState([]);
  const [connectionsStatus, setConnectionsStatus] = useState("loading");
  const [connectionAction, setConnectionAction] = useState("");
  const [connectionError, setConnectionError] = useState("");
  const [connectionNotice, setConnectionNotice] = useState("");
  const [supportSetupRetryable, setSupportSetupRetryable] = useState(false);
  const [lineEditing, setLineEditing] = useState(false);
  const [lineCredentials, setLineCredentials] = useState({ channelId: "", channelSecret: "" });
  const [metaPages, setMetaPages] = useState([]);
  const [metaTransactionId, setMetaTransactionId] = useState("");
  const [selectedMetaPage, setSelectedMetaPage] = useState("");

  useEffect(() => {
    loadSettings();
    loadConnections();

    const params = new URLSearchParams(window.location.search);
    if (params.get("tab") === "support") setActiveTab("support");
    if (params.get("tab") === "publishing" || params.has("meta")) setActiveTab("publishing");
    if (params.get("meta") === "start_error") {
      setConnectionError("無法開始 Meta 連線，請再試一次。");
      params.delete("meta");
      window.history.replaceState({}, "", `${window.location.pathname}?${params.toString()}`);
    }
    const transactionId = params.get("transactionId") ?? "";
    if (params.get("meta") === "select" && transactionId) loadMetaPages(transactionId);
    if (params.get("meta") === "reconnect") setConnectionError("無法連結 Meta，請再試一次。");
  }, []);

  async function loadSettings() {
    try {
      const response = await fetch("/api/settings");
      const data = await response.json();
      if (!response.ok) throw new Error();
      setMaskedSettings(data.settings ?? {});
    } catch {
      setSettingsStatus("load-error");
    }
  }

  async function loadConnections() {
    setConnectionsStatus("loading");
    setConnectionError("");
    try {
      const response = await fetch("/api/platform-connections");
      const data = await response.json();
      if (!response.ok || !Array.isArray(data.connections)) throw new Error();
      setConnections(data.connections);
      setConnectionsStatus("success");
    } catch {
      setConnectionsStatus("error");
      setConnectionError("無法載入發布平台連線。");
    }
  }

  async function saveSettings(keys) {
    if (settingsStatus === "saving") return;
    setSettingsStatus("saving");
    const payload = Object.fromEntries(keys.map((key) => [key, values[key]]).filter(([, value]) => value?.trim()));
    try {
      const response = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (!response.ok) throw new Error();
      setMaskedSettings(data.settings ?? {});
      setValues({});
      setSettingsStatus("saved");
    } catch {
      setSettingsStatus("save-error");
    }
  }

  async function loadMetaPages(transactionId) {
    setConnectionAction("meta-pages");
    setConnectionError("");
    try {
      const response = await fetch(`/api/platform-connections/meta/pending?transactionId=${encodeURIComponent(transactionId)}`);
      const data = await response.json();
      if (!response.ok || !Array.isArray(data.pages) || data.pages.length === 0) throw new Error();
      setMetaPages(data.pages);
      setMetaTransactionId(transactionId);
      setSelectedMetaPage(data.pages[0].id);
    } catch {
      setConnectionError("無法載入 Meta 粉絲專頁選項，請重新開始連線。");
    } finally {
      setConnectionAction("");
    }
  }

  async function selectMetaPage() {
    if (connectionAction || !metaTransactionId || !selectedMetaPage) return;
    setConnectionAction("meta-select");
    setConnectionError("");
    setConnectionNotice("");
    try {
      const response = await fetch("/api/platform-connections/meta/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transactionId: metaTransactionId, pageId: selectedMetaPage }),
      });
      if (!response.ok) throw new Error();
      setMetaPages([]);
      setMetaTransactionId("");
      setSelectedMetaPage("");
      window.history.replaceState({}, "", "/settings?tab=publishing");
      await loadConnections();
    } catch {
      setConnectionError("無法選擇 Meta 粉絲專頁，請再試一次。");
    } finally {
      setConnectionAction("");
    }
  }

  async function connectLine() {
    if (connectionAction || !lineCredentials.channelId.trim() || !lineCredentials.channelSecret.trim()) return;
    setConnectionAction("line-connect");
    setConnectionError("");
    setConnectionNotice("");
    try {
      const response = await fetch("/api/platform-connections/line", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(lineCredentials),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.connection) throw new Error();
      setLineEditing(false);
      await loadConnections();
      setSupportSetupRetryable(payload.supportSetup?.retryable === true);
      if (payload.supportSetup?.retryable) {
        setActiveTab("support");
        window.history.replaceState({}, "", "/settings?tab=support");
      }
    } catch {
      setConnectionError("無法連結 LINE，請檢查 Channel ID 與 Channel Secret 後再試一次。");
    } finally {
      setLineCredentials({ channelId: "", channelSecret: "" });
      setConnectionAction("");
    }
  }

  async function disconnectPlatform(platform) {
    if (connectionAction) return;
    setConnectionAction(`${platform}-disconnect`);
    setConnectionError("");
    setConnectionNotice("");
    try {
      const response = await fetch(`/api/platform-connections/${platform}/disconnect`, { method: "POST" });
      const payload = await response.json().catch(() => ({}));
      const feedback = disconnectFeedback(platform, response.status, payload);
      if (response.status === 409) {
        setConnectionError(feedback.error);
        return;
      }
      if (!response.ok) throw new Error();
      await loadConnections();
      setConnectionNotice(feedback.notice);
    } catch {
      setConnectionError(`無法中斷 ${platform === "meta" ? "Meta" : "LINE"} 連線，請再試一次。`);
    } finally {
      setConnectionAction("");
    }
  }

  const metaConnection = currentConnection(connections, "meta");
  const lineConnection = currentConnection(connections, "line");

  return (
    <Stack gap="lg">
      {settingsStatus === "saved" ? (
        <FloatingAlert color="green" onClose={() => setSettingsStatus("idle")}>
          設定已儲存。
        </FloatingAlert>
      ) : null}
      {settingsStatus === "load-error" || settingsStatus === "save-error" ? (
        <FloatingAlert color="red" onClose={() => setSettingsStatus("idle")}>
          無法儲存 AI 設定，請再試一次。
        </FloatingAlert>
      ) : null}
      {connectionsStatus === "success" && connectionError ? (
        <FloatingAlert color="red" onClose={() => setConnectionError("")}>
          {connectionError}
        </FloatingAlert>
      ) : null}
      {connectionsStatus === "success" && connectionNotice ? (
        <FloatingAlert color="blue" onClose={() => setConnectionNotice("")}>
          {connectionNotice}
        </FloatingAlert>
      ) : null}

      <div>
        <Title order={2}>系統設定</Title>
        <Text c="dimmed">AI 金鑰與發布平台連線僅供目前登入帳號使用。</Text>
      </div>
      <div role="status" aria-live="polite" />

      <Paper withBorder radius={8} p={{ base: "md", sm: "lg" }}>
        <Tabs value={activeTab} onChange={(tab) => setActiveTab(tab ?? "ai")}>
          <Tabs.List style={{ flexWrap: "wrap" }}>
            <Tabs.Tab value="ai" leftSection={<IconKey size={16} />}>AI</Tabs.Tab>
            <Tabs.Tab value="publishing">發布平台</Tabs.Tab>
            <Tabs.Tab value="support">客服</Tabs.Tab>
          </Tabs.List>

          <Tabs.Panel value="ai" pt="md">
            <Stack>
              <PasswordInput label="Google AI API Key" placeholder={maskedSettings.googleAiApiKey ?? "AIza..."} value={values.googleAiApiKey ?? ""} onChange={(event) => setValues((current) => ({ ...current, googleAiApiKey: event.currentTarget.value }))} />
              <PasswordInput label="OpenAI API Key" placeholder={maskedSettings.openAiApiKey ?? "sk-..."} value={values.openAiApiKey ?? ""} onChange={(event) => setValues((current) => ({ ...current, openAiApiKey: event.currentTarget.value }))} />
              <Button w="fit-content" loading={settingsStatus === "saving"} onClick={() => saveSettings(["googleAiApiKey", "openAiApiKey"])}>儲存 AI 設定</Button>
            </Stack>
          </Tabs.Panel>

          <Tabs.Panel value="publishing" pt="md">
            <Stack aria-live="polite">
              <Text c="dimmed" size="sm">每個登入帳號都會連結各自的發布平台。</Text>
              {connectionsStatus === "loading" ? <Text c="dimmed">正在載入發布平台連線…</Text> : null}
              {connectionsStatus === "error" ? <Group wrap="wrap"><Text c="red.7">{connectionError}</Text><Button variant="light" onClick={loadConnections}>重試</Button></Group> : null}
              {connectionsStatus === "success" ? (
                <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
                  <ConnectionCard title="Meta" connection={metaConnection}>
                    {metaPages.length > 0 ? (
                      <Stack gap="sm">
                        <Select label="選擇 Meta 粉絲專頁" data={metaPages.map((page) => ({ value: page.id, label: page.name }))} value={selectedMetaPage} onChange={(value) => setSelectedMetaPage(value ?? "")} />
                        <Button loading={connectionAction === "meta-select"} disabled={!selectedMetaPage || Boolean(connectionAction)} onClick={selectMetaPage}>連結所選粉絲專頁</Button>
                      </Stack>
                    ) : (
                      <Group wrap="wrap">
                        <form
                          action="/api/platform-connections/meta/start"
                          method="post"
                          onSubmit={() => setConnectionAction("meta-start")}
                        >
                          <input type="hidden" name="returnPath" value="/settings?tab=publishing" />
                          <Button type="submit" loading={connectionAction === "meta-start"} disabled={Boolean(connectionAction)}>
                            {metaConnection.state === "active" ? "更換粉絲專頁" : metaConnection.state === "needs_reconnect" ? "重新連線" : "連結 Meta"}
                          </Button>
                        </form>
                        {metaConnection.state === "active" ? <Button color="red" variant="light" loading={connectionAction === "meta-disconnect"} disabled={Boolean(connectionAction)} onClick={() => disconnectPlatform("meta")}>中斷連線</Button> : null}
                      </Group>
                    )}
                  </ConnectionCard>

                  <ConnectionCard title="LINE" connection={lineConnection}>
                    {lineEditing ? (
                      <Stack gap="sm">
                        <details>
                          <summary style={{ cursor: "pointer", fontWeight: 600 }}>如何取得 Channel ID／Channel Secret</summary>
                          <ol style={{ marginBlock: "0.75rem 0", paddingInlineStart: "1.25rem" }}>
                            <li><Text size="sm">登入 <Text component="a" href="https://developers.line.biz/" target="_blank" rel="noreferrer noopener" inherit td="underline">LINE Developers Console</Text>。</Text></li>
                            <li><Text size="sm">選擇 Provider 及其 <strong>Messaging API</strong> Channel；若尚未建立，請先建立 LINE Official Account 並啟用 Messaging API。</Text></li>
                            <li><Text size="sm">開啟 <strong>Basic settings</strong>，複製 <strong>Channel ID</strong> 與 <strong>Channel Secret</strong>。</Text></li>
                            <li><Text size="sm">將兩個值貼至下方。請勿貼上 Channel access token；系統會自動取得並更新。</Text></li>
                          </ol>
                        </details>
                        <TextInput label="Channel ID" value={lineCredentials.channelId} onChange={(event) => setLineCredentials((current) => ({ ...current, channelId: event.currentTarget.value }))} autoComplete="off" />
                        <PasswordInput label="Channel Secret" value={lineCredentials.channelSecret} onChange={(event) => setLineCredentials((current) => ({ ...current, channelSecret: event.currentTarget.value }))} autoComplete="new-password" />
                        <Group wrap="wrap">
                          <Button loading={connectionAction === "line-connect"} disabled={Boolean(connectionAction) || !lineCredentials.channelId.trim() || !lineCredentials.channelSecret.trim()} onClick={connectLine}>連結 LINE</Button>
                          <Button variant="default" disabled={Boolean(connectionAction)} onClick={() => { setLineEditing(false); setLineCredentials({ channelId: "", channelSecret: "" }); }}>取消</Button>
                        </Group>
                      </Stack>
                    ) : (
                      <Group wrap="wrap">
                        <Button disabled={Boolean(connectionAction)} onClick={() => setLineEditing(true)}>{lineConnection.state === "needs_reconnect" || lineConnection.state === "active" ? "重新連線" : "連結 LINE"}</Button>
                        {lineConnection.state === "active" ? <Button color="red" variant="light" loading={connectionAction === "line-disconnect"} disabled={Boolean(connectionAction)} onClick={() => disconnectPlatform("line")}>中斷連線</Button> : null}
                      </Group>
                    )}
                  </ConnectionCard>
                </SimpleGrid>
              ) : null}
            </Stack>
          </Tabs.Panel>

          <Tabs.Panel value="support" pt="md">
            <SupportSettingsPanel
              lineConnection={lineConnection}
              initialSetupRetryable={supportSetupRetryable}
            />
          </Tabs.Panel>
        </Tabs>
      </Paper>
    </Stack>
  );
}

function ConnectionCard({ title, connection, children }) {
  const active = connection.state === "active";
  const reconnect = connection.state === "needs_reconnect";
  const lifecycle = platformLifecycleStatus(connection);
  return (
    <Paper withBorder radius="md" p="md" h="100%">
      <Stack gap="sm" h="100%">
        <Group justify="space-between" align="flex-start" wrap="wrap">
          <div style={{ minWidth: 0 }}>
            <Text fw={700}>{title}</Text>
            <Text size="sm" c="dimmed" style={{ overflowWrap: "anywhere" }}>{active ? connection.displayName : reconnect ? "連線需要處理" : "尚未連線"}</Text>
          </div>
          <Badge color={active ? "green" : reconnect ? "orange" : "gray"}>{active ? "已連線" : reconnect ? "需要重新連線" : "尚未連線"}</Badge>
        </Group>
        {lifecycle ? <Text size="xs" c="dimmed">{lifecycle}</Text> : null}
        <div style={{ marginTop: "auto" }}>{children}</div>
      </Stack>
    </Paper>
  );
}

function currentConnection(connections, platform) {
  return connections.find((connection) => connection.platform === platform && connection.state === "active")
    ?? connections.find((connection) => connection.platform === platform && connection.state === "needs_reconnect")
    ?? { platform, state: "disconnected", displayName: "" };
}
