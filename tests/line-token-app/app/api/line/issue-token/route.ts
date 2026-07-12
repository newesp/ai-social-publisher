import { NextResponse } from "next/server";

// LINE 官方文件:issue channel access token v2.1
// POST https://api.line.me/oauth2/v2.1/token
export async function POST() {
  const channelId = process.env.LINE_CHANNEL_ID;
  const channelSecret = process.env.LINE_CHANNEL_SECRET;

  if (!channelId || !channelSecret) {
    return NextResponse.json(
      { error: "config_error", error_description: "缺少 LINE_CHANNEL_ID 或 LINE_CHANNEL_SECRET 環境變數" },
      { status: 500 }
    );
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: channelId,
    client_secret: channelSecret,
  });

  const res = await fetch("https://api.line.me/oauth2/v2.1/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });

  const data = await res.json();

  if (!res.ok) {
    return NextResponse.json(data, { status: res.status });
  }

  // data 內含: access_token, expires_in, token_type, key_id
  return NextResponse.json(data);
}
