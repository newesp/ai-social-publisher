"use client";

import {
  Badge,
  Button,
  Checkbox,
  Group,
  NumberInput,
  Paper,
  SimpleGrid,
  Stack,
  Text,
  Textarea,
  TextInput,
  Title,
} from "@mantine/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { FloatingAlert } from "../FloatingAlert.js";

const EMPTY_FAQ = Object.freeze({
  id: "",
  question: "",
  answer: "",
  internalNotes: "",
  category: "",
  keywords: "",
  enabled: true,
  priority: 0,
});

export function FaqManager({ onChanged }) {
  const [faqs, setFaqs] = useState([]);
  const [form, setForm] = useState({ ...EMPTY_FAQ });
  const [filter, setFilter] = useState("");
  const [status, setStatus] = useState("loading");
  const [action, setAction] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const loadFaqs = useCallback(async () => {
    setStatus("loading");
    setError("");
    try {
      const response = await fetch("/api/support/faqs");
      const data = await safeJson(response);
      if (!response.ok || !Array.isArray(data.faqs)) {
        throw new Error(safeError(data, "無法載入 FAQ。"));
      }
      setFaqs(data.faqs);
      setStatus("success");
    } catch (loadError) {
      setError(loadError.message || "無法載入 FAQ。");
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    loadFaqs();
  }, [loadFaqs]);

  const filteredFaqs = useMemo(() => {
    const query = filter.trim().toLocaleLowerCase();
    if (!query) return faqs;
    return faqs.filter((faq) => [
      faq.question,
      faq.answer,
      faq.category,
      ...(faq.keywords ?? []),
    ].some((value) => String(value ?? "").toLocaleLowerCase().includes(query)));
  }, [faqs, filter]);

  async function saveFaq() {
    if (action || !form.question.trim() || !form.answer.trim()) return;
    const editing = Boolean(form.id);
    setAction(editing ? `save-${form.id}` : "create");
    setError("");
    setNotice("");
    const payload = {
      question: form.question,
      answer: form.answer,
      internalNotes: form.internalNotes || null,
      category: form.category,
      keywords: parseKeywords(form.keywords),
      enabled: form.enabled,
      priority: Number(form.priority),
    };
    try {
      const options = {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      };
      const response = editing
        ? await fetch(`/api/support/faqs/${encodeURIComponent(form.id)}`, {
          ...options,
          method: "PATCH",
        })
        : await fetch("/api/support/faqs", {
          ...options,
          method: "POST",
        });
      const data = await safeJson(response);
      if (!response.ok || !data.faq) throw new Error(safeError(data, "FAQ 儲存失敗。"));
      setForm({ ...EMPTY_FAQ });
      await loadFaqs();
      await onChanged?.();
      setNotice(editing ? "FAQ 已更新。" : "FAQ 已建立。");
    } catch (saveError) {
      setError(saveError.message || "FAQ 儲存失敗。");
    } finally {
      setAction("");
    }
  }

  async function toggleFaq(faq) {
    if (action) return;
    setAction(`toggle-${faq.id}`);
    setError("");
    setNotice("");
    try {
      const response = await fetch(`/api/support/faqs/${encodeURIComponent(faq.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !faq.enabled }),
      });
      const data = await safeJson(response);
      if (!response.ok || !data.faq) {
        throw new Error(safeError(data, "無法更新 FAQ 狀態。"));
      }
      await loadFaqs();
      await onChanged?.();
      setNotice(data.faq.enabled ? "FAQ 已啟用。" : "FAQ 已停用。");
    } catch (toggleError) {
      setError(toggleError.message || "無法更新 FAQ 狀態。");
    } finally {
      setAction("");
    }
  }

  async function deleteFaq(faq) {
    if (action || !window.confirm(`確定刪除「${faq.question}」？`)) return;
    setAction(`delete-${faq.id}`);
    setError("");
    setNotice("");
    try {
      const response = await fetch(`/api/support/faqs/${encodeURIComponent(faq.id)}`, {
        method: "DELETE",
      });
      if (response.status === 204) {
        if (form.id === faq.id) setForm({ ...EMPTY_FAQ });
        await loadFaqs();
        await onChanged?.();
        setNotice("FAQ 已刪除。");
      } else {
        const data = await safeJson(response);
        throw new Error(safeError(data, "FAQ 刪除失敗。"));
      }
    } catch (deleteError) {
      setError(deleteError.message || "FAQ 刪除失敗。");
    } finally {
      setAction("");
    }
  }

  function editFaq(faq) {
    setForm({
      id: faq.id,
      question: faq.question,
      answer: faq.answer,
      internalNotes: faq.internalNotes ?? "",
      category: faq.category ?? "",
      keywords: (faq.keywords ?? []).join(", "),
      enabled: faq.enabled,
      priority: faq.priority,
    });
    setError("");
    setNotice("");
  }

  return (
    <Paper withBorder radius="md" p="md" style={{ minWidth: 0 }}>
      <Stack gap="md">
        <div>
          <Title order={3}>FAQ 知識庫</Title>
          <Text size="sm" c="dimmed">
            AI 只會依據已啟用的 FAQ 回答；沒有足夠資料時會轉交人工處理。
          </Text>
        </div>

        <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="md">
          <Stack gap="sm" style={{ minWidth: 0 }}>
            <TextInput
              label="搜尋 FAQ"
              placeholder="搜尋問題、答案、分類或關鍵字"
              value={filter}
              onChange={(event) => setFilter(event.currentTarget.value)}
            />
            {status === "loading" ? <Text c="dimmed">載入 FAQ 中…</Text> : null}
            {status === "error" ? (
              <Group wrap="wrap" role="alert" aria-live="assertive">
                <Text c="red.7">{error}</Text>
                <Button variant="light" onClick={loadFaqs}>重新載入</Button>
              </Group>
            ) : null}
            {status === "success" && filteredFaqs.length === 0 ? (
              <Text c="dimmed">
                {faqs.length === 0 ? "尚未建立 FAQ。" : "沒有符合搜尋條件的 FAQ。"}
              </Text>
            ) : null}
            {status === "success" ? filteredFaqs.map((faq) => (
              <Paper key={faq.id} withBorder radius="sm" p="sm" style={{ minWidth: 0 }}>
                <Stack gap="xs">
                  <Group justify="space-between" align="flex-start" wrap="wrap">
                    <div style={{ minWidth: 0, flex: "1 1 14rem" }}>
                      <Text fw={600} style={{ overflowWrap: "anywhere" }}>{faq.question}</Text>
                      <Text size="sm" c="dimmed" lineClamp={3} style={{ overflowWrap: "anywhere" }}>
                        {faq.answer}
                      </Text>
                    </div>
                    <Badge color={faq.enabled ? "green" : "gray"}>
                      {faq.enabled ? "已啟用" : "已停用"}
                    </Badge>
                  </Group>
                  <Group gap="xs" wrap="wrap">
                    {faq.category ? <Badge variant="light">{faq.category}</Badge> : null}
                    <Badge variant="outline">優先 {faq.priority}</Badge>
                    {(faq.keywords ?? []).map((keyword) => (
                      <Badge
                        key={keyword}
                        variant="outline"
                        style={{ overflowWrap: "anywhere" }}
                      >
                        {keyword}
                      </Badge>
                    ))}
                  </Group>
                  <Group wrap="wrap">
                    <Button
                      size="xs"
                      variant="light"
                      disabled={Boolean(action)}
                      onClick={() => editFaq(faq)}
                    >
                      編輯
                    </Button>
                    <Button
                      size="xs"
                      variant="light"
                      loading={action === `toggle-${faq.id}`}
                      disabled={Boolean(action)}
                      onClick={() => toggleFaq(faq)}
                    >
                      {faq.enabled ? "停用" : "啟用"}
                    </Button>
                    <Button
                      size="xs"
                      color="red"
                      variant="light"
                      loading={action === `delete-${faq.id}`}
                      disabled={Boolean(action)}
                      onClick={() => deleteFaq(faq)}
                    >
                      刪除 FAQ
                    </Button>
                  </Group>
                </Stack>
              </Paper>
            )) : null}
          </Stack>

          <Paper withBorder radius="sm" p="md" style={{ minWidth: 0 }}>
            <Stack gap="sm">
              <Text fw={600}>{form.id ? "編輯 FAQ" : "新增 FAQ"}</Text>
              <Textarea
                label="問題"
                required
                autosize
                minRows={2}
                maxLength={500}
                value={form.question}
                onChange={(event) => {
                  const question = event.currentTarget.value;
                  setForm((current) => ({ ...current, question }));
                }}
              />
              <Textarea
                label="答案"
                required
                autosize
                minRows={4}
                maxLength={4_000}
                value={form.answer}
                onChange={(event) => {
                  const answer = event.currentTarget.value;
                  setForm((current) => ({ ...current, answer }));
                }}
              />
              <Textarea
                label="內部備註 (僅管理員可見)"
                description="真人客服提醒、判斷流程、內部話術等，不會傳給 AI 或客戶。"
                autosize
                minRows={2}
                maxLength={8_000}
                value={form.internalNotes}
                onChange={(event) => {
                  const internalNotes = event.currentTarget.value;
                  setForm((current) => ({ ...current, internalNotes }));
                }}
              />
              <TextInput
                label="分類"
                maxLength={80}
                value={form.category}
                onChange={(event) => {
                  const category = event.currentTarget.value;
                  setForm((current) => ({ ...current, category }));
                }}
              />
              <TextInput
                label="關鍵字"
                description="以逗號或換行分隔，最多 20 個"
                value={form.keywords}
                onChange={(event) => {
                  const keywords = event.currentTarget.value;
                  setForm((current) => ({ ...current, keywords }));
                }}
              />
              <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
                <NumberInput
                  label="優先順序"
                  min={-100}
                  max={100}
                  step={1}
                  allowDecimal={false}
                  value={form.priority}
                  onChange={(value) => setForm((current) => ({
                    ...current,
                    priority: typeof value === "number" ? value : 0,
                  }))}
                />
                <Checkbox
                  label="啟用這則 FAQ"
                  checked={form.enabled}
                  mt={{ base: 0, sm: 28 }}
                  onChange={(event) => {
                    const enabled = event.currentTarget.checked;
                    setForm((current) => ({
                      ...current,
                      enabled,
                    }));
                  }}
                />
              </SimpleGrid>
              <Group wrap="wrap">
                <Button
                  loading={action === "create" || action === `save-${form.id}`}
                  disabled={Boolean(action) || !form.question.trim() || !form.answer.trim()}
                  onClick={saveFaq}
                >
                  儲存 FAQ
                </Button>
                {form.id ? (
                  <Button
                    variant="default"
                    disabled={Boolean(action)}
                    onClick={() => setForm({ ...EMPTY_FAQ })}
                  >
                    取消編輯
                  </Button>
                ) : null}
              </Group>
            </Stack>
          </Paper>
        </SimpleGrid>

        <div role="status" aria-live="polite">
          {status === "success" && error ? (
            <FloatingAlert color="red" onClose={() => setError("")}>
              {error}
            </FloatingAlert>
          ) : null}
          {notice ? (
            <FloatingAlert color="green" onClose={() => setNotice("")}>
              {notice}
            </FloatingAlert>
          ) : null}
        </div>
      </Stack>
    </Paper>
  );
}

function parseKeywords(value) {
  return [...new Set(
    String(value ?? "")
      .split(/[,\n]/)
      .map((keyword) => keyword.trim())
      .filter(Boolean),
  )];
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function safeError(data, fallback) {
  return typeof data?.error === "string" && data.error.trim() ? data.error : fallback;
}
