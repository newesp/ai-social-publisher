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
import { IconCalendarStats, IconLogout, IconMessages, IconPencilPlus, IconSettings } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { clearWizardDraft } from "../lib/wizard/wizard-draft-storage.js";

const navItems = [
  { href: "/support", label: "Support inbox", icon: IconMessages, value: "support" },
  { href: "/", label: "新增貼文", icon: IconPencilPlus, value: "create" },
  { href: "/history", label: "歷史與排程", icon: IconCalendarStats, value: "history" },
  { href: "/settings", label: "系統設定", icon: IconSettings, value: "settings" },
];

export function AppShellFrame({ active, children }) {
  const [opened, { toggle }] = useDisclosure();
  const [user, setUser] = useState(null);
  const [supportCount, setSupportCount] = useState(0);

  useEffect(() => {
    let current = true;
    fetch("/api/auth/session")
      .then((response) => response.json())
      .then((session) => {
        if (current) setUser(session?.user ?? null);
      })
      .catch(() => {});
    return () => { current = false; };
  }, []);

  useEffect(() => {
    let current = true;
    let controller = null;
    const refreshSupportCount = async () => {
      if (document.visibilityState !== "visible") return;
      controller?.abort();
      controller = new AbortController();
      try {
        const response = await fetch("/api/support/conversations", { signal: controller.signal });
        const data = response.ok ? await response.json() : null;
        if (current && Number.isSafeInteger(data?.attentionCount) && data.attentionCount >= 0) {
          setSupportCount(data.attentionCount);
        }
      } catch {}
    };
    const refreshWhenVisible = () => { if (document.visibilityState === "visible") refreshSupportCount(); };
    refreshSupportCount();
    document.addEventListener("visibilitychange", refreshWhenVisible);
    const timer = window.setInterval(refreshWhenVisible, 15000);
    return () => { current = false; controller?.abort(); document.removeEventListener("visibilitychange", refreshWhenVisible); window.clearInterval(timer); };
  }, []);

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
            <Avatar color="orange" radius="xl" src={user?.image} alt={user?.name ? `${user.name} 的 Google 頭像` : "Google 帳號頭像"}>
              {getUserInitial(user)}
            </Avatar>
            <UnstyledButton component="a" href="/api/auth/signout" title="登出" onClick={() => clearWizardDraft(undefined, user?.email)}>
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
              rightSection={item.value === "support" && supportCount > 0 ? <Text size="xs">{supportCount}</Text> : null}
            />
          );
        })}
      </AppShell.Navbar>

      <AppShell.Main>{children}</AppShell.Main>
    </AppShell>
  );
}

function getUserInitial(user) {
  return (user?.name?.trim() || user?.email?.trim() || "A").charAt(0).toUpperCase();
}
