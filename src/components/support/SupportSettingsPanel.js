"use client";

import {
  Button,
  Checkbox,
  Group,
  Paper,
  Select,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { useCallback, useEffect, useState } from "react";

import { LLM_MODEL_OPTIONS as MODELS } from "../../lib/ai/model-config.js";
import { FaqManager } from "./FaqManager.js";
import { SupportReadinessPanel } from "./SupportReadinessPanel.js";

const EMPTY_FORM = Object.freeze({
  brandName: "",
  assistantName: "",
  replyTone: "friendly",
  llmProvider: "google",
  llmModel: MODELS.google[0],
  redeliveryAcknowledged: false,
  nativeRepliesDisabledAcknowledged: false,
});

export function SupportSettingsPanel({ lineConnection, initialSetupRetryable = false }) {
  const [configuration, setConfiguration] = useState(null);
  const [form, setForm] = useState(() => toForm(null, lineConnection));
  const [readiness, setReadiness] = useState(null);
  const [status, setStatus] = useState("loading");
  const [action, setAction] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const lineConnected = lineConnection?.state === "active";

  const loadStaticReadiness = useCallback(async () => {
    const response = await fetch("/api/support/configuration/state");
    const data = await safeJson(response);
    if (!response.ok || !data.readiness) {
      throw new Error(safeError(data, "無法載入客服就緒狀態。"));
    }
    setReadiness(data.readiness);
    return data.readiness;
  }, []);

  const loadConfiguration = useCallback(async () => {
    const response = await fetch("/api/support/configuration");
    const data = await safeJson(response);
    if (!response.ok) throw new Error(safeError(data, "無法載入客服設定。"));
    const nextConfiguration = data.configuration ?? null;
    setConfiguration(nextConfiguration);
    setForm(toForm(nextConfiguration, lineConnection));
    return nextConfiguration;
  }, [lineConnection]);

  const loadSupport = useCallback(async () => {
    setStatus("loading");
    setError("");
    try {
      await Promise.all([loadConfiguration(), loadStaticReadiness()]);
      setStatus("success");
    } catch (loadError) {
      setError(loadError.message || "無法載入客服設定。");
      setStatus("error");
    }
  }, [loadConfiguration, loadStaticReadiness, lineConnected]);

  useEffect(() => {
    loadSupport();
  }, [loadSupport]);

  useEffect(() => {
    if (initialSetupRetryable) {
      setNotice("LINE 已連線，但客服 Webhook 尚未完成設定。請依下方步驟確認後重試。");
    }
  }, [initialSetupRetryable]);

  async function saveConfiguration() {
    if (action || !canSaveConfiguration(form)) return;
    setAction("save");
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/support/configuration", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(writableConfiguration(form)),
      });
      const data = await safeJson(response);
      if (!response.ok || !data.configuration) {
        throw new Error(safeError(data, "客服設定儲存失敗。"));
      }
      setConfiguration(data.configuration);
      setForm(toForm(data.configuration, lineConnection));
      await loadStaticReadiness();
      setNotice("客服設定已儲存。");
    } catch (saveError) {
      setError(saveError.message || "客服設定儲存失敗。");
    } finally {
      setAction("");
    }
  }

  async function refreshReadiness() {
    if (action || !lineConnected) return;
    setAction("readiness");
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/support/configuration/readiness", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await safeJson(response);
      if (data.readiness) setReadiness(data.readiness);
      if (!response.ok) {
        throw new Error("LINE Webhook 尚未完成設定，請稍後再試。");
      }
      await loadConfiguration();
      setNotice(data.setup?.status === "verified"
        ? "LINE Webhook 已通過測試。"
        : "Webhook 已設定，請完成 LINE Console 操作後再次檢查。");
    } catch (readinessError) {
      setError(readinessError.message || "LINE 就緒狀態檢查失敗。");
    } finally {
      setAction("");
    }
  }

  async function testProvider() {
    if (action || !configuration) return;
    setAction("provider");
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/support/configuration/test-provider", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await safeJson(response);
      if (!response.ok || data.providerTest?.providerTested !== true) {
        throw new Error(safeError(data, "AI 供應商測試失敗。"));
      }
      await loadStaticReadiness();
      setNotice("AI 供應商測試成功。");
    } catch (providerError) {
      try {
        await loadStaticReadiness();
      } catch {
        // Keep the explicit provider-test error visible.
      }
      setError(providerError.message || "AI 供應商測試失敗。");
    } finally {
      setAction("");
    }
  }

  async function changeSupportState(enabled) {
    if (action || !configuration) return;
    setAction(enabled ? "enable" : "disable");
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/support/configuration/state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      const data = await safeJson(response);
      if (data.readiness) setReadiness(data.readiness);
      if (!response.ok) {
        throw new Error(safeError(
          data,
          enabled ? "客服尚未符合啟用條件。" : "無法停用客服。",
        ));
      }
      await loadStaticReadiness();
      setNotice(enabled ? "AI 客服已啟用。" : "AI 客服已停用。");
    } catch (stateError) {
      setError(stateError.message || "無法更新 AI 客服狀態。");
    } finally {
      setAction("");
    }
  }

  function updateProvider(provider) {
    const llmProvider = provider ?? "google";
    setForm((current) => ({
      ...current,
      llmProvider,
      llmModel: MODELS[llmProvider]?.[0] ?? "",
    }));
  }

  if (status === "loading") {
    return <Text c="dimmed">載入客服設定中…</Text>;
  }

  if (status === "error") {
    return (
      <Group wrap="wrap" role="status" aria-live="polite">
        <Text c="red.7">{error}</Text>
        <Button variant="light" onClick={loadSupport}>重新載入</Button>
      </Group>
    );
  }

  return (
    <Stack gap="lg" style={{ minWidth: 0 }}>
      <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="md">
        <Paper withBorder radius="md" p="md" style={{ minWidth: 0 }}>
          <Stack>
            <div>
              <Title order={3}>客服基本設定</Title>
              <Text size="sm" c="dimmed">
                使用結構化欄位設定品牌、客服名稱與回覆風格；安全規則由系統固定管理。
              </Text>
            </div>
            {!configuration && lineConnected ? (
              <Text size="sm" c="orange.8">
                請先執行「檢查 LINE 就緒狀態」，系統會建立這個 LINE 帳號的客服設定。
              </Text>
            ) : null}
            {!lineConnected ? (
              <Text size="sm" c="orange.8">請先到「發佈連線」分頁連結 LINE。</Text>
            ) : null}
            <TextInput
              label="品牌名稱"
              required
              maxLength={80}
              value={form.brandName}
              onChange={(event) => {
                const brandName = event.currentTarget.value;
                setForm((current) => ({ ...current, brandName }));
              }}
            />
            <TextInput
              label="客服名稱"
              required
              maxLength={40}
              value={form.assistantName}
              onChange={(event) => {
                const assistantName = event.currentTarget.value;
                setForm((current) => ({ ...current, assistantName }));
              }}
            />
            <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
              <Select
                label="回覆語氣"
                data={[
                  { value: "friendly", label: "親切" },
                  { value: "professional", label: "專業" },
                  { value: "concise", label: "精簡" },
                ]}
                value={form.replyTone}
                allowDeselect={false}
                onChange={(value) => setForm((current) => ({
                  ...current,
                  replyTone: value ?? "friendly",
                }))}
              />
              <Select
                label="AI 供應商"
                data={[
                  { value: "google", label: "Google Gemini" },
                  { value: "openai", label: "OpenAI" },
                ]}
                value={form.llmProvider}
                allowDeselect={false}
                onChange={updateProvider}
              />
            </SimpleGrid>
            <Select
              label="AI 模型"
              data={(MODELS[form.llmProvider] ?? []).map((model) => ({
                value: model,
                label: model,
              }))}
              value={form.llmModel}
              allowDeselect={false}
              onChange={(value) => setForm((current) => ({
                ...current,
                llmModel: value ?? "",
              }))}
            />
            <Group wrap="wrap">
              <Button
                loading={action === "save"}
                disabled={Boolean(action) || !canSaveConfiguration(form)}
                onClick={saveConfiguration}
              >
                儲存客服設定
              </Button>
              <Text size="xs" c="dimmed">API Key 請在 AI 分頁管理，不會顯示在這裡。</Text>
            </Group>
            {lineConnected && (!form.redeliveryAcknowledged || !form.nativeRepliesDisabledAcknowledged) ? (
              <Text size="xs" c="orange.8">
                提示：請勾選右側「啟用與就緒狀態」中的確認框以啟用儲存按鈕。
              </Text>
            ) : null}
          </Stack>
        </Paper>

        <SupportReadinessPanel
          lineConnection={lineConnection}
          configuration={configuration}
          form={form}
          setForm={setForm}
          readiness={readiness}
          action={action}
          onRefresh={refreshReadiness}
          onTestProvider={testProvider}
          onChangeSupportState={changeSupportState}
        />
      </SimpleGrid>

      <FaqManager onChanged={loadStaticReadiness} />

      <div role="status" aria-live="polite">
        {error ? <Text c="red.7" size="sm">{error}</Text> : null}
        {notice ? <Text c="green.7" size="sm">{notice}</Text> : null}
      </div>
    </Stack>
  );
}

