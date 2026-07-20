"use client";

import { Button, Group, SimpleGrid, Stack, Text } from "@mantine/core";
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

  const loadDetail = useCallback(async (id) => {
    if (!id) { setSelected(null); return; }
    detailAbort.current?.abort();
    const controller = new AbortController();
    detailAbort.current = controller;
    setDetailState("loading");
    try {
      const response = await fetch(`/api/support/conversations/${encodeURIComponent(id)}`, { signal: controller.signal });
      const data = await safeJson(response);
      if (!response.ok || !data.conversation) throw new Error("detail");
      setSelected(data.conversation);
      setDetailState("ready");
    } catch (error) {
      if (error.name !== "AbortError") { setSelected(null); setDetailState("error"); }
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

  const loadList = useCallback(async () => {
    listAbort.current?.abort();
    const controller = new AbortController();
    listAbort.current = controller;
    if (!hasSummaries.current) setListState("loading");
    try {
      const response = await fetch("/api/support/conversations", { signal: controller.signal });
      const data = await safeJson(response);
      if (!response.ok || !Array.isArray(data.conversations)) throw new Error("list");
      hasSummaries.current = true;
      setConversations(data.conversations);
      await loadActivePendingTransitions(controller.signal);
      setListState("ready");
      setRecoveryState((current) => current === "reconnecting" || current === "recovery_failed" ? "recovered" : "idle");
      if (selectedId) await loadDetail(selectedId);
    } catch (error) {
      if (error.name !== "AbortError") {
        setListState(hasSummaries.current ? "stale" : "error");
        setRecoveryState((current) => current === "reconnecting" ? "recovery_failed" : current);
      }
    }
  }, [loadActivePendingTransitions, loadDetail, selectedId]);

  useEffect(() => { loadList(); }, [loadList]);
  useEffect(() => {
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") {
        setRecoveryState("reconnecting");
        loadList();
      }
    };
    document.addEventListener("visibilitychange", refreshWhenVisible);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") loadList();
    }, POLL_MS);
    return () => {
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      window.clearInterval(timer);
      listAbort.current?.abort();
      detailAbort.current?.abort();
    };
  }, [loadList]);

  const choose = useCallback(async (id) => {
    setSelectedId(id);
    await loadDetail(id);
    fetch(`/api/support/conversations/${encodeURIComponent(id)}/read`, { method: "POST", headers: { "Content-Type": "application/json" } }).catch(() => {});
  }, [loadDetail]);
  const takeOver = useCallback(async () => {
    if (!selected) return;
    const response = await fetch(`/api/support/conversations/${encodeURIComponent(selected.id)}/take-over`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedVersion: selected.version }) });
    if (response.ok) { await loadDetail(selected.id); await loadList(); }
  }, [loadDetail, loadList, selected]);
  const sendMessage = useCallback(async (text) => {
    if (!selected) return;
    await fetch(`/api/support/conversations/${encodeURIComponent(selected.id)}/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, idempotencyKey: crypto.randomUUID() }) });
    await loadDetail(selected.id); await loadList();
  }, [loadDetail, loadList, selected]);
  const requestTransition = useCallback(async (action) => {
    if (!selected) return;
    const response = await fetch(`/api/support/conversations/${encodeURIComponent(selected.id)}/transitions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, expectedVersion: selected.version }) });
    const data = await safeJson(response);
    if (response.ok && data.transition) setGlobalTransitions((current) => reconcileGlobalTransitions([...current, { ...data.transition, customerLabel: selected.customerLabel }]));
    await loadDetail(selected.id); await loadList();
  }, [loadDetail, loadList, selected]);
  const undoTransition = useCallback(async (transition) => {
    if (!transition) return;
    setUndoingTransition(transition.id);
    try {
      const response = await fetch(`/api/support/conversations/${encodeURIComponent(transition.conversationId)}/transitions/${encodeURIComponent(transition.id)}/undo`, { method: "POST" });
      if (response.ok || response.status === 409) setGlobalTransitions((current) => current.filter((item) => item.id !== transition.id));
      await loadList();
      if (selectedId === transition.conversationId) await loadDetail(selectedId);
    } finally { setUndoingTransition(null); }
  }, [loadDetail, loadList, selectedId]);
  const showList = !mobile || !selectedId;
  const showThread = !mobile || Boolean(selectedId);

  return <Stack gap="md" style={{ minWidth: 0 }}><Group justify="space-between"><div><Text fw={700} size="xl">Support inbox</Text><Text c="dimmed" size="sm">Polling pauses while this tab is hidden.</Text></div><Button variant="light" onClick={loadList} loading={listState === "loading"}>Refresh</Button></Group><GlobalTransitionUndo transitions={globalTransitions} onUndo={undoTransition} undoingTransitionId={undoingTransition} /><SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="md" style={{ minWidth: 0 }}>{showList ? <ConversationList conversations={conversations} selectedId={selectedId} loading={listState === "loading"} state={listState} recoveryState={recoveryState} onSelect={choose} onRefresh={loadList} /> : null}{showThread ? <ConversationThread conversation={selected} loading={detailState === "loading"} error={detailState === "error"} mobile={mobile} onBack={() => { setSelectedId(null); setSelected(null); }} onTakeOver={takeOver} onSendMessage={sendMessage} onTransition={requestTransition} /> : null}{selected ? <ConversationDetailsDrawer conversation={selected} /> : null}</SimpleGrid></Stack>;
}

async function safeJson(response) { try { return await response.json(); } catch { return {}; } }

function reconcileGlobalTransitions(transitions) {
  const byId = new Map();
  for (const transition of Array.isArray(transitions) ? transitions : []) {
    if (transition?.id && transition?.conversationId && transition?.effectiveAt) byId.set(transition.id, transition);
  }
  return [...byId.values()].sort((left, right) => Date.parse(left.effectiveAt) - Date.parse(right.effectiveAt));
}
