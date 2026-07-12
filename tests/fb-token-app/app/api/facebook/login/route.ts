import { NextRequest, NextResponse } from "next/server";

// 你要哪些權限就加在這裡。發文/發圖至少需要 pages_manage_posts + pages_show_list。
const SCOPES = [
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_posts",
].join(",");

export async function GET(req: NextRequest) {
  const appId = process.env.FB_APP_ID;
  const redirectUri = process.env.FB_REDIRECT_URI; // 例如 https://your-app.vercel.app/api/facebook/callback

  if (!appId || !redirectUri) {
    return NextResponse.json(
      { error: "缺少 FB_APP_ID 或 FB_REDIRECT_URI 環境變數" },
      { status: 500 }
    );
  }

  const authUrl = new URL("https://www.facebook.com/v20.0/dialog/oauth");
  authUrl.searchParams.set("client_id", appId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", SCOPES);
  authUrl.searchParams.set("response_type", "code");

  return NextResponse.redirect(authUrl.toString());
}