function toForm(configuration, lineConnection) {
  const defaultName = lineConnection?.displayName || "";
  if (!configuration) {
    return {
      ...EMPTY_FORM,
      brandName: defaultName,
      assistantName: defaultName,
    };
  }
  const provider = MODELS[configuration.llmProvider] ? configuration.llmProvider : "google";
  const model = MODELS[provider].includes(configuration.llmModel)
    ? configuration.llmModel
    : MODELS[provider][0];
  return {
    brandName: configuration.brandName || defaultName,
    assistantName: configuration.assistantName || defaultName,
    replyTone: configuration.replyTone ?? "friendly",
    llmProvider: provider,
    llmModel: model,
    redeliveryAcknowledged: configuration.redeliveryAcknowledged === true,
    nativeRepliesDisabledAcknowledged:
      configuration.nativeRepliesDisabledAcknowledged === true,
  };
}

function canSaveConfiguration(form) {
  return Boolean(
    form.brandName.trim()
    && form.assistantName.trim()
    && form.replyTone
    && form.llmProvider
    && form.llmModel
    && form.redeliveryAcknowledged
    && form.nativeRepliesDisabledAcknowledged,
  );
}

function writableConfiguration(form) {
  return {
    brandName: form.brandName,
    assistantName: form.assistantName,
    replyTone: form.replyTone,
    llmProvider: form.llmProvider,
    llmModel: form.llmModel,
    redeliveryAcknowledged: form.redeliveryAcknowledged,
    nativeRepliesDisabledAcknowledged: form.nativeRepliesDisabledAcknowledged,
  };
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function safeError(data, fallback) {
  return typeof data?.error === "string" && data.error.trim() ? data.error : fallback;
}
