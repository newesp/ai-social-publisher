"use client";

import { Alert, Button, Group, Stack, Text } from "@mantine/core";
import { useEffect, useState } from "react";

export function GlobalTransitionUndo({ transitions, onUndo, undoingTransitionId }) {
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!Array.isArray(transitions) || !transitions.length) return;
    const interval = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(interval);
  }, [transitions]);

  if (!Array.isArray(transitions) || !transitions.length) return null;

  return (
    <Stack gap="xs">
      {transitions.map((transition) => {
        const effectiveTime = new Date(transition.effectiveAt).getTime();
        const secondsLeft = Math.max(0, Math.ceil((effectiveTime - Date.now()) / 1000));
        const actionLabel = transition.action === "resolve" ? "完成結案" : "交還 AI 處理";
        return (
          <Alert key={transition.id} color="blue" title="已排定狀態變更">
            <Group justify="space-between" wrap="nowrap">
              <Text size="sm">
                客戶「{transition.customerLabel}」將在 <strong>{secondsLeft}</strong> 秒內{actionLabel}。
              </Text>
              <Button
                size="xs"
                variant="light"
                onClick={() => onUndo(transition)}
                loading={undoingTransitionId === transition.id}
              >
                復原 (取消)
              </Button>
            </Group>
          </Alert>
        );
      })}
    </Stack>
  );
}
