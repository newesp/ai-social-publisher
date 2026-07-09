"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Badge,
  Button,
  Checkbox,
  Group,
  Paper,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Stepper,
  Text,
  Textarea,
  TextInput,
  Title,
} from "@mantine/core";
import { IconRefresh, IconSend } from "@tabler/icons-react";
import { createDraftTargets } from "../lib/content/draft-content.js";
import { buildPlatformPreviews } from "../lib/platform-preview/build-platform-previews.js";
import { ACTIVE_PLATFORMS } from "../lib/platforms/platform-config.js";
import { PlatformPreview } from "./PlatformPreview.js";

export function CreatePostWizard() {
  const productNameRef = useRef(null);
  const productFeaturesRef = useRef(null);
  const [active, setActive] = useState(0);
  const [form, setForm] = useState({
    productName: "New ESP 展示商品",
    productFeatures: "快速建立社群文案、跨平台預覽、立即發布。",
    audience: "professional",
    tone: "friendly",
    platforms: ["meta", "line"],
    llmProvider: "google",
    imageProvider: "google",
    mode: "now",
  });
  const [imageUrl, setImageUrl] = useState(null);
  const [generatedTargets, setGeneratedTargets] = useState(null);
  const [generationStatus, setGenerationStatus] = useState("idle");
  const [generationError, setGenerationError] = useState("");
  const [publishStatus, setPublishStatus] = useState("idle");
  const [publishResult, setPublishResult] = useState(null);

  const targets = useMemo(
    () => {
      if (generatedTargets) return generatedTargets;

      return createDraftTargets(form);
    },
    [form, generatedTargets],
  );

  const previews = useMemo(() => buildPlatformPreviews({ imageUrl, targets }), [imageUrl, targets]);

  useEffect(() => {
    if (active === 2 && generationStatus === "idle") {
      regenerateContent({
        form,
        setGeneratedTargets,
        setImageUrl,
        setGenerationStatus,
        setGenerationError,
      });
    }
  }, [active, form, generationStatus]);

  return (
    <Stack gap="lg">
      <div>
        <Title order={2}>新增貼文</Title>
        <Text c="dimmed">輸入商品資訊，生成各平台文案，確認實際預覽後再發布。</Text>
      </div>

      <Paper withBorder radius={8} p="lg">
        <Stepper active={active} onStepClick={setActive}>
          <Stepper.Step label="產品資訊">
            <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md" mt="md">
              <TextInput
                ref={productNameRef}
                name="productName"
                label="產品名稱"
                value={form.productName}
                onInput={(event) =>
                  updateProductForm(
                    { ...form, productName: event.currentTarget.value },
                    setForm,
                    setGeneratedTargets,
                    setGenerationStatus,
                    setImageUrl,
                  )
                }
                onChange={(event) =>
                  updateProductForm(
                    { ...form, productName: event.currentTarget.value },
                    setForm,
                    setGeneratedTargets,
                    setGenerationStatus,
                    setImageUrl,
                  )
                }
                onBlur={(event) =>
                  updateProductForm(
                    { ...form, productName: event.currentTarget.value },
                    setForm,
                    setGeneratedTargets,
                    setGenerationStatus,
                    setImageUrl,
                  )
                }
              />
              <Select
                label="目標受眾"
                value={form.audience}
                onChange={(value) =>
                  updateProductForm(
                    { ...form, audience: value },
                    setForm,
                    setGeneratedTargets,
                    setGenerationStatus,
                    setImageUrl,
                  )
                }
                data={[
                  { value: "young", label: "年輕族群" },
                  { value: "professional", label: "專業人士" },
                  { value: "family", label: "家庭主婦" },
                  { value: "senior", label: "銀髮族" },
                  { value: "general", label: "通用" },
                ]}
              />
            </SimpleGrid>
            <Textarea
              ref={productFeaturesRef}
              name="productFeatures"
              mt="md"
              minRows={4}
              label="核心特點"
              value={form.productFeatures}
              onInput={(event) =>
                updateProductForm(
                  { ...form, productFeatures: event.currentTarget.value },
                  setForm,
                  setGeneratedTargets,
                  setGenerationStatus,
                  setImageUrl,
                )
              }
              onChange={(event) =>
                updateProductForm(
                  { ...form, productFeatures: event.currentTarget.value },
                  setForm,
                  setGeneratedTargets,
                  setGenerationStatus,
                  setImageUrl,
                )
              }
              onBlur={(event) =>
                updateProductForm(
                  { ...form, productFeatures: event.currentTarget.value },
                  setForm,
                  setGeneratedTargets,
                  setGenerationStatus,
                  setImageUrl,
                )
              }
            />
            <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md" mt="md">
              <Select
                label="語氣風格"
                value={form.tone}
                onChange={(value) =>
                  updateProductForm(
                    { ...form, tone: value },
                    setForm,
                    setGeneratedTargets,
                    setGenerationStatus,
                    setImageUrl,
                  )
                }
                data={[
                  { value: "professional", label: "專業" },
                  { value: "active", label: "活潑" },
                  { value: "friendly", label: "親切" },
                  { value: "premium", label: "高級感" },
                  { value: "humor", label: "幽默" },
                ]}
              />
              <Checkbox.Group
                label="發文平台"
                value={form.platforms}
                onChange={(platforms) =>
                  updateProductForm(
                    { ...form, platforms },
                    setForm,
                    setGeneratedTargets,
                    setGenerationStatus,
                    setImageUrl,
                  )
                }
              >
                <Group mt="xs">
                  {ACTIVE_PLATFORMS.map((option) => (
                    <Checkbox key={option.value} value={option.value} label={option.label} />
                  ))}
                </Group>
              </Checkbox.Group>
            </SimpleGrid>
          </Stepper.Step>

          <Stepper.Step label="AI Provider">
            <SimpleGrid cols={{ base: 1, md: 2 }} spacing="lg" mt="md">
              <Stack>
                <Text fw={600}>LLM Provider</Text>
                <SegmentedControl
                  value={form.llmProvider}
                  onChange={(value) =>
                    updateProductForm(
                      { ...form, llmProvider: value },
                      setForm,
                      setGeneratedTargets,
                      setGenerationStatus,
                      setImageUrl,
                    )
                  }
                  data={[
                    { label: "Gemini", value: "google" },
                    { label: "OpenAI", value: "openai" },
                  ]}
                />
                <Badge color="orange" variant="light">
                  Gemini 預設 gemini-3.5-flash
                </Badge>
              </Stack>
              <Stack>
                <Text fw={600}>Image Provider</Text>
                <SegmentedControl
                  value={form.imageProvider}
                  onChange={(value) =>
                    updateProductForm(
                      { ...form, imageProvider: value },
                      setForm,
                      setGeneratedTargets,
                      setGenerationStatus,
                      setImageUrl,
                    )
                  }
                  data={[
                    { label: "Google Gemini Image", value: "google" },
                    { label: "OpenAI GPT Image", value: "openai" },
                  ]}
                />
                <Badge color="teal" variant="light">
                  Google 預設 gemini-3.1-flash-image
                </Badge>
                <Badge color="blue" variant="light">
                  OpenAI 預設 gpt-image-2
                </Badge>
              </Stack>
            </SimpleGrid>
          </Stepper.Step>

          <Stepper.Step label="預覽與編輯">
            <Group justify="space-between" mt="md" mb="sm">
              <Text fw={600}>平台實際預覽</Text>
              <Button
                variant="light"
                leftSection={<IconRefresh size={16} />}
                loading={generationStatus === "loading"}
                onClick={() =>
                  regenerateContent({
                    form,
                    setGeneratedTargets,
                    setImageUrl,
                    setGenerationStatus,
                    setGenerationError,
                  })
                }
              >
                重新生成
              </Button>
            </Group>
            {generationStatus === "loading" ? (
              <Text c="dimmed" size="sm" mb="sm">
                AI 正在根據產品資訊生成文案與圖片...
              </Text>
            ) : null}
            {generationError ? (
              <Text c="red.7" size="sm" mb="sm">
                {generationError}
              </Text>
            ) : null}
            <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="md">
              {Object.values(previews).map((preview) => (
                <PlatformPreview
                  key={preview.platform}
                  data={preview}
                  content={targets.find((target) => target.platform === preview.platform)?.content ?? ""}
                  onContentChange={(content) =>
                    updateTargetContent({
                      platform: preview.platform,
                      content,
                      targets,
                      setGeneratedTargets,
                    })
                  }
                />
              ))}
            </SimpleGrid>
          </Stepper.Step>

          <Stepper.Step label="發文設定">
            <SimpleGrid cols={{ base: 1 }} spacing="md" mt="md">
              <Stack>
                <Text fw={600}>最終確認</Text>
                {form.platforms.map((platform) => (
                  <Checkbox key={platform} checked readOnly label={`${platform} 預覽與 payload 已同步`} />
                ))}
                <Button
                  leftSection={<IconSend size={16} />}
                  loading={publishStatus === "loading"}
                  onClick={() => publishNow(targets, imageUrl, setPublishStatus, setPublishResult)}
                >
                  確認發文
                </Button>
                {publishResult ? (
                  <Stack gap={4}>
                    {publishResult.results?.map((result) => (
                      <Text
                        key={result.platform}
                        size="sm"
                        c={result.status === "published" ? "green.7" : "red.7"}
                      >
                        {result.platform}: {result.status}
                        {result.error ? ` - ${result.error}` : ""}
                      </Text>
                    ))}
                  </Stack>
                ) : null}
              </Stack>
            </SimpleGrid>
          </Stepper.Step>
        </Stepper>

        <Group justify="space-between" mt="xl">
          <Button variant="default" onClick={() => setActive((step) => Math.max(0, step - 1))}>
            上一步
          </Button>
          {active < 3 ? (
            <Button
              onClick={() =>
                goToNextStep({
                  form,
                  productNameRef,
                  productFeaturesRef,
                  setForm,
                  setGeneratedTargets,
                  setGenerationStatus,
                  setImageUrl,
                  setActive,
                })
              }
            >
              下一步
            </Button>
          ) : null}
        </Group>
      </Paper>
    </Stack>
  );
}

