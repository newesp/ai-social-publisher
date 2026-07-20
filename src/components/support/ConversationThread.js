"use client";

import { Alert, Button, Group, Paper, Stack, Text, TextInput } from "@mantine/core";
import { useState } from "react";

export function ConversationThread({ conversation, loading, error, onBack, mobile, onTakeOver, onSendMessage, onTransition }) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  if (loading) return <Paper withBorder p="md"><Text c="dimmed">Loading conversation…</Text></Paper>;
  if (error) return <Paper withBorder p="md"><Text c="red.7">Unable to load this conversation.</Text></Paper>;
  if (!conversation) return <Paper withBorder p="md"><Text c="dimmed">Select a conversation to view its retained messages.</Text></Paper>;
  const composerEnabled = conversation.status === "human_active";
  const transitionPending = Boolean(conversation.pendingTransition);
  const send = async () => { if (!draft.trim() || sending) return; setSending(true); try { await onSendMessage?.(draft.trim()); setDraft(""); } finally { setSending(false); } };
  const transition = async (action) => {
    if (action === "return_to_ai" && !window.confirm("Return this conversation to AI handling?")) return;
    await onTransition?.(action);
  };
  return <Paper withBorder p="md" radius="md" style={{ minWidth: 0, overflow: "hidden" }}>
    <Group justify="space-between" mb="sm">{mobile ? <Button variant="subtle" size="xs" onClick={onBack}>Back to inbox</Button> : <Text fw={600}>{conversation.customerLabel}</Text>}<Text size="xs" c="dimmed">{conversation.status}</Text></Group>
    {conversation.status === "resolved" ? <Alert color="green" mb="sm">This conversation is resolved.</Alert> : null}
    {conversation.status === "waiting_human" ? <Alert color="orange" mb="sm">Waiting for a human owner.</Alert> : null}
    {transitionPending ? <Alert color="blue" mb="sm">Transition scheduled. AI remains paused until it completes or is undone.</Alert> : null}
    {conversation.deliveryFailed ? <Alert color="red" mb="sm">A delivery issue needs attention.</Alert> : null}
    <Stack gap="xs" mih={220} style={{ overflowY: "auto" }}>{conversation.messages.map((message) => <Paper key={message.id} p="xs" bg={message.direction === "outbound" ? "blue.0" : "gray.0"} ml={message.direction === "outbound" ? "auto" : 0} style={{ maxWidth: "88%" }}><Text size="xs" c="dimmed">{message.senderType}</Text><Text style={{ whiteSpace: "pre-wrap" }}>{message.text || "Unsupported message type"}</Text></Paper>)}</Stack>
    {!composerEnabled && !transitionPending ? <Group mt="md"><Button onClick={() => onTakeOver?.()}>Take over</Button></Group> : null}
    {composerEnabled ? <Group mt="md"><Button variant="light" onClick={() => transition("return_to_ai")}>Return to AI</Button><Button color="green" onClick={() => transition("resolve")}>Resolve</Button></Group> : null}
    <Group mt="md" wrap="nowrap"><TextInput aria-label="Reply composer" value={draft} onChange={(event) => setDraft(event.currentTarget.value)} placeholder={composerEnabled ? "Write a reply" : "Activate human handling to draft a reply"} disabled={!composerEnabled} style={{ flex: 1, minWidth: 0 }} /><Button disabled={!composerEnabled || !draft.trim() || sending} loading={sending} onClick={send}>Send reply</Button></Group>
  </Paper>;
}
