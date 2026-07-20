"use client";
import { Badge, Paper, Stack, Text } from "@mantine/core";
export function ConversationDetailsDrawer({ conversation }) {
  if (!conversation) return null;
  return <Paper withBorder p="md" radius="md" style={{ minWidth: 0 }}><Stack gap="sm"><Text fw={600}>Conversation details</Text><Badge variant="light">{conversation.status}</Badge>{conversation.handoffReason ? <Text size="sm">Handoff: {conversation.handoffReason}</Text> : null}{conversation.pendingTransition ? <Text size="sm">Pending: {conversation.pendingTransition.action}</Text> : null}<Text size="sm" fw={500}>Decision sources</Text>{conversation.faqSources.length ? conversation.faqSources.map((faq) => <Text key={faq.id} size="sm">{faq.question}</Text>) : <Text c="dimmed" size="sm">No FAQ sources retained.</Text>}</Stack></Paper>;
}