function updateProductForm(
  nextForm,
  setForm,
  setGeneratedTargets,
  setGenerationStatus,
  setImageUrl,
) {
  setForm(nextForm);
  setGeneratedTargets(null);
  setGenerationStatus?.("idle");
  setImageUrl?.(null);
}

function goToNextStep({
  form,
  productNameRef,
  productFeaturesRef,
  setForm,
  setGeneratedTargets,
  setGenerationStatus,
  setImageUrl,
  setActive,
}) {
  const syncedForm = {
    ...form,
    productName:
      document.querySelector('[name="productName"]')?.value ??
      productNameRef.current?.value ??
      form.productName,
    productFeatures:
      document.querySelector('[name="productFeatures"]')?.value ??
      productFeaturesRef.current?.value ??
      form.productFeatures,
  };

  if (
    syncedForm.productName !== form.productName ||
    syncedForm.productFeatures !== form.productFeatures
  ) {
    updateProductForm(syncedForm, setForm, setGeneratedTargets, setGenerationStatus, setImageUrl);
  }
  setActive((step) => Math.min(3, step + 1));
}

async function regenerateContent({
  form,
  setGeneratedTargets,
  setImageUrl,
  setGenerationStatus,
  setGenerationError,
}) {
  setGenerationStatus("loading");
  setGenerationError("");

  try {
    const response = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error ?? "AI 生成失敗。");
    }

    setGeneratedTargets(data.targets);
    setImageUrl(data.imageUrl ?? null);
    setGenerationError(data.imageError ? `圖片生成失敗：${data.imageError}` : "");
    setGenerationStatus("success");
  } catch (error) {
    setGenerationError(formatGenerationError(error.message));
    setGenerationStatus("error");
  }
}

function updateTargetContent({ platform, content, targets, setGeneratedTargets }) {
  setGeneratedTargets(
    targets.map((target) => (target.platform === platform ? { ...target, content } : target)),
  );
}

function platformLabel(platform) {
  if (platform === "meta") return "Facebook";
  if (platform === "line") return "LINE";
  return platform;
}

function formatGenerationError(message) {
  if (message.includes("API request failed: fetch failed")) {
    return `${message}。請確認 API key 是否正確、伺服器是否能連到外部 AI API，或切換另一個 LLM Provider。`;
  }

  return message;
}

async function publishNow(targets, imageUrl, setPublishStatus, setPublishResult) {
  setPublishStatus("loading");
  setPublishResult(null);

  try {
    const response = await fetch("/api/posts/manual/publish", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        targets,
        imageUrl,
      }),
    });
    const data = await response.json();

    setPublishResult(data);
    setPublishStatus(response.ok ? "done" : "error");
  } catch (error) {
    setPublishResult({
      results: [{ platform: "system", status: "failed", error: error.message }],
    });
    setPublishStatus("error");
  }
}
