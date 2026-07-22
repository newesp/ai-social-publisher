"use client";
import { Badge, Paper, Stack, Text } from "@mantine/core";

const REASON_LABELS = Object.freeze({
  explicit_human_request: "客戶要求真人客服",
  insufficient_knowledge: "尚無相關 FAQ 知識庫條目",
  high_risk_refund: "退款風險預防",
  high_risk_payment: "付款/帳單安全預防",
  high_risk_personal_data: "個人資料安全預防",
  unsupported_request: "不支援的請求類型",
  invalid_ai_decision: "AI 決策無法成立",
  non_text: "收到非文字訊息 (圖片/貼圖)",
  configuration_unready: "客服基本設定未就緒",
  support_disabled: "AI 客服未啟用",
  human_controlled: "真人客服掌控中",
});

const STATUS_LABELS = Object.freeze({
  ai_active: "AI 自動回應中",
  human_active: "真人客服處理中",
  waiting_human: "等待真人接管",
  resolve_pending: "結案處理中 (倒數中)",
  return_to_ai_pending: "轉回 AI 中 (倒數中)",
  resolved: "已結案",
});

export function ConversationDetailsDrawer({ conversation }) {
  if (!conversation) return null;
  const statusLabel = STATUS_LABELS[conversation.status] || conversation.status;
  const handoffLabel = REASON_LABELS[conversation.handoffReason] || conversation.handoffReason;
  const pendingActionLabel = conversation.pendingTransition?.action === "resolve"
    ? "完成結案"
    : conversation.pendingTransition?.action === "return_to_ai"
      ? "交還 AI 處理"
      : conversation.pendingTransition?.action;
  const latestHandoff = conversation.decisions?.find((decision) => decision.action === "handoff") ?? null;

  return (
    <Paper withBorder p="md" radius="md" style={{ minWidth: 0, height: "100%", overflowY: "auto" }}>
      <Stack gap="sm">
        <Text fw={600}>對話詳細資訊</Text>
        <Badge variant="light">{statusLabel}</Badge>
        {conversation.handoffReason ? (
          <Text size="sm">轉交原因: {handoffLabel}</Text>
        ) : null}
        {conversation.pendingTransition ? (
          <Text size="sm">預定變更: {pendingActionLabel}</Text>
        ) : null}
        <Text size="sm" fw={500}>AI 參考之 FAQ 知識庫 (RAG 回覆)</Text>
        {conversation.faqSources?.length ? (
          conversation.faqSources.map((faq) => (
            <Text key={faq.id} size="sm">
              [{faq.category || "未分類"}] {faq.question}
            </Text>
          ))
        ) : (
          <Text c="dimmed" size="sm">此對話未採納或無相關 FAQ 來源。</Text>
        )}
        {latestHandoff ? (
          <Stack gap={4} mt="xs">
            <Text size="sm" fw={500}>人工接手指引</Text>
            {latestHandoff.handoffSummary ? <Text size="sm">{latestHandoff.handoffSummary}</Text> : null}
            {latestHandoff.humanChecklist?.length ? (
              <Text size="sm">接手前確認：{latestHandoff.humanChecklist.join("；")}</Text>
            ) : null}
            {latestHandoff.prohibitedCommitments?.length ? (
              <Text size="sm" c="orange">避免承諾：{latestHandoff.prohibitedCommitments.join("；")}</Text>
            ) : null}
          </Stack>
        ) : null}
      </Stack>
    </Paper>
  );
}
