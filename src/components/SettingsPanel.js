"use client";

import { useEffect, useState } from "react";
import { Button, Paper, PasswordInput, Stack, Tabs, Text, TextInput, Title } from "@mantine/core";
import { IconKey } from "@tabler/icons-react";

export function SettingsPanel() {
  const [values, setValues] = useState({});
  const [maskedSettings, setMaskedSettings] = useState({});
  const [status, setStatus] = useState("idle");

  useEffect(() => {
    fetch("/api/settings")
      .then((response) => response.json())
      .then((data) => setMaskedSettings(data.settings ?? {}))
      .catch(() => setStatus("load-error"));
  }, []);

  async function saveSettings(keys) {
    setStatus("saving");
    const payload = Object.fromEntries(
      keys
        .map((key) => [key, values[key]])
        .filter(([, value]) => value && value.trim()),
    );

    try {
      const response = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Settings could not be saved.");

      setMaskedSettings(data.settings ?? {});
      setValues({});
      setStatus("saved");
    } catch {
      setStatus("save-error");
    }
  }

  function updateValue(key, value) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  return (
    <Stack gap="lg">
      <div>
        <Title order={2}>Settings</Title>
        <Text c="dimmed">Your API keys and publishing credentials are private to your signed-in account.</Text>
        {status === "saved" ? <Text c="green.7" size="sm" mt={4}>Settings saved.</Text> : null}
        {status === "load-error" || status === "save-error" ? (
          <Text c="red.7" size="sm" mt={4}>Settings could not be saved. Please try again.</Text>
        ) : null}
      </div>

      <Paper withBorder radius={8} p="lg">
        <Tabs defaultValue="ai">
          <Tabs.List>
            <Tabs.Tab value="ai" leftSection={<IconKey size={16} />}>AI</Tabs.Tab>
            <Tabs.Tab value="platforms">Publishing platforms</Tabs.Tab>
          </Tabs.List>

          <Tabs.Panel value="ai" pt="md">
            <Stack>
              <PasswordInput
                label="Google AI API Key"
                placeholder={maskedSettings.googleAiApiKey ?? "AIza..."}
                value={values.googleAiApiKey ?? ""}
                onChange={(event) => updateValue("googleAiApiKey", event.currentTarget.value)}
              />
              <PasswordInput
                label="OpenAI API Key"
                placeholder={maskedSettings.openAiApiKey ?? "sk-..."}
                value={values.openAiApiKey ?? ""}
                onChange={(event) => updateValue("openAiApiKey", event.currentTarget.value)}
              />
              <Button w="fit-content" loading={status === "saving"} onClick={() => saveSettings(["googleAiApiKey", "openAiApiKey"])}>
                Save AI settings
              </Button>
            </Stack>
          </Tabs.Panel>

          <Tabs.Panel value="platforms" pt="md">
            <Stack>
              <TextInput
                label="Meta Page ID"
                placeholder={maskedSettings.metaPageId ?? ""}
                value={values.metaPageId ?? ""}
                onChange={(event) => updateValue("metaPageId", event.currentTarget.value)}
              />
              <PasswordInput
                label="Meta Page Access Token"
                placeholder={maskedSettings.metaPageAccessToken ?? ""}
                value={values.metaPageAccessToken ?? ""}
                onChange={(event) => updateValue("metaPageAccessToken", event.currentTarget.value)}
              />
              <PasswordInput
                label="LINE Channel Access Token"
                placeholder={maskedSettings.lineChannelAccessToken ?? ""}
                value={values.lineChannelAccessToken ?? ""}
                onChange={(event) => updateValue("lineChannelAccessToken", event.currentTarget.value)}
              />
              <Button
                w="fit-content"
                loading={status === "saving"}
                onClick={() => saveSettings(["metaPageId", "metaPageAccessToken", "lineChannelAccessToken"])}
              >
                Save platform settings
              </Button>
            </Stack>
          </Tabs.Panel>
        </Tabs>
      </Paper>
    </Stack>
  );
}
