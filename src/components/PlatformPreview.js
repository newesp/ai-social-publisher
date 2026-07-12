"use client";

import { Avatar, Group, Image, Paper, Stack, Text, Textarea } from "@mantine/core";

export function PlatformPreview({ data, content, onContentChange }) {
  if (data.platform === "meta") {
    return <MetaPreview data={data} content={content} onContentChange={onContentChange} />;
  }
  if (data.platform === "instagram") return <InstagramPreview data={data} />;
  return <LinePreview data={data} content={content} onContentChange={onContentChange} />;
}

function MetaPreview({ data, content, onContentChange }) {
  return (
    <Paper withBorder radius={8} p="md">
      <Stack gap="sm">
        <Group gap="sm">
          <Avatar color="blue">f</Avatar>
          <div>
            <Text fw={700}>New ESP</Text>
            <Text size="xs" c="dimmed">
              Facebook feed preview
            </Text>
          </div>
        </Group>
        <PreviewTextarea value={content} onChange={onContentChange} ariaLabel="Facebook 文案" />
        {data.preview.imageUrl ? (
          <Image src={data.preview.imageUrl} alt="Meta preview image" radius={6} fit="cover" h={220} />
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
              Instagram 1:1 feed preview
            </Text>
          </div>
        </Group>
        <Image src={data.preview.imageUrl} alt="Instagram preview image" radius={6} fit="cover" h={260} />
        <Text size="sm" lineClamp={6} style={{ whiteSpace: "pre-wrap" }}>
          <strong>newesp.tw</strong> {data.preview.caption}
        </Text>
      </Stack>
    </Paper>
  );
}

function LinePreview({ data, content, onContentChange }) {
  return (
    <Paper withBorder radius={8} p="md">
      <Stack gap="sm">
        <Group gap="sm">
          <Avatar color="green">L</Avatar>
          <div>
            <Text fw={700}>New ESP 官方帳號</Text>
            <Text size="xs" c="dimmed">
              LINE broadcast preview
            </Text>
          </div>
        </Group>
        <Paper bg="green.0" radius={8} p="sm">
          <PreviewTextarea value={content} onChange={onContentChange} ariaLabel="LINE 文案" />
        </Paper>
        {data.preview.imageUrl ? (
          <Image src={data.preview.imageUrl} alt="LINE preview image" radius={6} fit="cover" h={180} />
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
