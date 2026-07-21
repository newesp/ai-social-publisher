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
  onOpenSettings,
  onOpenFaq,
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
              請依序完成以下步驟，然後返回本頁面進行就緒狀態檢查：
            </Text>
            <ol style={{ marginBlock: "0.75rem 0", paddingInlineStart: "1.25rem" }}>
              <li>
                <Text size="sm">
                  前往 <Text component="a" href="https://developers.line.biz/console/" target="_blank" rel="noreferrer noopener" inherit td="underline">LINE Developers Console</Text>，選擇您的 Provider 與 Messaging API Channel，開啟 <strong>Messaging API</strong> 頁籤。
                </Text>
              </li>
              <li>
                <Text size="sm">
                  在 Webhook settings 區塊中，啟用 <strong>Use webhook</strong> (使用 Webhook)。
                </Text>
              </li>
              <li>
                <Text size="sm">
                  在 Webhook settings 區塊中，啟用 <strong>Webhook redelivery</strong> (Webhook 傳送資料重試功能)。
                </Text>
                <Checkbox
                  mt="xs"
                  mb="xs"
                  label="我已啟用 Webhook redelivery"
                  checked={form.redeliveryAcknowledged}
                  disabled={!lineActive || Boolean(action)}
                  onChange={(event) => {
                    const redeliveryAcknowledged = event.currentTarget.checked;
                    setForm((current) => ({
                      ...current,
                      redeliveryAcknowledged,
                    }));
                  }}
                />
              </li>
              <li>
                <Text size="sm">
                  前往 <Text component="a" href="https://manager.line.biz/" target="_blank" rel="noreferrer noopener" inherit td="underline">LINE Official Account Manager</Text>，選擇帳號，點選右上角 Settings (設定) ➡️ 左選單 Response settings (回應設定) / <strong>Official Account Manager</strong> 的回應設定。
                </Text>
              </li>
              <li>
                <Text size="sm">
                  在回應功能設定中，停用 <strong>Greeting messages</strong> (加入好友的歡迎訊息)。
                </Text>
              </li>
              <li>
                <Text size="sm">
                  在回應功能設定中，停用 <strong>Auto-reply messages</strong> (自動回應訊息)；且在詳細設定中開啟 Webhook (啟用)。
                </Text>
                <Checkbox
                  mt="xs"
                  mb="xs"
                  label="我已停用 Greeting messages 與 Auto-reply messages"
                  checked={form.nativeRepliesDisabledAcknowledged}
                  disabled={!lineActive || Boolean(action)}
                  onChange={(event) => {
                    const nativeRepliesDisabledAcknowledged = event.currentTarget.checked;
                    setForm((current) => ({
                      ...current,
                      nativeRepliesDisabledAcknowledged,
                    }));
                  }}
                />
              </li>
              <li>
                <Text size="sm">
                  確認勾選確認方塊後，<strong>回到本頁執行「檢查 LINE 就緒狀態」</strong>。
                </Text>
              </li>
            </ol>
          </details>
        ) : null}

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
            onClick={onOpenSettings}
            disabled={!lineActive || Boolean(action)}
          >
            設定客服基本資料
          </Button>
          <Button
            variant="light"
            onClick={onOpenFaq}
            disabled={!lineActive || Boolean(action)}
          >
            管理 FAQ 知識庫
          </Button>
          <Button
            variant="light"
            loading={action === "readiness"}
            disabled={!lineActive || !form.redeliveryAcknowledged || !form.nativeRepliesDisabledAcknowledged || Boolean(action)}
            onClick={onRefresh}
          >
            檢查 LINE 就緒狀態
          </Button>
          <Button
            variant="light"
            loading={action === "provider"}
            disabled={!configuration || !readiness?.checks?.providerConfigured || !readiness?.ready || Boolean(action)}
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
