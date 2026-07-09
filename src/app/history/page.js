 "use client";

import { Badge, Group, Paper, Table, Text, Title } from "@mantine/core";
import { AppShellFrame } from "../../components/AppShellFrame.js";

const rows = [
  { product: "示範商品", platform: "Instagram", status: "draft", scheduled: "尚未排程" },
  { product: "夏季活動", platform: "LINE", status: "scheduled", scheduled: "2026-07-09 10:00" },
];

export default function HistoryPage() {
  return (
    <AppShellFrame active="history">
      <Group justify="space-between" mb="md">
        <div>
          <Title order={2}>發文歷史與排程</Title>
          <Text c="dimmed">追蹤每個平台的草稿、排程與發文狀態。</Text>
        </div>
      </Group>
      <Paper withBorder radius={8} p="md">
        <Table striped highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>產品</Table.Th>
              <Table.Th>平台</Table.Th>
              <Table.Th>狀態</Table.Th>
              <Table.Th>排程時間</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.map((row) => (
              <Table.Tr key={`${row.product}-${row.platform}`}>
                <Table.Td>{row.product}</Table.Td>
                <Table.Td>{row.platform}</Table.Td>
                <Table.Td>
                  <Badge color={row.status === "scheduled" ? "orange" : "gray"}>{row.status}</Badge>
                </Table.Td>
                <Table.Td>{row.scheduled}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Paper>
    </AppShellFrame>
  );
}
