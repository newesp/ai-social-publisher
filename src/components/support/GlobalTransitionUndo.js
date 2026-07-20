"use client";

import { Alert, Button, Group, Text } from "@mantine/core";

export function GlobalTransitionUndo({ transition, onUndo, undoing }) {
  if (!transition) return null;
  return <Alert color="blue" title="Transition scheduled"><Group justify="space-between" wrap="nowrap"><Text size="sm">{transition.customerLabel} will {transition.action === "resolve" ? "be resolved" : "return to AI"} in ten seconds.</Text><Button size="xs" variant="light" onClick={onUndo} loading={undoing}>Undo</Button></Group></Alert>;
}
