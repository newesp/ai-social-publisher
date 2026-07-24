"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Group,
  List,
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
import { IconAlertTriangle, IconCalendar, IconPlus, IconRefresh, IconSend } from "@tabler/icons-react";
import { createDraftTargets } from "../lib/content/draft-content.js";
import { buildPlatformPreviews } from "../lib/platform-preview/build-platform-previews.js";
import { ACTIVE_PLATFORMS } from "../lib/platforms/platform-config.js";
import { getPlatformLabel, getStatusLabel } from "../lib/posts/status-labels.js";
import { getImageModelOptions, getLLMModelOptions } from "../lib/ai/model-config.js";
import { fetchSessionOwner } from "../lib/auth/session-profile.js";
import { FloatingAlert } from "./FloatingAlert.js";
import { SCHEDULE_TIME } from "../lib/wizard/post-submission.js";
import {
  WIZARD_STEPS,
  canSelectWizardStep,
  getInitialPostForm,
  isProductStepComplete,
  reconcileConnectedPlatforms,
} from "../lib/wizard/wizard-flow.js";
import {
  clearWizardDraft,
  readWizardDraft,
  writeWizardDraft,
} from "../lib/wizard/wizard-draft-storage.js";
import { getPreferredModel, readModelPreferences, writeModelPreferences } from "../lib/wizard/model-preferences.js";
import { isSuccessfulPostResult, submitCheckedPost } from "../lib/wizard/wizard-submit.js";
import { PlatformPreview } from "./PlatformPreview.js";

