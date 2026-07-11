"use client";

import { useMemo, useRef, useState } from "react";
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
import { DateInput } from "@mantine/dates";
import { IconCalendar, IconRefresh, IconSend } from "@tabler/icons-react";
import { createDraftTargets } from "../lib/content/draft-content.js";
import { buildPlatformPreviews } from "../lib/platform-preview/build-platform-previews.js";
import { ACTIVE_PLATFORMS } from "../lib/platforms/platform-config.js";
import { buildPostSubmission, SCHEDULE_TIME } from "../lib/wizard/post-submission.js";
import { WIZARD_STEPS, getInitialPostForm, shouldGenerateOnPreviewAdvance } from "../lib/wizard/wizard-flow.js";
import { PlatformPreview } from "./PlatformPreview.js";

export function CreatePostWizard() {
  const productNameRef = useRef(null);
  const productFeaturesRef = useRef(null);
  const [active, setActive] = useState(0);
  const [form, setForm] = useState(getInitialPostForm);
  const [imageUrl, setImageUrl] = useState(null);
  const [generatedTargets, setGeneratedTargets] = useState(null);
  const [generationStatus, setGenerationStatus] = useState("idle");
  const [generationError, setGenerationError] = useState("");
  const [publishStatus, setPublishStatus] = useState("idle");
  const [publishResult, setPublishResult] = useState(null);

  const targets = useMemo(() => generatedTargets ?? createDraftTargets(form), [form, generatedTargets]);
  const previews = useMemo(() => buildPlatformPreviews({ imageUrl, targets }), [imageUrl, targets]);
  const updateForm = (nextForm) => {
    setForm(nextForm);
    setGeneratedTargets(null);
    setGenerationStatus("idle");
    setImageUrl(null);
  };

  return (
    <Stack gap="lg">
      <div>
        <Title order={2}>建立貼文</Title>
        <Text c="dimmed">建立內容、檢視可編輯預覽，然後立即發布或排程。</Text>
      </div>

      <Paper withBorder radius={8} p="lg">
        <Stepper active={active} onStepClick={setActive}>
          <Stepper.Step label="商品資訊">
            <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md" mt="md">
              <TextInput ref={productNameRef} name="productName" label="商品名稱" value={form.productName} onChange={(event) => updateForm({ ...form, productName: event.currentTarget.value })} />
              <Select label="目標受眾" value={form.audience} onChange={(audience) => updateForm({ ...form, audience: audience ?? "general" })} data={[{ value: "young", label: "年輕族群" }, { value: "professional", label: "專業人士" }, { value: "family", label: "家庭" }, { value: "senior", label: "熟齡族群" }, { value: "general", label: "一般大眾" }]} />
            </SimpleGrid>
            <Textarea ref={productFeaturesRef} name="productFeatures" mt="md" minRows={4} label="商品特色" value={form.productFeatures} onChange={(event) => updateForm({ ...form, productFeatures: event.currentTarget.value })} />
            <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md" mt="md">
              <Select label="內容語氣" value={form.tone} onChange={(tone) => updateForm({ ...form, tone: tone ?? "friendly" })} data={[{ value: "professional", label: "專業" }, { value: "active", label: "活潑" }, { value: "friendly", label: "親切" }, { value: "premium", label: "高質感" }, { value: "humor", label: "幽默" }]} />
              <Checkbox.Group label="發布平台" value={form.platforms} onChange={(platforms) => updateForm({ ...form, platforms })}>
                <Group mt="xs">{ACTIVE_PLATFORMS.map((option) => <Checkbox key={option.value} value={option.value} label={option.label} />)}</Group>
              </Checkbox.Group>
            </SimpleGrid>
          </Stepper.Step>

          <Stepper.Step label="AI 供應商">
            <SimpleGrid cols={{ base: 1, md: 2 }} spacing="lg" mt="md">
              <Stack><Text fw={600}>LLM 供應商</Text><SegmentedControl value={form.llmProvider} onChange={(llmProvider) => updateForm({ ...form, llmProvider })} data={[{ label: "Gemini", value: "google" }, { label: "OpenAI", value: "openai" }]} /></Stack>
              <Stack><Text fw={600}>圖片供應商</Text><SegmentedControl value={form.imageProvider} onChange={(imageProvider) => updateForm({ ...form, imageProvider })} data={[{ label: "Google Gemini Image", value: "google" }, { label: "OpenAI GPT Image", value: "openai" }]} /></Stack>
            </SimpleGrid>
          </Stepper.Step>

          <Stepper.Step label="預覽與發布">
            <Group justify="space-between" mt="md" mb="sm">
              <Text fw={600}>編輯要送出的內容</Text>
              <Button variant="light" leftSection={<IconRefresh size={16} />} loading={generationStatus === "loading"} onClick={() => regenerateContent({ form, setGeneratedTargets, setImageUrl, setGenerationStatus, setGenerationError })}>重新產生</Button>
            </Group>
            {generationStatus === "loading" ? <Text c="dimmed" size="sm" mb="sm">正在產生內容…</Text> : null}
            {generationError ? <Text c="red.7" size="sm" mb="sm">{generationError}</Text> : null}
            <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="md">
              {Object.values(previews).map((preview) => <PlatformPreview key={preview.platform} data={preview} content={targets.find((target) => target.platform === preview.platform)?.content ?? ""} onContentChange={(content) => setGeneratedTargets(targets.map((target) => target.platform === preview.platform ? { ...target, content } : target))} />)}
            </SimpleGrid>
            <Paper withBorder mt="md" p="md">
              <Text fw={600} mb="sm">發布方式</Text>
              <SegmentedControl value={form.mode} onChange={(mode) => setForm({ ...form, mode })} data={[{ label: "立即發布", value: "now" }, { label: "排程發布", value: "scheduled" }]} />
              {form.mode === "scheduled" ? <SimpleGrid cols={{ base: 1, sm: 2 }} mt="sm"><DateInput label="發布日期" value={form.scheduledDate ?? null} onChange={(scheduledDate) => setForm({ ...form, scheduledDate: scheduledDate ?? "" })} valueFormat="YYYY-MM-DD" minDate={new Date()} clearable={false} /><Select label="發布時間（台北）" value={form.scheduledTime ?? SCHEDULE_TIME} onChange={(scheduledTime) => setForm({ ...form, scheduledTime: scheduledTime ?? SCHEDULE_TIME })} data={[{ value: "09:00", label: "09:00" }]} /></SimpleGrid> : null}
            </Paper>
            {publishResult ? <Stack gap={4} mt="md"><Badge color={publishResult.status === "failed" ? "red" : publishResult.status === "scheduled" ? "orange" : "green"}>{publishResult.status}</Badge>{publishResult.targets?.map((target) => <Text key={target.id ?? target.platform} size="sm" c={target.status === "failed" ? "red.7" : "green.7"}>{target.platform}: {target.status}{target.errorMessage ? ` - ${target.errorMessage}` : ""}</Text>)}</Stack> : null}
          </Stepper.Step>
        </Stepper>

        <Group justify="space-between" mt="xl">
          <Button variant="default" onClick={() => setActive((step) => Math.max(0, step - 1))}>上一步</Button>
          {active < WIZARD_STEPS.PREVIEW ? <Button disabled={generationStatus === "loading"} onClick={() => goToNextStep({ active, form, generatedTargets, productNameRef, productFeaturesRef, setForm, setGeneratedTargets, setGenerationStatus, setGenerationError, setImageUrl, setActive })}>下一步</Button> : <Button leftSection={form.mode === "scheduled" ? <IconCalendar size={16} /> : <IconSend size={16} />} loading={publishStatus === "loading"} disabled={generationStatus === "loading"} onClick={() => submitPost({ form, targets, imageUrl, setPublishStatus, setPublishResult })}>{form.mode === "scheduled" ? "安排 09:00 發布" : "立即發布"}</Button>}
        </Group>
      </Paper>
    </Stack>
  );
}

