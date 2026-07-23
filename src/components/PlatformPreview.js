"use client";

import { Avatar, Group, Image, Modal, Paper, Stack, Text, Textarea } from "@mantine/core";
import { useState } from "react";

export function PlatformPreview({ data, content, onContentChange, displayName }) {
  if (data.platform === "meta") {
    return <MetaPreview data={data} content={content} onContentChange={onContentChange} displayName={displayName} />;
  }
  if (data.platform === "instagram") return <InstagramPreview data={data} />;
  return <LinePreview data={data} content={content} onContentChange={onContentChange} displayName={displayName} />;
}

function MetaPreview({ data, content, onContentChange, displayName }) {
  const [modalOpen, setModalOpen] = useState(false);

  return (
    <Paper withBorder radius={8} p="md">
      <Stack gap="sm">
        <Group gap="sm">
          <Avatar color="blue">f</Avatar>
          <div>
            <Text fw={700}>{displayName || "Meta"}</Text>
            <Text size="xs" c="dimmed">
              Facebook 動態消息預覽
            </Text>
          </div>
        </Group>
        <PreviewTextarea value={content} onChange={onContentChange} ariaLabel="Facebook 文案" />
        {data.preview.imageUrl ? (
          <>
            <Image
              src={data.preview.imageUrl}
              alt="Meta 預覽圖片"
              radius={6}
              fit="contain"
              h={240}
              style={{ cursor: "pointer", backgroundColor: "#f8f9fa" }}
              onClick={() => setModalOpen(true)}
            />
            <Modal opened={modalOpen} onClose={() => setModalOpen(false)} title="Meta 圖片完整視圖" size="lg" centered>
              <Image src={data.preview.imageUrl} alt="Meta 預覽全圖" radius={4} fit="contain" />
            </Modal>
          </>
        ) : null}
      </Stack>
    </Paper>
  );
}

function InstagramPreview({ data }) {
  return (
    <Paper withBorder radius={8} p="md">
      <Stack gap="sm">
        <Group gap="sm">
          <Avatar color="pink">IG</Avatar>
          <div>
            <Text fw={700}>newesp.tw</Text>
            <Text size="xs" c="dimmed">
              Instagram 1:1 動態消息預覽
            </Text>
          </div>
        </Group>
        <Image src={data.preview.imageUrl} alt="Instagram 預覽圖片" radius={6} fit="cover" h={260} />
        <Text size="sm" lineClamp={6} style={{ whiteSpace: "pre-wrap" }}>
          <strong>newesp.tw</strong> {data.preview.caption}
        </Text>
      </Stack>
    </Paper>
  );
}

function LinePreview({ data, content, onContentChange, displayName }) {
  const [modalOpen, setModalOpen] = useState(false);

  return (
    <Paper withBorder radius={8} p="md">
      <Stack gap="sm">
        <Group gap="sm">
          <Avatar color="green">L</Avatar>
          <div>
            <Text fw={700}>{displayName || "LINE"}</Text>
            <Text size="xs" c="dimmed">
              LINE 廣播預覽
            </Text>
          </div>
        </Group>
        <Paper bg="green.0" radius={8} p="sm">
          <PreviewTextarea value={content} onChange={onContentChange} ariaLabel="LINE 文案" />
        </Paper>
        {data.preview.imageUrl ? (
          <>
            <Image
              src={data.preview.imageUrl}
              alt="LINE 預覽圖片"
              radius={6}
              fit="contain"
              h={240}
              style={{ cursor: "pointer", backgroundColor: "#f8f9fa" }}
              onClick={() => setModalOpen(true)}
            />
            <Modal opened={modalOpen} onClose={() => setModalOpen(false)} title="LINE 圖片完整視圖" size="lg" centered>
              <Image src={data.preview.imageUrl} alt="LINE 預覽全圖" radius={4} fit="contain" />
            </Modal>
          </>
        ) : null}
      </Stack>
    </Paper>
  );
}

function PreviewTextarea({ value, onChange, ariaLabel }) {
  return (
    <Textarea
      aria-label={ariaLabel}
      autosize
      minRows={1}
      value={value}
      onChange={(event) => onChange?.(event.currentTarget.value)}
      variant="unstyled"
      styles={{
        input: {
          background: "transparent",
          border: 0,
          padding: 0,
          whiteSpace: "pre-wrap",
          lineHeight: 1.45,
          minHeight: 0,
          resize: "none",
        },
      }}
    />
  );
}