export function CreatePostWizard() {
  const [active, setActive] = useState(WIZARD_STEPS.PRODUCT);
  const [form, setForm] = useState(getInitialPostForm);
  const [imageUrl, setImageUrl] = useState(null);
  const [generatedTargets, setGeneratedTargets] = useState(null);
  const [generationStatus, setGenerationStatus] = useState("idle");
  const [generationError, setGenerationError] = useState("");
  const [publishStatus, setPublishStatus] = useState("idle");
  const [publishResult, setPublishResult] = useState(null);
  const [proofreadIssues, setProofreadIssues] = useState([]);
  const [connectedPlatforms, setConnectedPlatforms] = useState([]);
  const [platformDisplayNames, setPlatformDisplayNames] = useState({});
  const [availabilityStatus, setAvailabilityStatus] = useState("loading");
  const [hydrated, setHydrated] = useState(false);
  const [draftOwner, setDraftOwner] = useState(null);
  const [sessionError, setSessionError] = useState("");
  const submissionInFlight = useRef(false);
  const draftOwnerRef = useRef(null);
  const sessionCheckInFlight = useRef(false);

  useEffect(() => {
    let current = true;
    const syncSessionOwner = async () => {
      if (sessionCheckInFlight.current) return;
      sessionCheckInFlight.current = true;
      try {
        const owner = await fetchSessionOwner();
        if (!current || draftOwnerRef.current === owner) return;
        draftOwnerRef.current = owner;
        setHydrated(false);
        const draft = readWizardDraft(undefined, owner);
        setDraftOwner(owner);
        setSessionError("");
        setGenerationError("");
        if (draft) {
          setActive(Number.isInteger(draft.active) ? draft.active : WIZARD_STEPS.PRODUCT);
          setForm({ ...getInitialPostForm(), ...draft.form });
          setImageUrl(draft.imageUrl ?? null);
          setGeneratedTargets(draft.generatedTargets ?? null);
          setGenerationStatus(draft.generationStatus ?? (draft.generatedTargets ? "success" : "idle"));
          setPublishStatus(draft.publishStatus ?? "idle");
          setPublishResult(draft.publishResult ?? null);
          setProofreadIssues(Array.isArray(draft.proofreadIssues) ? draft.proofreadIssues : []);
        } else {
          const preferences = readModelPreferences();
          setActive(WIZARD_STEPS.PRODUCT);
          setForm(getInitialPostForm(preferences));
          setImageUrl(null);
          setGeneratedTargets(null);
          setGenerationStatus("idle");
          setPublishStatus("idle");
          setPublishResult(null);
          setProofreadIssues([]);
        }
        setHydrated(true);
      } catch (error) {
        if (current) setSessionError(error.message);
      } finally {
        sessionCheckInFlight.current = false;
      }
    };
    syncSessionOwner();
    window.addEventListener("focus", syncSessionOwner);
    return () => {
      current = false;
      window.removeEventListener("focus", syncSessionOwner);
    };
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    writeWizardDraft(undefined, {
      active,
      form,
      imageUrl,
      generatedTargets,
      generationStatus,
      publishStatus,
      publishResult,
      proofreadIssues,
    }, draftOwner);
  }, [active, draftOwner, form, generatedTargets, generationStatus, hydrated, imageUrl, proofreadIssues, publishResult, publishStatus]);

  useEffect(() => {
    if (draftOwner) loadConnectedPlatforms();
  }, [draftOwner]);

  async function loadConnectedPlatforms() {
    setAvailabilityStatus("loading");
    setPlatformDisplayNames({});
    try {
      const response = await fetch("/api/platform-connections");
      const data = await response.json();
      if (!response.ok || !Array.isArray(data.connections)) throw new Error();
      const activeConnections = data.connections.filter((connection) => (
        connection.state === "active"
        && ACTIVE_PLATFORMS.some((option) => option.value === connection.platform)
      ));
      const activePlatforms = [...new Set(activeConnections.map((connection) => connection.platform))];
      setPlatformDisplayNames(Object.fromEntries(activeConnections
        .filter((connection) => typeof connection.displayName === "string" && connection.displayName.trim())
        .map((connection) => [connection.platform, connection.displayName.trim()])));
      setConnectedPlatforms(activePlatforms);
      setForm((currentForm) => ({
        ...currentForm,
        platforms: reconcileConnectedPlatforms(currentForm.platforms, activePlatforms),
      }));
      setAvailabilityStatus("success");
    } catch {
      setConnectedPlatforms([]);
      setPlatformDisplayNames({});
      setForm((currentForm) => ({ ...currentForm, platforms: [] }));
      setAvailabilityStatus("error");
    }
  }

  const connectedPlatformOptions = useMemo(
    () => ACTIVE_PLATFORMS.filter((option) => connectedPlatforms.includes(option.value)),
    [connectedPlatforms],
  );
  const productStepComplete = availabilityStatus === "success" && isProductStepComplete(form);
  const targets = useMemo(() => generatedTargets ?? createDraftTargets(form), [form, generatedTargets]);
  const previews = useMemo(() => buildPlatformPreviews({ imageUrl, targets }), [imageUrl, targets]);
  const publishSucceeded = isSuccessfulPostResult(publishResult);
  const publishLoading = publishStatus === "checking" || publishStatus === "publishing";

  const updateForm = (nextForm) => {
    setForm(nextForm);
    setGeneratedTargets(null);
    setGenerationStatus("idle");
    setGenerationError("");
    setImageUrl(null);
    setProofreadIssues([]);
    setPublishResult(null);
    setPublishStatus("idle");
  };

  const persistModelPreference = (kind, provider, model) => {
    const preferences = readModelPreferences();
    writeModelPreferences({ ...preferences, [kind]: { ...preferences[kind], [provider]: model } });
  };

  const updateProvider = (kind, provider) => {
    const preferences = readModelPreferences();
    const model = getPreferredModel(kind, provider, preferences);
    persistModelPreference(kind, provider, model);
    updateForm({ ...form, [`${kind}Provider`]: provider, [`${kind}Model`]: model });
  };

  const updateModel = (kind, model) => {
    const provider = form[`${kind}Provider`];
    persistModelPreference(kind, provider, model);
    updateForm({ ...form, [`${kind}Model`]: model });
  };

  const goToStep = (nextStep) => {
    if (!canSelectWizardStep({ step: nextStep, form }) || (nextStep !== WIZARD_STEPS.PRODUCT && !productStepComplete)) return;
    setActive(nextStep);
  };

  const editTarget = (platform, content) => {
    setGeneratedTargets(targets.map((target) => (
      target.platform === platform ? { ...target, content } : target
    )));
    setProofreadIssues([]);
    setPublishResult(null);
    setPublishStatus("idle");
  };

  const resetWizard = () => {
    const preferences = readModelPreferences();
    clearWizardDraft(undefined, draftOwner);
    setActive(WIZARD_STEPS.PRODUCT);
    setForm(getInitialPostForm(preferences, connectedPlatforms));
    setImageUrl(null);
    setGeneratedTargets(null);
    setGenerationStatus("idle");
    setGenerationError("");
    setPublishStatus("idle");
    setPublishResult(null);
    setProofreadIssues([]);
  };

  if (!hydrated) {
    return <Alert color={sessionError ? "red" : "blue"}>{sessionError || "正在載入貼文草稿…"}</Alert>;
  }

  return (
    <Stack gap="lg">
      <div>
        <Title order={2}>建立貼文</Title>
        <Text c="dimmed">建立內容、檢視可編輯預覽，然後立即發布或排程。</Text>
      </div>

      <Paper withBorder radius={8} p="lg">
        <Stepper active={active} onStepClick={goToStep}>
          <Stepper.Step label="商品資訊" allowStepClick allowStepSelect>
            <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md" mt="md">
              <TextInput name="productName" label="商品名稱" required value={form.productName} onChange={(event) => updateForm({ ...form, productName: event.currentTarget.value })} />
              <Select label="目標受眾" required value={form.audience} onChange={(audience) => updateForm({ ...form, audience: audience ?? "" })} data={[{ value: "young", label: "年輕族群" }, { value: "professional", label: "專業人士" }, { value: "family", label: "家庭" }, { value: "senior", label: "熟齡族群" }, { value: "general", label: "一般大眾" }]} />
            </SimpleGrid>
            <Textarea name="productFeatures" mt="md" minRows={4} label="商品特色" required value={form.productFeatures} onChange={(event) => updateForm({ ...form, productFeatures: event.currentTarget.value })} />
            <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md" mt="md">
              <Select label="內容語氣" required value={form.tone} onChange={(tone) => updateForm({ ...form, tone: tone ?? "" })} data={[{ value: "professional", label: "專業" }, { value: "active", label: "活潑" }, { value: "friendly", label: "親切" }, { value: "premium", label: "高質感" }, { value: "humor", label: "幽默" }]} />
              <Stack gap="xs">
                <Text fw={500} size="sm">發布平台</Text>
                {availabilityStatus === "loading" ? <Text c="dimmed" size="sm">正在載入已連結的平台…</Text> : null}
                {availabilityStatus === "error" ? (
                  <Stack gap="xs" align="flex-start">
                    <Text c="red.7" size="sm">無法載入發布平台連線。</Text>
                    <Button size="xs" variant="light" onClick={loadConnectedPlatforms}>重試</Button>
                  </Stack>
                ) : null}
                {availabilityStatus === "success" && connectedPlatforms.length === 0 ? (
                  <Button component="a" href="/settings?tab=publishing" variant="light" w="fit-content">
                    前往系統設定連結發布平台
                  </Button>
                ) : null}
                {availabilityStatus === "success" && connectedPlatforms.length > 0 ? (
                  <Checkbox.Group label="已連結的發布平台" value={form.platforms} onChange={(platforms) => updateForm({ ...form, platforms })}>
                    <Group mt="xs" wrap="wrap">{connectedPlatformOptions.map((option) => <Checkbox key={option.value} value={option.value} label={option.label} />)}</Group>
                  </Checkbox.Group>
                ) : null}
              </Stack>
            </SimpleGrid>
          </Stepper.Step>

          <Stepper.Step label="AI 供應商" allowStepClick={productStepComplete} allowStepSelect={productStepComplete} disabled={!productStepComplete}>
            <SimpleGrid cols={{ base: 1, md: 2 }} spacing="lg" mt="md">
              <Stack><Text fw={600}>LLM 供應商</Text><SegmentedControl value={form.llmProvider} onChange={(llmProvider) => updateProvider("llm", llmProvider)} data={[{ label: "Gemini", value: "google" }, { label: "OpenAI", value: "openai" }]} /><Select label="LLM 模型" value={form.llmModel} onChange={(llmModel) => updateModel("llm", llmModel ?? getLLMModelOptions(form.llmProvider)[0])} data={getLLMModelOptions(form.llmProvider).map((model) => ({ value: model, label: model }))} /></Stack>
              <Stack><Text fw={600}>圖片供應商</Text><SegmentedControl value={form.imageProvider} onChange={(imageProvider) => updateProvider("image", imageProvider)} data={[{ label: "Google Gemini Image", value: "google" }, { label: "OpenAI GPT Image", value: "openai" }]} /><Select label="圖片模型" value={form.imageModel} onChange={(imageModel) => updateModel("image", imageModel ?? getImageModelOptions(form.imageProvider)[0])} data={getImageModelOptions(form.imageProvider).map((model) => ({ value: model, label: model }))} /></Stack>
            </SimpleGrid>
          </Stepper.Step>

          <Stepper.Step label="預覽與發布" allowStepClick={productStepComplete} allowStepSelect={productStepComplete} disabled={!productStepComplete}>
            <Group justify="space-between" mt="md" mb="sm">
              <Text fw={600}>編輯要送出的內容</Text>
              <Button variant="light" leftSection={<IconRefresh size={16} />} loading={generationStatus === "loading"} onClick={() => regenerateContent({ form, setGeneratedTargets, setImageUrl, setGenerationStatus, setGenerationError, setProofreadIssues, setPublishResult, setPublishStatus })}>生成內容</Button>
            </Group>
            {generationStatus === "loading" ? (
              <FloatingAlert color="blue">
                正在產生內容…
              </FloatingAlert>
            ) : null}
            {generationError ? (
              <FloatingAlert color="red" onClose={() => setGenerationError("")}>
                {generationError}
              </FloatingAlert>
            ) : null}
            {proofreadIssues.length > 0 ? <ProofreadIssues issues={proofreadIssues} onClose={() => setProofreadIssues([])} /> : null}
            <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="md">
              {Object.values(previews).map((preview) => <PlatformPreview key={preview.platform} data={preview} displayName={platformDisplayNames[preview.platform]} content={targets.find((target) => target.platform === preview.platform)?.content ?? ""} onContentChange={(content) => editTarget(preview.platform, content)} />)}
            </SimpleGrid>
            <Paper withBorder mt="md" p="md">
              <Text fw={600} mb="sm">發布方式</Text>
              <SegmentedControl value={form.mode} onChange={(mode) => { setForm({ ...form, mode }); setPublishResult(null); setPublishStatus("idle"); }} data={[{ label: "立即發布", value: "now" }, { label: "排程發布", value: "scheduled" }]} />
              {form.mode === "scheduled" ? <SimpleGrid cols={{ base: 1, sm: 2 }} mt="sm"><DateInput label="發布日期" value={form.scheduledDate ?? null} onChange={(scheduledDate) => setForm({ ...form, scheduledDate: scheduledDate ?? "" })} valueFormat="YYYY-MM-DD" minDate={new Date()} clearable={false} /><Select label="發布時間（台北）" value={form.scheduledTime ?? SCHEDULE_TIME} onChange={(scheduledTime) => setForm({ ...form, scheduledTime: scheduledTime ?? SCHEDULE_TIME })} data={[{ value: "09:00", label: "09:00" }]} /></SimpleGrid> : null}
            </Paper>
            {publishResult ? <PublishResult result={publishResult} formMode={form.mode} onClose={() => setPublishResult(null)} /> : null}
          </Stepper.Step>
        </Stepper>

        <Group justify="space-between" mt="xl">
          <Button variant="default" disabled={active === WIZARD_STEPS.PRODUCT || publishLoading} onClick={() => goToStep(Math.max(WIZARD_STEPS.PRODUCT, active - 1))}>上一步</Button>
          {active < WIZARD_STEPS.PREVIEW ? (
            <Button disabled={!productStepComplete || generationStatus === "loading"} onClick={() => goToStep(Math.min(WIZARD_STEPS.PREVIEW, active + 1))}>下一步</Button>
          ) : publishSucceeded ? (
            <Button leftSection={<IconPlus size={16} />} onClick={resetWizard}>再新增貼文</Button>
          ) : (
            <Button leftSection={form.mode === "scheduled" ? <IconCalendar size={16} /> : <IconSend size={16} />} loading={publishLoading} disabled={generationStatus === "loading" || !generatedTargets} onClick={() => submitPost({ form, targets, imageUrl, expectedOwner: draftOwner, submissionInFlight, setPublishStatus, setPublishResult, setProofreadIssues })}>
              {publishStatus === "checking" ? "正在檢查錯字…" : form.mode === "scheduled" ? "確認排程" : "確認發文"}
            </Button>
          )}
        </Group>
      </Paper>
    </Stack>
  );
}

