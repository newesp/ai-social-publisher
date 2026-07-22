"use client";

import { Alert, Portal } from "@mantine/core";

export function FloatingAlert({ color = "blue", title, children, onClose, withCloseButton = true, style }) {
  if (!children && !title) return null;
  return (
    <Portal>
      <div
        role="status"
        aria-live="polite"
        style={{
          position: "fixed",
          top: 20,
          left: "50%",
          transform: "translateX(-50%)",
          zIndex: 1000,
          width: "auto",
          maxWidth: "90vw",
          minWidth: 300,
          boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
          borderRadius: 8,
          overflow: "hidden",
          ...style,
        }}
      >
        <Alert color={color} title={title} withCloseButton={Boolean(onClose) || withCloseButton} onClose={onClose}>
          {children}
        </Alert>
      </div>
    </Portal>
  );
}
