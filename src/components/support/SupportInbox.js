"use client";

import { Button, Grid, Group, Stack, Text } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { useCallback, useEffect, useRef, useState } from "react";
import { ConversationDetailsDrawer } from "./ConversationDetailsDrawer.js";
import { ConversationList } from "./ConversationList.js";
import { ConversationThread } from "./ConversationThread.js";
import { GlobalTransitionUndo } from "./GlobalTransitionUndo.js";

const POLL_MS = 15000;

export function SupportInbox() {
  const mobile = useMediaQuery("(max-width: 47.99em)");
  const [conversations, setConversations] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [selected, setSelected] = useState(null);
  const [listState, setListState] = useState("loading");
  const [detailState, setDetailState] = useState("idle");
  const [recoveryState, setRecoveryState] = useState("idle");
  const [globalTransitions, setGlobalTransitions] = useState([]);
  const [undoingTransition, setUndoingTransition] = useState(null);
  const listAbort = useRef(null);
  const detailAbort = useRef(null);
  const hasSummaries = useRef(false);

  const loadDetail = useCallback(async (id, { silent = false } = {}) => {
    if (!id) { setSelected(null); return; }
    detailAbort.current?.abort();
    const controller = new AbortController();
    detailAbort.current = controller;
    if (!silent) setDetailState("loading");
    try {
      const response = await fetch(`/api/support/conversations/${encodeURIComponent(id)}`, { signal: controller.signal });
      const data = await safeJson(response);
      if (!response.ok || !data.conversation) throw new Error("detail");
      setSelected(data.conversation);
      setDetailState("ready");
    } catch (error) {
      if (error.name !== "AbortError") {
        if (!silent) { setSelected(null); setDetailState("error"); }
      }
    }
  }, []);

  const loadActivePendingTransitions = useCallback(async (signal) => {
    try {
      const response = await fetch("/api/support/conversations/active-pending-transitions", { signal });
      const data = await safeJson(response);
      if (!response.ok || !Array.isArray(data.transitions)) throw new Error("pending transitions");
      setGlobalTransitions(data.transitions);
    } catch (error) {
      if (error.name !== "AbortError") setGlobalTransitions([]);
    }
  }, []);

  const loadList = useCallback(async ({ cursor = null, append = false, silent = false } = {}) => {
    listAbort.current?.abort();
    const controller = new AbortController();
    listAbort.current = controller;
    if (!hasSummaries.current && !silent) setListState("loading");
    try {
      const response = await fetch(`/api/support/conversations${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`, { signal: controller.signal });
      const data = await safeJson(response);
      if (!response.ok || !Array.isArray(data.conversations)) throw new Error("list");
      hasSummaries.current = true;
      setConversations((current) => append ? appendUniqueConversations(current, data.conversations) : data.conversations);
      setNextCursor(typeof data.nextCursor === "string" ? data.nextCursor : null);
      await loadActivePendingTransitions(controller.signal);
      setListState("ready");
      setRecoveryState((current) => current === "reconnecting" || current === "recovery_failed" ? "recovered" : "idle");
      if (selectedId) await loadDetail(selectedId, { silent: true });
    } catch (error) {
      if (error.name !== "AbortError") {
        setListState(hasSummaries.current ? "stale" : "error");
        setRecoveryState((current) => current === "reconnecting" ? "recovery_failed" : current);
      }
    }
  }, [loadActivePendingTransitions, loadDetail, selectedId]);

  const loadMore = useCallback(() => nextCursor && loadList({ cursor: nextCursor, append: true }), [loadList, nextCursor]);

  useEffect(() => { loadList(); }, [loadList]);

  useEffect(() => {
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") {
        setRecoveryState("reconnecting");
        loadList({ silent: true });
      }
    };
    document.addEventListener("visibilitychange", refreshWhenVisible);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") loadList({ silent: true });
    }, POLL_MS);
    return () => {
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      window.clearInterval(timer);
      listAbort.current?.abort();
      detailAbort.current?.abort();
    };
  }, [loadList]);

  // Monitor active pending transition effectiveAt for smooth countdown completion
  useEffect(() => {
    if (!globalTransitions.length && !selected?.pendingTransition) return;
    const checkExpiryTimer = window.setInterval(() => {
      const now = Date.now();
      const hasExpired = globalTransitions.some((t) => new Date(t.effectiveAt).getTime() <= now)
        || (selected?.pendingTransition && new Date(selected.pendingTransition.effectiveAt).getTime() <= now);
      if (hasExpired) {
        loadList({ silent: true });
      }
    }, 1000);
    return () => window.clearInterval(checkExpiryTimer);
  }, [globalTransitions, selected, loadList]);

  const choose = useCallback(async (id) => {
    setSelectedId(id);
    await loadDetail(id);
    fetch(`/api/support/conversations/${encodeURIComponent(id)}/read`, { method: "POST", headers: { "Content-Type": "application/json" } }).catch(() => {});
  }, [loadDetail]);

  const takeOver = useCallback(async () => {
    if (!selected) return;
    const response = await fetch(`/api/support/conversations/${encodeURIComponent(selected.id)}/take-over`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedVersion: selected.version }) });
    if (response.ok) { await loadDetail(selected.id, { silent: true }); await loadList({ silent: true }); }
  }, [loadDetail, loadList, selected]);

  const sendMessage = useCallback(async (text, idempotencyKey) => {
    if (!selected) return;
    const response = await fetch(`/api/support/conversations/${encodeURIComponent(selected.id)}/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, idempotencyKey }) });
    const data = await safeJson(response);
    await loadDetail(selected.id, { silent: true }); await loadList({ silent: true });
    if (!response.ok || data.message?.deliveryStatus !== "sent") {
      throw new Error(data.error || "LINE 訊息傳送失敗。");
    }
    return data.message;
  }, [loadDetail, loadList, selected]);

  const retryHumanMessage = useCallback(async (messageId) => {
    if (!selected) return;
    const response = await fetch(`/api/support/messages/${encodeURIComponent(messageId)}/retry`, { method: "POST" });
    const data = await safeJson(response);
    await loadDetail(selected.id, { silent: true }); await loadList({ silent: true });
    if (!response.ok || data.message?.deliveryStatus !== "sent") {
      throw new Error(data.error || "LINE 訊息傳送失敗。");
    }
    return data.message;
  }, [loadDetail, loadList, selected]);

  const requestTransition = useCallback(async (action) => {
    if (!selected) return;
    const response = await fetch(`/api/support/conversations/${encodeURIComponent(selected.id)}/transitions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, expectedVersion: selected.version }) });
    const data = await safeJson(response);
    if (response.ok && data.transition) setGlobalTransitions((current) => reconcileGlobalTransitions([...current, { ...data.transition, customerLabel: selected.customerLabel }]));
    await loadDetail(selected.id, { silent: true }); await loadList({ silent: true });
  }, [loadDetail, loadList, selected]);

  const undoTransition = useCallback(async (transition) => {
    if (!transition) return;
    setUndoingTransition(transition.id);
    try {
      const response = await fetch(`/api/support/conversations/${encodeURIComponent(transition.conversationId)}/transitions/${encodeURIComponent(transition.id)}/undo`, { method: "POST" });
      if (response.ok || response.status === 409) setGlobalTransitions((current) => current.filter((item) => item.id !== transition.id));
      await loadList({ silent: true });
      if (selectedId === transition.conversationId) await loadDetail(selectedId, { silent: true });
    } finally { setUndoingTransition(null); }
  }, [loadDetail, loadList, selectedId]);

  const deleteConversation = useCallback(async (id) => {
    if (!id) return;
    const response = await fetch(`/api/support/conversations/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
    });
    const data = await safeJson(response);
    if (!response.ok) throw new Error(data.error || "刪除對話失敗。");
    if (selectedId === id) {
      setSelectedId(null);
      setSelected(null);
    }
    await loadList({ silent: true });
  }, [loadDetail, loadList, selectedId]);

  const showList = !mobile || !selectedId;
  const showThread = !mobile || Boolean(selectedId);

  return (
    <Stack gap="md" style={{ minWidth: 0, height: "calc(100vh - 120px)", overflow: "hidden", display: "flex", flexDirection: "column" }}>
      <Group justify="space-between" style={{ flexShrink: 0 }}>
        <div>
          <Text fw={700} size="xl">AI 客服對話收件匣</Text>
          <Text c="dimmed" size="sm">分頁隱藏時將自動暫停更新。</Text>
        </div>
        <Button variant="light" onClick={() => loadList({ silent: false })} loading={listState === "loading" && !hasSummaries.current}>
          重新整理
        </Button>
      </Group>
      <GlobalTransitionUndo transitions={globalTransitions} onUndo={undoTransition} undoingTransitionId={undoingTransition} />
      <Grid gutter="md" style={{ minWidth: 0, flex: 1, height: "100%", minHeight: 0, overflow: "hidden" }}>
        {showList ? (
          <Grid.Col span={{ base: 12, md: 3 }} style={{ height: "100%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
            <ConversationList
              conversations={conversations}
              selectedId={selectedId}
              loading={listState === "loading" && !hasSummaries.current}
              state={listState}
              recoveryState={recoveryState}
              onSelect={choose}
              onRefresh={() => loadList({ silent: false })}
              onLoadMore={loadMore}
              hasMore={Boolean(nextCursor)}
            />
          </Grid.Col>
        ) : null}
        {showThread ? (
          <Grid.Col span={{ base: 12, md: selected ? 6 : 9 }} style={{ height: "100%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
            <ConversationThread
              conversation={selected}
              loading={detailState === "loading" && !selected}
              error={detailState === "error" && !selected}
              mobile={mobile}
              onBack={() => { setSelectedId(null); setSelected(null); }}
              onTakeOver={takeOver}
              onSendMessage={sendMessage}
              onRetryMessage={retryHumanMessage}
              onTransition={requestTransition}
              onDeleteConversation={deleteConversation}
            />
          </Grid.Col>
        ) : null}
        {selected ? (
          <Grid.Col span={{ base: 12, md: 3 }} style={{ height: "100%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
            <ConversationDetailsDrawer conversation={selected} />
          </Grid.Col>
        ) : null}
      </Grid>
    </Stack>
  );
}

async function safeJson(response) { try { return await response.json(); } catch { return {}; } }

function reconcileGlobalTransitions(transitions) {
  const byId = new Map();
  for (const transition of Array.isArray(transitions) ? transitions : []) {
    if (transition?.id && transition?.conversationId && transition?.effectiveAt) byId.set(transition.id, transition);
  }
  return [...byId.values()].sort((left, right) => Date.parse(left.effectiveAt) - Date.parse(right.effectiveAt));
}
function appendUniqueConversations(current, next) { const byId = new Map((current ?? []).map((item) => [item.id, item])); for (const item of next ?? []) if (item?.id) byId.set(item.id, item); return [...byId.values()]; }