function ProofreadIssues({ issues, onClose }) {
  return (
    <FloatingAlert color="red" title="發現疑似錯字，已停止發布" onClose={onClose}>
      <List size="sm" spacing="xs">
        {issues.map((issue, index) => (
          <List.Item key={`${issue.platform}-${issue.original}-${index}`}>
            {getPlatformLabel(issue.platform)}：「{issue.original}」建議改為「{issue.suggestion}」（{issue.reason}）
          </List.Item>
        ))}
      </List>
    </FloatingAlert>
  );
}

function PublishResult({ result, formMode, onClose }) {
  const alertColor = result.status === "failed" ? "red" : result.status === "scheduled" ? "orange" : "green";
  return (
    <FloatingAlert color={alertColor} title={getStatusLabel(result.status)} onClose={onClose}>
      <Stack gap={4}>
        {formMode === "now" && result.status === "scheduled" ? (
          <Text role="status" size="sm">已加入自動重試佇列，將於下次排程執行時再次發布。</Text>
        ) : null}
        {result.targets?.map((target) => (
          <Text key={target.id ?? target.platform} size="sm">
            {getPlatformLabel(target.platform)}：{getStatusLabel(target.status)}{target.errorMessage ? `－${target.errorMessage}` : ""}
          </Text>
        ))}
      </Stack>
    </FloatingAlert>
  );
}