function goToNextStep({ active, form, generatedTargets, productNameRef, productFeaturesRef, setForm, setGeneratedTargets, setGenerationStatus, setGenerationError, setImageUrl, setActive }) {
  const nextStep = Math.min(WIZARD_STEPS.PREVIEW, active + 1);
  const syncedForm = { ...form, productName: productNameRef.current?.value ?? form.productName, productFeatures: productFeaturesRef.current?.value ?? form.productFeatures };
  if (syncedForm.productName !== form.productName || syncedForm.productFeatures !== form.productFeatures) {
    setForm(syncedForm); setGeneratedTargets(null); setGenerationStatus("idle"); setImageUrl(null);
  }
  setActive(nextStep);
  if (shouldGenerateOnPreviewAdvance({ currentStep: active, nextStep, hasGeneratedTargets: Boolean(generatedTargets) })) regenerateContent({ form: syncedForm, setGeneratedTargets, setImageUrl, setGenerationStatus, setGenerationError });
}

async function regenerateContent({ form, setGeneratedTargets, setImageUrl, setGenerationStatus, setGenerationError }) {
  setGenerationStatus("loading"); setGenerationError("");
  try {
    const response = await fetch("/api/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "內容產生失敗。");
    setGeneratedTargets(data.targets); setImageUrl(data.imageUrl ?? null); setGenerationStatus("success");
  } catch (error) { setGenerationError(error.message); setGenerationStatus("error"); }
}

async function submitPost({ form, targets, imageUrl, setPublishStatus, setPublishResult }) {
  setPublishStatus("loading"); setPublishResult(null);
  try {
    const payload = buildPostSubmission({ form, targets, imageUrl });
    const response = await fetch("/api/posts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "建立貼文失敗。");
    setPublishResult(data.post); setPublishStatus("done");
  } catch (error) { setPublishResult({ status: "failed", targets: [{ platform: "system", status: "failed", errorMessage: error.message }] }); setPublishStatus("error"); }
}
