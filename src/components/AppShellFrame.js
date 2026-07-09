"use client";

import {
  AppShell,
  Avatar,
  Burger,
  Group,
  NavLink,
  Text,
  Title,
  UnstyledButton,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { IconCalendarStats, IconLogout, IconPencilPlus, IconSettings } from "@tabler/icons-react";

const navItems = [
  { href: "/", label: "新增貼文", icon: IconPencilPlus, value: "create" },
  { href: "/history", label: "歷史與排程", icon: IconCalendarStats, value: "history" },
  { href: "/settings", label: "系統設定", icon: IconSettings, value: "settings" },
];

export function AppShellFrame({ active, children }) {
  const [opened, { toggle }] = useDisclosure();

  return (
    <AppShell
      header={{ height: 64 }}
      navbar={{ width: 248, breakpoint: "sm", collapsed: { mobile: !opened } }}
      padding="md"
    >
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between" wrap="nowrap">
          <Group gap="sm" wrap="nowrap">
            <Burger opened={opened} onClick={toggle} hiddenFrom="sm" size="sm" />
            <div>
              <Title order={3} textWrap="nowrap">
                AI Social Publisher
              </Title>
              <Text size="xs" c="dimmed">
                newesp/ai-social-publisher
              </Text>
            </div>
          </Group>
          <Group gap="sm" wrap="nowrap">
            <Avatar color="orange" radius="xl">
              A
            </Avatar>
            <UnstyledButton component="a" href="/api/auth/signout" title="登出">
              <IconLogout size={20} />
            </UnstyledButton>
          </Group>
        </Group>
      </AppShell.Header>

      <AppShell.Navbar p="sm">
        {navItems.map((item) => {
          const Icon = item.icon;
          return (
            <NavLink
              key={item.value}
              href={item.href}
              label={item.label}
              active={active === item.value}
              leftSection={<Icon size={18} />}
            />
          );
        })}
      </AppShell.Navbar>

      <AppShell.Main>{children}</AppShell.Main>
    </AppShell>
  );
}