async function regenerateContent({ form, setGeneratedTargets, setImageUrl, setGenerationStatus, setGenerationError, setProofreadIssues = () => {}, setPublishResult = () => {}, setPublishStatus = () => {} }) {
  setGenerationStatus("loading");
  setGenerationError("");
  setProofreadIssues([]);
  setPublishResult(null);
  setPublishStatus("idle");
  try {
    const response = await fetch("/api/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "內容產生失敗。");
    setGeneratedTargets(data.targets);
    setImageUrl(data.imageUrl ?? null);
    setGenerationError(data.imageError ?? "");
    setGenerationStatus("success");
  } catch (error) {
    setGenerationError(error.message);
    setGenerationStatus("error");
  }
}

async function submitPost({ form, targets, imageUrl, expectedOwner, submissionInFlight, setPublishStatus, setPublishResult, setProofreadIssues }) {
  if (submissionInFlight.current) return;
  submissionInFlight.current = true;
  setPublishResult(null);
  setProofreadIssues([]);
  try {
    const currentOwner = await fetchSessionOwner();
    if (currentOwner !== expectedOwner) {
      throw new Error("登入帳號已變更，已停止發布。請重新確認貼文內容。");
    }
    const result = await submitCheckedPost({
      form,
      targets,
      imageUrl,
      onPhase: setPublishStatus,
    });
    if (result.status === "issues") {
      setProofreadIssues(result.issues);
      setPublishStatus("error");
      return;
    }
    setPublishResult(result.post);
    setPublishStatus(isSuccessfulPostResult(result.post) ? "done" : "error");
  } catch (error) {
    setPublishResult({ status: "failed", targets: [{ platform: "system", status: "failed", errorMessage: error.message }] });
    setPublishStatus("error");
  } finally {
    submissionInFlight.current = false;
  }
}
