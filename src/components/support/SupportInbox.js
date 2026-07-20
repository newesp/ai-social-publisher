"use client";

import { Button, Group, SimpleGrid, Stack, Text } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { useCallback, useEffect, useRef, useState } from "react";
import { ConversationDetailsDrawer } from "./ConversationDetailsDrawer.js";
import { ConversationList } from "./ConversationList.js";
import { ConversationThread } from "./ConversationThread.js";

const POLL_MS = 15000;
export function SupportInbox() {
  const mobile = useMediaQuery("(max-width: 47.99em)"); const [conversations, setConversations] = useState([]); const [selectedId, setSelectedId] = useState(null); const [selected, setSelected] = useState(null); const [listState, setListState] = useState("loading"); const [detailState, setDetailState] = useState("idle"); const listAbort = useRef(null); const detailAbort = useRef(null);
  const loadDetail = useCallback(async (id) => { if (!id) { setSelected(null); return; } detailAbort.current?.abort(); const controller = new AbortController(); detailAbort.current = controller; setDetailState("loading"); try { const response = await fetch(`/api/support/conversations/${encodeURIComponent(id)}`, { signal: controller.signal }); const data = await safeJson(response); if (!response.ok || !data.conversation) throw new Error("detail"); setSelected(data.conversation); setDetailState("ready"); } catch (error) { if (error.name !== "AbortError") { setSelected(null); setDetailState("error"); } } }, []);
  const loadList = useCallback(async () => { listAbort.current?.abort(); const controller = new AbortController(); listAbort.current = controller; setListState("loading"); try { const response = await fetch("/api/support/conversations", { signal: controller.signal }); const data = await safeJson(response); if (!response.ok || !Array.isArray(data.conversations)) throw new Error("list"); setConversations(data.conversations); setListState("ready"); if (selectedId) await loadDetail(selectedId); } catch (error) { if (error.name !== "AbortError") setListState("error"); } }, [loadDetail, selectedId]);
  useEffect(() => { loadList(); }, [loadList]);
  useEffect(() => { const refreshWhenVisible = () => { if (document.visibilityState === "visible") loadList(); }; document.addEventListener("visibilitychange", refreshWhenVisible); const timer = window.setInterval(refreshWhenVisible, POLL_MS); return () => { document.removeEventListener("visibilitychange", refreshWhenVisible); window.clearInterval(timer); listAbort.current?.abort(); detailAbort.current?.abort(); }; }, [loadList]);
  const choose = useCallback(async (id) => { setSelectedId(id); await loadDetail(id); fetch(`/api/support/conversations/${encodeURIComponent(id)}/read`, { method: "POST", headers: { "Content-Type": "application/json" } }).catch(() => {}); }, [loadDetail]);
  const showList = !mobile || !selectedId; const showThread = !mobile || Boolean(selectedId);
  return <Stack gap="md" style={{ minWidth: 0 }}><Group justify="space-between"><div><Text fw={700} size="xl">Support inbox</Text><Text c="dimmed" size="sm">Polling pauses while this tab is hidden.</Text></div><Button variant="light" onClick={loadList} loading={listState === "loading"}>Refresh</Button></Group><SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="md" style={{ minWidth: 0 }}>{showList ? <ConversationList conversations={conversations} selectedId={selectedId} loading={listState === "loading"} error={listState === "error"} onSelect={choose} onRefresh={loadList} /> : null}{showThread ? <ConversationThread conversation={selected} loading={detailState === "loading"} error={detailState === "error"} mobile={mobile} onBack={() => { setSelectedId(null); setSelected(null); }} /> : null}{selected ? <ConversationDetailsDrawer conversation={selected} /> : null}</SimpleGrid></Stack>;
}
async function safeJson(response) { try { return await response.json(); } catch { return {}; } }
