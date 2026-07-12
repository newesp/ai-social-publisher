import { NextRequest, NextResponse } from "next/server";

// LINE 官方文件:revoke channel access token v2.1
// POST https://api.line.me/oauth2/v2.1/revoke
export async function POST(req: NextRequest) {
  const channelId = process.env.LINE_CHANNEL_ID;
  const channelSecret = process.env.LINE_CHANNEL_SECRET;
  const { access_token } = await req.json();

  if (!channelId || !channelSecret) {
    return NextResponse.json(
      { error: "config_error", error_description: "缺少 LINE_CHANNEL_ID 或 LINE_CHANNEL_SECRET 環境變數" },
      { status: 500 }
    );
  }
  if (!access_token) {
    return NextResponse.json({ error: "missing access_token" }, { status: 400 });
  }

  const body = new URLSearchParams({
    client_id: channelId,
    client_secret: channelSecret,
    access_token,
  });

  const res = await fetch("https://api.line.me/oauth2/v2.1/revoke", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    return NextResponse.json(data, { status: res.status });
  }

  return NextResponse.json({ ok: true });
}
