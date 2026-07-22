"use client";
import { Badge, Button, Group, Paper, Stack, Text, UnstyledButton } from "@mantine/core";

const STATUS_LABELS = Object.freeze({
  ai_active: "AI 自動回應中",
  human_active: "真人客服處理中",
  waiting_human: "等待真人接管",
  resolve_pending: "結案處理中",
  return_to_ai_pending: "轉回 AI 中",
  resolved: "已結案",
});

export function ConversationList({ conversations, selectedId, loading, onSelect, onRefresh, onLoadMore, hasMore, state, recoveryState }) {
  const hasStatusMessage = state === "stale" || recoveryState === "reconnecting" || recoveryState === "recovered" || recoveryState === "recovery_failed" || state === "error";

  return (
    <Paper withBorder p="sm" radius="md" style={{ minWidth: 0, height: "100%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <Group justify="space-between" mb="sm" style={{ flexShrink: 0 }}>
        <Text fw={600}>對話列表</Text>
        <Button size="xs" variant="subtle" onClick={onRefresh} loading={loading}>重新整理</Button>
      </Group>

      <Stack gap={4} style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
        {!loading && conversations.length === 0 ? <Text c="dimmed" size="sm">目前無對話紀錄</Text> : null}
        {conversations.map((conversation) => (
          <UnstyledButton key={conversation.id} onClick={() => onSelect(conversation.id)} style={{ textAlign: "left", width: "100%" }}>
            <Paper p="xs" bg={conversation.id === selectedId ? "blue.0" : undefined} radius="sm" style={{ minWidth: 0 }}>
              <Group justify="space-between" wrap="nowrap">
                <Text fw={600} truncate>{conversation.customerLabel || "客戶"}</Text>
                <Group gap="xs" wrap="nowrap" style={{ flexShrink: 0 }}>
                  {conversation.updatedAt || conversation.lastInboundAt ? (
                    <Text size="xs" c="dimmed">
                      {formatDateTime(conversation.updatedAt || conversation.lastInboundAt)}
                    </Text>
                  ) : null}
                  {conversation.unreadCount > 0 ? <Badge size="sm">{conversation.unreadCount}</Badge> : null}
                </Group>
              </Group>
              <Group gap="xs">
                <Badge size="xs" variant="light">{STATUS_LABELS[conversation.status] || conversation.status}</Badge>
                {conversation.deliveryFailed ? <Badge size="xs" color="red">傳送失敗</Badge> : null}
              </Group>
              <Text size="sm" c="dimmed" lineClamp={1}>{conversation.lastMessagePreview || "無訊息內容"}</Text>
            </Paper>
          </UnstyledButton>
        ))}
        {hasMore ? <Button size="xs" mt="xs" aria-label="Load more" onClick={onLoadMore}>載入更多對話</Button> : null}
      </Stack>

      {hasStatusMessage ? (
        <Paper p="xs" bg="gray.1" radius="sm" mt="xs" style={{ flexShrink: 0 }}>
          {state === "stale" ? <Text c="orange.7" size="xs" role="status">對話資料可能未即時更新，請點擊重新整理。</Text> : null}
          {recoveryState === "reconnecting" ? <Text c="blue.7" size="xs" role="status">正在重新連線更新對話…</Text> : null}
          {recoveryState === "recovered" ? <Text c="green.7" size="xs" role="status">對話資料已更新</Text> : null}
          {recoveryState === "recovery_failed" ? <Text c="red.7" size="xs" role="status">連線更新失敗，請重新整理</Text> : null}
          {state === "error" ? <Text c="red.7" size="xs" role="status">無法載入對話資料</Text> : null}
        </Paper>
      ) : null}
    </Paper>
  );
}

function formatDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  return `${yyyy}/${mm}/${dd} ${hh}:${min}`;
}

