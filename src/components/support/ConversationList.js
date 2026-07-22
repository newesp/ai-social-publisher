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
  return (
    <Paper withBorder p="sm" radius="md" style={{ minWidth: 0, overflow: "hidden" }}>
      <Group justify="space-between" mb="sm">
        <Text fw={600}>對話列表</Text>
        <Button size="xs" variant="subtle" onClick={onRefresh} loading={loading}>重新整理</Button>
      </Group>
      {state === "stale" ? <Text c="orange.7" size="sm" role="status">對話資料可能未即時更新，請點擊重新整理。</Text> : null}
      {recoveryState === "reconnecting" ? <Text c="blue.7" size="sm" role="status">正在重新連線更新對話…</Text> : null}
      {recoveryState === "recovered" ? <Text c="green.7" size="sm" role="status">對話資料已更新</Text> : null}
      {recoveryState === "recovery_failed" ? <Text c="red.7" size="sm" role="status">連線更新失敗，請重新整理</Text> : null}
      {state === "error" ? <Text c="red.7" size="sm" role="status">無法載入對話資料</Text> : null}
      {!loading && conversations.length === 0 ? <Text c="dimmed" size="sm">目前無對話紀錄</Text> : null}
      <Stack gap={4}>
        {conversations.map((conversation) => (
          <UnstyledButton key={conversation.id} onClick={() => onSelect(conversation.id)} style={{ textAlign: "left", width: "100%" }}>
            <Paper p="xs" bg={conversation.id === selectedId ? "blue.0" : undefined} radius="sm" style={{ minWidth: 0 }}>
              <Group justify="space-between" wrap="nowrap">
                <Text fw={600} truncate>{conversation.customerLabel || "客戶"}</Text>
                {conversation.unreadCount > 0 ? <Badge size="sm">{conversation.unreadCount}</Badge> : null}
              </Group>
              <Group gap="xs">
                <Badge size="xs" variant="light">{STATUS_LABELS[conversation.status] || conversation.status}</Badge>
                {conversation.deliveryFailed ? <Badge size="xs" color="red">傳送失敗</Badge> : null}
              </Group>
              <Text size="sm" c="dimmed" lineClamp={1}>{conversation.lastMessagePreview || "無訊息內容"}</Text>
            </Paper>
          </UnstyledButton>
        ))}
      </Stack>
      {hasMore ? <Button size="xs" mt="xs" aria-label="Load more" onClick={onLoadMore}>載入更多對話</Button> : null}
    </Paper>
  );
}
