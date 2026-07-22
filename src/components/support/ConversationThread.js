"use client";

import { Alert, Badge, Button, Group, Paper, Stack, Text, TextInput } from "@mantine/core";
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

  let pendingSeconds = 0;
  let pendingText = "";
  if (conversation.pendingTransition) {
    const effectiveTime = new Date(conversation.pendingTransition.effectiveAt).getTime();
    pendingSeconds = Math.max(0, Math.ceil((effectiveTime - Date.now()) / 1000));
    pendingText = conversation.pendingTransition.action === "resolve" ? "完成結案" : "交還 AI 處理";
  }

  return (
    <Paper withBorder p="md" radius="md" style={{ minWidth: 0, overflow: "hidden" }}>
      <Group justify="space-between" mb="sm">
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
        <Alert color="green" mb="sm">此對話已結案。</Alert>
      ) : null}
      {conversation.status === "waiting_human" ? (
        <Alert color="orange" mb="sm">等待真人客服接管處理。</Alert>
      ) : null}
      {transitionPending ? (
        <Alert color="blue" mb="sm">
          已排定變更：將在 <strong>{pendingSeconds}</strong> 秒內{pendingText}。期間 AI 暫停回應。
        </Alert>
      ) : null}
      {conversation.deliveryFailed ? (
        <Alert color="red" mb="sm">訊息傳送失敗，需注意。</Alert>
      ) : null}

      <Stack gap="xs" mih={220} style={{ overflowY: "auto" }}>
        {conversation.messages.map((message) => (
          <Paper
            key={message.id}
            p="xs"
            bg={message.direction === "outbound" ? "blue.0" : "gray.0"}
            ml={message.direction === "outbound" ? "auto" : 0}
            style={{ maxWidth: "88%", minWidth: 0 }}
          >
            <Stack gap={4}>
              <Text size="xs" c="dimmed">{SENDER_LABELS[message.senderType] || message.senderType}</Text>
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

      {!composerEnabled && !transitionPending ? (
        <Group mt="md">
          <Button onClick={() => onTakeOver?.()}>接管對話 (真人)</Button>
        </Group>
      ) : null}
      {composerEnabled ? (
        <Group mt="md">
          <Button variant="light" onClick={() => transition("return_to_ai")}>交還 AI 處理</Button>
          <Button color="green" onClick={() => transition("resolve")}>完成結案</Button>
        </Group>
      ) : null}

      {sendError ? <Alert color="red" mt="md">{sendError}</Alert> : null}

      <Group mt="md" wrap="nowrap">
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
    </Paper>
  );
}
