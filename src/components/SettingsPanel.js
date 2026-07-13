"use client";

import { useEffect, useState } from "react";
import { Badge, Button, Group, Paper, PasswordInput, Select, SimpleGrid, Stack, Tabs, Text, TextInput, Title } from "@mantine/core";
import { IconKey } from "@tabler/icons-react";
import { disconnectFeedback, platformLifecycleStatus } from "../lib/platform-connections/settings-platform-lifecycle.js";

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
  const [lineEditing, setLineEditing] = useState(false);
  const [lineCredentials, setLineCredentials] = useState({ channelId: "", channelSecret: "" });
  const [metaPages, setMetaPages] = useState([]);
  const [metaTransactionId, setMetaTransactionId] = useState("");
  const [selectedMetaPage, setSelectedMetaPage] = useState("");

  useEffect(() => {
    loadSettings();
    loadConnections();

    const params = new URLSearchParams(window.location.search);
    if (params.get("tab") === "publishing" || params.has("meta")) setActiveTab("publishing");
    const transactionId = params.get("transactionId") ?? "";
    if (params.get("meta") === "select" && transactionId) loadMetaPages(transactionId);
    if (params.get("meta") === "reconnect") setConnectionError("Meta could not be connected. Please try again.");
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
      setConnectionError("Publishing connections could not be loaded.");
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

  async function startMetaConnection() {
    if (connectionAction) return;
    setConnectionAction("meta-start");
    setConnectionError("");
    setConnectionNotice("");
    try {
      const response = await fetch("/api/platform-connections/meta/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ returnPath: "/settings?tab=publishing" }),
      });
      const data = await response.json();
      if (!response.ok || !data.authorizeUrl) throw new Error();
      window.location.assign(data.authorizeUrl);
    } catch {
      setConnectionError("Meta connection could not be started. Please try again.");
      setConnectionAction("");
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
      setConnectionError("Meta Page choices could not be loaded. Start the connection again.");
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
      setConnectionError("Meta Page could not be selected. Please try again.");
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
      if (!response.ok) throw new Error();
      setLineEditing(false);
      await loadConnections();
    } catch {
      setConnectionError("LINE could not be connected. Check the Channel ID and Channel Secret, then try again.");
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
      setConnectionError(`${platform === "meta" ? "Meta" : "LINE"} could not be disconnected. Please try again.`);
    } finally {
      setConnectionAction("");
    }
  }

  const metaConnection = currentConnection(connections, "meta");
  const lineConnection = currentConnection(connections, "line");

  return (
    <Stack gap="lg">
      <div>
        <Title order={2}>Settings</Title>
        <Text c="dimmed">AI keys and publishing connections are private to your signed-in account.</Text>
        {settingsStatus === "saved" ? <Text c="green.7" size="sm" mt={4}>Settings saved.</Text> : null}
        {settingsStatus === "load-error" || settingsStatus === "save-error" ? <Text c="red.7" size="sm" mt={4}>AI settings could not be saved. Please try again.</Text> : null}
      </div>

      <Paper withBorder radius={8} p={{ base: "md", sm: "lg" }}>
        <Tabs value={activeTab} onChange={(tab) => setActiveTab(tab ?? "ai")}>
          <Tabs.List>
            <Tabs.Tab value="ai" leftSection={<IconKey size={16} />}>AI</Tabs.Tab>
            <Tabs.Tab value="publishing">Publishing platforms</Tabs.Tab>
          </Tabs.List>

          <Tabs.Panel value="ai" pt="md">
            <Stack>
              <PasswordInput label="Google AI API Key" placeholder={maskedSettings.googleAiApiKey ?? "AIza..."} value={values.googleAiApiKey ?? ""} onChange={(event) => setValues((current) => ({ ...current, googleAiApiKey: event.currentTarget.value }))} />
              <PasswordInput label="OpenAI API Key" placeholder={maskedSettings.openAiApiKey ?? "sk-..."} value={values.openAiApiKey ?? ""} onChange={(event) => setValues((current) => ({ ...current, openAiApiKey: event.currentTarget.value }))} />
              <Button w="fit-content" loading={settingsStatus === "saving"} onClick={() => saveSettings(["googleAiApiKey", "openAiApiKey"])}>Save AI settings</Button>
            </Stack>
          </Tabs.Panel>

          <Tabs.Panel value="publishing" pt="md">
            <Stack aria-live="polite">
              <Text c="dimmed" size="sm">Every signed-in account connects its own publishing platforms.</Text>
              {connectionsStatus === "loading" ? <Text c="dimmed">Loading publishing connections…</Text> : null}
              {connectionsStatus === "error" ? <Group wrap="wrap"><Text c="red.7">{connectionError}</Text><Button variant="light" onClick={loadConnections}>Try again</Button></Group> : null}
              {connectionsStatus === "success" ? (
                <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
                  <ConnectionCard title="Meta" connection={metaConnection}>
                    {metaPages.length > 0 ? (
                      <Stack gap="sm">
                        <Select label="Choose a Meta Page" data={metaPages.map((page) => ({ value: page.id, label: page.name }))} value={selectedMetaPage} onChange={(value) => setSelectedMetaPage(value ?? "")} />
                        <Button loading={connectionAction === "meta-select"} disabled={!selectedMetaPage || Boolean(connectionAction)} onClick={selectMetaPage}>Connect selected Page</Button>
                      </Stack>
                    ) : (
                      <Group wrap="wrap">
                        <Button loading={connectionAction === "meta-start"} disabled={Boolean(connectionAction)} onClick={startMetaConnection}>{metaConnection.state === "active" ? "Change Page" : metaConnection.state === "needs_reconnect" ? "Reconnect" : "Connect Meta"}</Button>
                        {metaConnection.state === "active" ? <Button color="red" variant="light" loading={connectionAction === "meta-disconnect"} disabled={Boolean(connectionAction)} onClick={() => disconnectPlatform("meta")}>Disconnect</Button> : null}
                      </Group>
                    )}
                  </ConnectionCard>

                  <ConnectionCard title="LINE" connection={lineConnection}>
                    {lineEditing ? (
                      <Stack gap="sm">
                        <TextInput label="Channel ID" value={lineCredentials.channelId} onChange={(event) => setLineCredentials((current) => ({ ...current, channelId: event.currentTarget.value }))} autoComplete="off" />
                        <PasswordInput label="Channel Secret" value={lineCredentials.channelSecret} onChange={(event) => setLineCredentials((current) => ({ ...current, channelSecret: event.currentTarget.value }))} autoComplete="new-password" />
                        <Group wrap="wrap">
                          <Button loading={connectionAction === "line-connect"} disabled={Boolean(connectionAction) || !lineCredentials.channelId.trim() || !lineCredentials.channelSecret.trim()} onClick={connectLine}>Connect LINE</Button>
                          <Button variant="default" disabled={Boolean(connectionAction)} onClick={() => { setLineEditing(false); setLineCredentials({ channelId: "", channelSecret: "" }); }}>Cancel</Button>
                        </Group>
                      </Stack>
                    ) : (
                      <Group wrap="wrap">
                        <Button disabled={Boolean(connectionAction)} onClick={() => setLineEditing(true)}>{lineConnection.state === "needs_reconnect" ? "Reconnect" : lineConnection.state === "active" ? "Reconnect" : "Connect LINE"}</Button>
                        {lineConnection.state === "active" ? <Button color="red" variant="light" loading={connectionAction === "line-disconnect"} disabled={Boolean(connectionAction)} onClick={() => disconnectPlatform("line")}>Disconnect</Button> : null}
                      </Group>
                    )}
                  </ConnectionCard>
                </SimpleGrid>
              ) : null}
              <div role="status" aria-live="polite">
                {connectionsStatus === "success" && connectionError ? <Text c="red.7" size="sm">{connectionError}</Text> : null}
                {connectionsStatus === "success" && connectionNotice ? <Text c="blue.7" size="sm">{connectionNotice}</Text> : null}
              </div>
            </Stack>
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
            <Text size="sm" c="dimmed" style={{ overflowWrap: "anywhere" }}>{active ? connection.displayName : reconnect ? "Connection needs attention" : "Not connected"}</Text>
          </div>
          <Badge color={active ? "green" : reconnect ? "orange" : "gray"}>{active ? "Connected" : reconnect ? "Reconnect" : "Not connected"}</Badge>
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
