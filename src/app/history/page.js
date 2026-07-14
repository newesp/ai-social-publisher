"use client";

import { useEffect, useState } from "react";
import { Badge, Button, Group, Paper, Table, Text, Title } from "@mantine/core";
import { AppShellFrame } from "../../components/AppShellFrame.js";
import { cancelScheduledPost, loadPostHistory } from "../../lib/history/post-history.js";
import { getPlatformLabel, getStatusLabel } from "../../lib/posts/status-labels.js";

export default function HistoryPage() {
  const [posts, setPosts] = useState([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [cancellingId, setCancellingId] = useState(null);

  useEffect(() => {
    loadPostHistory().then(setPosts).catch((reason) => setError(reason.message)).finally(() => setLoading(false));
  }, []);

  async function cancelPost(id) {
    setCancellingId(id); setError("");
    try {
      const post = await cancelScheduledPost(fetch, id);
      setPosts((current) => current.map((row) => row.id === post.id ? post : row));
    } catch (reason) { setError(reason.message); } finally { setCancellingId(null); }
  }

  return <AppShellFrame active="history"><Group justify="space-between" mb="md"><div><Title order={2}>歷史與排程</Title><Text c="dimmed">查看你建立的貼文、發布狀態與排程。</Text></div></Group><Paper withBorder radius={8} p="md">{error ? <Text c="red.7" mb="sm">{error}</Text> : null}{loading ? <Text c="dimmed">載入中…</Text> : <Table striped highlightOnHover><Table.Thead><Table.Tr><Table.Th>商品</Table.Th><Table.Th>平台</Table.Th><Table.Th>狀態</Table.Th><Table.Th>排程／建立時間</Table.Th><Table.Th>錯誤</Table.Th><Table.Th>操作</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{posts.map((row) => <Table.Tr key={row.id}><Table.Td>{row.productName || "未命名貼文"}</Table.Td><Table.Td>{row.targets?.map((target) => getPlatformLabel(target.platform)).join("、") || "—"}</Table.Td><Table.Td><Badge color={statusColor(row.status)}>{getStatusLabel(row.status)}</Badge></Table.Td><Table.Td>{formatTimestamp(row.scheduledFor ?? row.createdAt)}</Table.Td><Table.Td>{row.targets?.find((target) => target.errorMessage)?.errorMessage ?? "—"}</Table.Td><Table.Td>{row.status === "scheduled" ? <Button size="xs" color="red" variant="light" loading={cancellingId === row.id} onClick={() => cancelPost(row.id)}>取消排程</Button> : "—"}</Table.Td></Table.Tr>)}{posts.length === 0 ? <Table.Tr><Table.Td colSpan={6}><Text c="dimmed">尚無貼文紀錄。</Text></Table.Td></Table.Tr> : null}</Table.Tbody></Table>}</Paper></AppShellFrame>;
}

function statusColor(status) { return ({ scheduled: "orange", published: "green", failed: "red", cancelled: "gray", publishing: "blue" })[status] ?? "gray"; }
function formatTimestamp(value) { return value ? new Intl.DateTimeFormat("zh-TW", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Taipei" }).format(new Date(value)) : "—"; }
