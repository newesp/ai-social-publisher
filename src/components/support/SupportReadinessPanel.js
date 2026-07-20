"use client";

import {
  Badge,
  Button,
  Checkbox,
  Group,
  Paper,
  SimpleGrid,
  Stack,
  Text,
  Title,
} from "@mantine/core";

const CHECK_LABELS = Object.freeze({
  lineActive: "LINE 連線有效",
  providerConfigured: "AI Key 與模型已設定",
  enabledFaq: "至少一則 FAQ 已啟用",
  webhookVerified: "Webhook 測試成功且 Use webhook 已開啟",
  redeliveryAcknowledged: "已確認 Webhook redelivery",
  nativeRepliesDisabledAcknowledged: "已確認停用原生問候與自動回覆",
});

export function SupportReadinessPanel({
  lineConnection,
  configuration,
  form,
  setForm,
  readiness,
  action,
  onRefresh,
  onTestProvider,
  onChangeSupportState,
}) {
  const lineActive = lineConnection?.state === "active";
  const supportEnabled = readiness?.supportEnabled === true;
  const checks = readiness?.checks ?? {};

  return (
    <Paper withBorder radius="md" p="md" style={{ minWidth: 0 }}>
      <Stack gap="md">
        <div>
          <Title order={3}>啟用與就緒狀態</Title>
          <Text size="sm" c="dimmed">
            LINE 已連線不代表 AI 客服已啟用；兩個狀態會分開顯示。
          </Text>
        </div>

        <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
          <Paper withBorder radius="sm" p="sm" style={{ minWidth: 0 }}>
            <Group justify="space-between" align="flex-start" wrap="wrap">
              <div style={{ minWidth: 0 }}>
                <Text fw={600}>LINE 連線狀態</Text>
                <Text size="sm" c="dimmed" style={{ overflowWrap: "anywhere" }}>
                  {lineActive ? lineConnection.displayName : "尚未連線或需要重新連線"}
                </Text>
              </div>
              <Badge color={lineActive ? "green" : "gray"}>
                {lineActive ? "已連線" : "未就緒"}
              </Badge>
            </Group>
          </Paper>
          <Paper withBorder radius="sm" p="sm" style={{ minWidth: 0 }}>
            <Group justify="space-between" align="flex-start" wrap="wrap">
              <div style={{ minWidth: 0 }}>
                <Text fw={600}>AI 客服狀態</Text>
                <Text size="sm" c="dimmed">
                  {supportEnabled ? "會處理新的 LINE 客戶訊息" : "目前不會自動回覆"}
                </Text>
              </div>
              <Badge color={supportEnabled ? "green" : "gray"}>
                {supportEnabled ? "已啟用" : "已停用"}
              </Badge>
            </Group>
          </Paper>
        </SimpleGrid>

        {lineActive ? (
          <details>
            <summary style={{ cursor: "pointer", fontWeight: 600 }}>
              如何啟用 LINE AI 客服
            </summary>
            <Text size="sm" c="dimmed" mt="xs">
              請確認目前連線的 Provider 與 Messaging API Channel，然後依序完成：
            </Text>
            <ol style={{ marginBlock: "0.75rem 0", paddingInlineStart: "1.25rem" }}>
              <li><Text size="sm">開啟 <strong>Messaging API</strong> 分頁。</Text></li>
              <li><Text size="sm">啟用 <strong>Use webhook</strong>。</Text></li>
              <li><Text size="sm">啟用 <strong>Webhook redelivery</strong>。</Text></li>
              <li><Text size="sm">開啟 <strong>Official Account Manager</strong> 的回應設定。</Text></li>
              <li><Text size="sm">停用 <strong>Greeting messages</strong>。</Text></li>
              <li><Text size="sm">停用 <strong>Auto-reply messages</strong>。</Text></li>
              <li><Text size="sm">回到本頁執行「檢查 LINE 就緒狀態」。</Text></li>
            </ol>
          </details>
        ) : null}

        <Stack gap="xs">
          <Checkbox
            label="我已啟用 Webhook redelivery"
            checked={form.redeliveryAcknowledged}
            disabled={!lineActive || Boolean(action)}
            onChange={(event) => setForm((current) => ({
              ...current,
              redeliveryAcknowledged: event.currentTarget.checked,
            }))}
          />
          <Checkbox
            label="我已停用 Greeting messages 與 Auto-reply messages"
            checked={form.nativeRepliesDisabledAcknowledged}
            disabled={!lineActive || Boolean(action)}
            onChange={(event) => setForm((current) => ({
              ...current,
              nativeRepliesDisabledAcknowledged: event.currentTarget.checked,
            }))}
          />
        </Stack>

        <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="xs">
          {Object.entries(CHECK_LABELS).map(([key, label]) => (
            <Group key={key} gap="xs" wrap="wrap" style={{ minWidth: 0 }}>
              <Badge color={checks[key] ? "green" : "gray"} variant="light">
                {checks[key] ? "完成" : "未完成"}
              </Badge>
              <Text size="sm" style={{ overflowWrap: "anywhere" }}>{label}</Text>
            </Group>
          ))}
          <Group gap="xs" wrap="wrap" style={{ minWidth: 0 }}>
            <Badge color={checks.providerTested ? "green" : "gray"} variant="light">
              {checks.providerTested ? "已測試" : "尚未測試"}
            </Badge>
            <Text size="sm">AI 供應商實際連線測試（建議）</Text>
          </Group>
        </SimpleGrid>

        <Text size="xs" c="dimmed">
          測試 AI 供應商會送出一次最小請求，可能使用供應商額度；載入本頁不會呼叫 AI。
        </Text>

        <Group wrap="wrap" aria-live="polite">
          <Button
            variant="light"
            loading={action === "readiness"}
            disabled={!lineActive || Boolean(action)}
            onClick={onRefresh}
          >
            檢查 LINE 就緒狀態
          </Button>
          <Button
            variant="light"
            loading={action === "provider"}
            disabled={!configuration || Boolean(action)}
            onClick={onTestProvider}
          >
            測試 AI 供應商
          </Button>
          {supportEnabled ? (
            <Button
              color="red"
              variant="light"
              loading={action === "disable"}
              disabled={Boolean(action)}
              onClick={() => onChangeSupportState(false)}
            >
              停用 AI 客服
            </Button>
          ) : (
            <Button
              loading={action === "enable"}
              disabled={!configuration || !readiness?.ready || Boolean(action)}
              onClick={() => onChangeSupportState(true)}
            >
              啟用 AI 客服
            </Button>
          )}
        </Group>
      </Stack>
    </Paper>
  );
}
