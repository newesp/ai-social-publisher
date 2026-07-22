"use client";

import { Alert, Badge, Button, Group, Paper, Portal, Stack, Text, TextInput } from "@mantine/core";
import { useEffect, useRef, useState } from "react";

const SENDER_LABELS = Object.freeze({
  customer: "客戶",
  human: "真人客服",
  ai: "AI 客服",
});

const STATUS_LABELS = Object.freeze({
  ai_active: "AI 自動回應中",
  human_active: "真人客服處理中",
  waiting_human: "等待真人接管",
  resolve_pending: "結案處理中 (倒數中)",
  return_to_ai_pending: "轉回 AI 中 (倒數中)",
  resolved: "已結案",
});

export function ConversationThread({
  conversation,
  loading,
  error,
  onBack,
  mobile,
  onTakeOver,
  onSendMessage,
  onRetryMessage,
  onTransition,
  onDeleteConversation,
}) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [retryingMessageId, setRetryingMessageId] = useState(null);
  const [, setTick] = useState(0);
  const idempotencyKeyRef = useRef(null);

  useEffect(() => {
    if (!conversation?.pendingTransition) return;
    const interval = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(interval);
  }, [conversation?.pendingTransition]);

  if (loading && !conversation) return <Paper withBorder p="md"><Text c="dimmed">載入對話內容中…</Text></Paper>;
  if (error && !conversation) return <Paper withBorder p="md"><Text c="red.7">無法載入此對話。</Text></Paper>;
  if (!conversation) return <Paper withBorder p="md"><Text c="dimmed">請選擇左側對話以檢視訊息紀錄。</Text></Paper>;

  const composerEnabled = conversation.status === "human_active";
  const transitionPending = Boolean(conversation.pendingTransition);

  const send = async () => {
    if (!draft.trim() || sending) return;
    idempotencyKeyRef.current ??= crypto.randomUUID();
    setSending(true);
    setSendError("");
    try {
      await onSendMessage?.(draft.trim(), idempotencyKeyRef.current);
      setDraft("");
      idempotencyKeyRef.current = null;
    } catch {
      setSendError("訊息傳送失敗。草稿已保留，請檢查 LINE 連線後再試。");
    } finally {
      setSending(false);
    }
  };

  const retry = async (messageId) => {
    if (retryingMessageId) return;
    setRetryingMessageId(messageId);
    setSendError("");
    try {
      await onRetryMessage?.(messageId);
    } catch {
      setSendError("訊息再次傳送失敗。請檢查 LINE 連線後重試。");
    } finally {
      setRetryingMessageId(null);
    }
  };

  const transition = async (action) => {
    if (action === "return_to_ai" && !window.confirm("確定要把此對話交還給 AI 自動處理嗎？")) return;
    await onTransition?.(action);
  };

  const deleteConv = async () => {
    if (!window.confirm("確定要刪除此對話紀錄嗎？刪除後相關 DB 資料將被一併移除且無法復原。")) return;
    setDeleting(true);
    try {
      await onDeleteConversation?.(conversation.id);
    } catch (err) {
      setSendError(err.message || "刪除對話失敗。");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Paper withBorder p="md" radius="md" style={{ minWidth: 0, height: "100%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      {sendError ? (
        <Portal>
          <div
            style={{
              position: "fixed",
              top: 20,
              left: "50%",
              transform: "translateX(-50%)",
              zIndex: 1000,
              width: "auto",
              maxWidth: "90vw",
              boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
            }}
          >
            <Alert color="red" title="操作失敗" withCloseButton onClose={() => setSendError("")}>
              {sendError}
            </Alert>
          </div>
        </Portal>
      ) : null}

      <Group justify="space-between" mb="sm" style={{ flexShrink: 0 }}>
        {mobile ? (
          <Button variant="subtle" size="xs" onClick={onBack}>返回列表</Button>
        ) : (
          <Text fw={600}>{conversation.customerLabel || "客戶"}</Text>
        )}
        <Group gap="xs">
          <Text size="xs" c="dimmed">{STATUS_LABELS[conversation.status] || conversation.status}</Text>
          <Button
            size="compact-xs"
            color="red"
            variant="subtle"
            loading={deleting}
            onClick={deleteConv}
          >
            刪除對話
          </Button>
        </Group>
      </Group>

      {conversation.status === "resolved" ? (
        <Alert color="green" mb="sm" style={{ flexShrink: 0 }}>此對話已結案。</Alert>
      ) : null}
      {conversation.status === "waiting_human" ? (
        <Alert color="orange" mb="sm" style={{ flexShrink: 0 }}>等待真人客服接管處理。</Alert>
      ) : null}
      {conversation.deliveryFailed ? (
        <Alert color="red" mb="sm" style={{ flexShrink: 0 }}>訊息傳送失敗，需注意。</Alert>
      ) : null}

      <Stack gap="xs" style={{ flex: 1, overflowY: "auto", minHeight: 0, paddingRight: 4 }}>
        {conversation.messages.map((message) => (
          <Paper
            key={message.id}
            p="xs"
            bg={message.direction === "outbound" ? "blue.0" : "gray.0"}
            ml={message.direction === "outbound" ? "auto" : 0}
            style={{ maxWidth: "88%", minWidth: 0 }}
          >
            <Stack gap={4}>
              <Group justify="space-between" gap="xs">
                <Text size="xs" c="dimmed">{SENDER_LABELS[message.senderType] || message.senderType}</Text>
                {message.createdAt ? (
                  <Text size="xs" c="dimmed">{formatDateTime(message.createdAt)}</Text>
                ) : null}
              </Group>
              <Text style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                {message.text || "不支援的訊息格式"}
              </Text>
              {message.senderType === "human" ? (
                <Group gap="xs" wrap="wrap">
                  <Badge
                    size="xs"
                    color={message.deliveryStatus === "sent" ? "green" : message.deliveryStatus === "failed" ? "red" : "blue"}
                  >
                    {message.deliveryStatus === "sent" ? "已傳送" : message.deliveryStatus === "failed" ? "傳送失敗" : "傳送中"}
                  </Badge>
                  {message.deliveryStatus === "failed" ? (
                    <Button
                      size="compact-xs"
                      variant="light"
                      color="red"
                      loading={retryingMessageId === message.id}
                      disabled={Boolean(retryingMessageId)}
                      onClick={() => retry(message.id)}
                    >
                      重試傳送
                    </Button>
                  ) : null}
                </Group>
              ) : null}
            </Stack>
          </Paper>
        ))}
      </Stack>

      <Stack gap="xs" mt="sm" style={{ flexShrink: 0, borderTop: "1px solid var(--mantine-color-gray-2)", paddingTop: 8 }}>
        {!composerEnabled && !transitionPending ? (
          <Group>
            <Button onClick={() => onTakeOver?.()}>接管對話 (真人)</Button>
          </Group>
        ) : null}
        {composerEnabled ? (
          <Group>
            <Button variant="light" onClick={() => transition("return_to_ai")}>交還 AI 處理</Button>
            <Button color="green" onClick={() => transition("resolve")}>完成結案</Button>
          </Group>
        ) : null}

        <Group wrap="nowrap">
          <TextInput
            aria-label="Reply composer"
            value={draft}
            onChange={(event) => {
              if (sendError && event.currentTarget.value !== draft) idempotencyKeyRef.current = null;
              setDraft(event.currentTarget.value);
              setSendError("");
            }}
            placeholder={composerEnabled ? "輸入回覆內容…" : "請先點擊「接管對話」以開始撰寫回覆"}
            disabled={!composerEnabled}
            style={{ flex: 1, minWidth: 0 }}
          />
          <Button disabled={!composerEnabled || !draft.trim() || sending} loading={sending} onClick={send}>
            傳送回覆
          </Button>
        </Group>
      </Stack>
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
