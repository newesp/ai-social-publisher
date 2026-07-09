"use client";

import { Button, Paper, Stack, Text, Title } from "@mantine/core";
import { IconBrandGoogle } from "@tabler/icons-react";

export default function LoginPage() {
  return (
    <main className="login-page">
      <Paper className="login-panel" shadow="md" p="xl" radius={8}>
        <Stack gap="lg">
          <div>
            <Text size="sm" c="orange.8" fw={700}>
              AI Social Publisher
            </Text>
            <Title order={1}>使用 Google 帳號登入</Title>
            <Text c="dimmed" mt="sm">
              MVP 展示期允許所有 Google 帳號登入；設定與 token 管理僅限 admin。
            </Text>
          </div>
          <Button leftSection={<IconBrandGoogle size={18} />} component="a" href="/api/auth/signin">
            Google 登入
          </Button>
        </Stack>
      </Paper>
      <style jsx>{`
        .login-page {
          min-height: 100vh;
          display: grid;
          place-items: center;
          padding: 24px;
          background: linear-gradient(135deg, #fff7ed 0%, #f8fafc 58%, #ecfeff 100%);
        }

        .login-panel {
          width: min(440px, 100%);
        }
      `}</style>
    </main>
  );
}
