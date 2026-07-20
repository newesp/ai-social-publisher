"use client";

import { Alert, Button, Group, Stack, Text } from "@mantine/core";

export function GlobalTransitionUndo({ transitions, onUndo, undoingTransitionId }) {
  if (!Array.isArray(transitions) || !transitions.length) return null;
  return <Stack gap="xs">{transitions.map((transition) => <Alert key={transition.id} color="blue" title="Transition scheduled"><Group justify="space-between" wrap="nowrap"><Text size="sm">{transition.customerLabel} will {transition.action === "resolve" ? "be resolved" : "return to AI"} in ten seconds.</Text><Button size="xs" variant="light" onClick={() => onUndo(transition)} loading={undoingTransitionId === transition.id}>Undo</Button></Group></Alert>)}</Stack>;
}
