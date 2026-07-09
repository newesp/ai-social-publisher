"use client";

import { useEffect, useState } from "react";
import { Button, Group, PasswordInput, Paper, Stack, Tabs, Text, TextInput, Title } from "@mantine/core";
import { IconDownload, IconKey, IconUpload } from "@tabler/icons-react";

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

    const response = await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json();

    setMaskedSettings(data.settings ?? {});
    setValues({});
    setStatus("saved");
  }

  function updateValue(key, value) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  return (
    <Stack gap="lg">
      <div>
        <Title order={2}>系統設定</Title>
        <Text c="dimmed">Admin-only。所有 key 只顯示遮罩，不在 API 回傳完整原文。</Text>
        {status === "saved" ? (
          <Text c="green.7" size="sm" mt={4}>
            設定已儲存。
          </Text>
        ) : null}
        {status === "load-error" ? (
          <Text c="red.7" size="sm" mt={4}>
            設定讀取失敗。
          </Text>
        ) : null}
      </div>

      <Paper withBorder radius={8} p="lg">
        <Tabs defaultValue="ai">
          <Tabs.List>
            <Tabs.Tab value="ai" leftSection={<IconKey size={16} />}>
              AI 模型
            </Tabs.Tab>
            <Tabs.Tab value="platforms">社群平台</Tabs.Tab>
            <Tabs.Tab value="integrations">整合服務</Tabs.Tab>
            <Tabs.Tab value="portable">匯入 / 匯出</Tabs.Tab>
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
              <Button
                w="fit-content"
                loading={status === "saving"}
                onClick={() => saveSettings(["googleAiApiKey", "openAiApiKey"])}
              >
                儲存 AI 設定
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
                label="Instagram User ID"
                placeholder={maskedSettings.instagramUserId ?? ""}
                value={values.instagramUserId ?? ""}
                onChange={(event) => updateValue("instagramUserId", event.currentTarget.value)}
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
                onClick={() =>
                  saveSettings([
                    "metaPageId",
                    "metaPageAccessToken",
                    "instagramUserId",
                    "lineChannelAccessToken",
                  ])
                }
              >
                儲存平台設定
              </Button>
            </Stack>
          </Tabs.Panel>

          <Tabs.Panel value="integrations" pt="md">
            <Stack>
              <PasswordInput
                label="Imgur Client ID"
                placeholder={maskedSettings.imgurClientId ?? ""}
                value={values.imgurClientId ?? ""}
                onChange={(event) => updateValue("imgurClientId", event.currentTarget.value)}
              />
              <Button
                w="fit-content"
                loading={status === "saving"}
                onClick={() => saveSettings(["imgurClientId"])}
              >
                儲存 Imgur 設定
              </Button>
            </Stack>
          </Tabs.Panel>

          <Tabs.Panel value="portable" pt="md">
            <Stack>
              <Text c="dimmed">
                Phase 2：匯出檔會使用 admin 輸入的 passphrase 加密，可交給另一個部署環境匯入。
              </Text>
              <Group>
                <Button leftSection={<IconDownload size={16} />} variant="light">
                  加密匯出
                </Button>
                <Button leftSection={<IconUpload size={16} />} variant="default">
                  匯入預覽
                </Button>
              </Group>
            </Stack>
          </Tabs.Panel>
        </Tabs>
      </Paper>
    </Stack>
  );
}
