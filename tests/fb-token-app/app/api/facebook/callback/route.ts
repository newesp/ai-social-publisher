import { NextRequest, NextResponse } from "next/server";

const GRAPH_VERSION = "v20.0";

export async function GET(req: NextRequest) {
  const appId = process.env.FB_APP_ID;
  const appSecret = process.env.FB_APP_SECRET;
  const redirectUri = process.env.FB_REDIRECT_URI;

  if (!appId || !appSecret || !redirectUri) {
    return NextResponse.json(
      { error: "缺少 FB_APP_ID / FB_APP_SECRET / FB_REDIRECT_URI 環境變數" },
      { status: 500 }
    );
  }

  const code = req.nextUrl.searchParams.get("code");
  const errorParam = req.nextUrl.searchParams.get("error_description");

  if (errorParam) {
    return NextResponse.json({ error: errorParam }, { status: 400 });
  }
  if (!code) {
    return NextResponse.json({ error: "缺少 code 參數" }, { status: 400 });
  }

  try {
    // 1) 用 code 換「短期 User Access Token」
    const shortTokenUrl = new URL(
      `https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token`
    );
    shortTokenUrl.searchParams.set("client_id", appId);
    shortTokenUrl.searchParams.set("client_secret", appSecret);
    shortTokenUrl.searchParams.set("redirect_uri", redirectUri);
    shortTokenUrl.searchParams.set("code", code);

    const shortRes = await fetch(shortTokenUrl.toString());
    const shortData = await shortRes.json();
    if (!shortRes.ok) {
      return NextResponse.json({ step: "short_token", error: shortData }, { status: 400 });
    }
    const shortLivedToken = shortData.access_token as string;

    // 2) 短期 User Token 換「長期(約60天) User Access Token」
    const longTokenUrl = new URL(
      `https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token`
    );
    longTokenUrl.searchParams.set("grant_type", "fb_exchange_token");
    longTokenUrl.searchParams.set("client_id", appId);
    longTokenUrl.searchParams.set("client_secret", appSecret);
    longTokenUrl.searchParams.set("fb_exchange_token", shortLivedToken);

    const longRes = await fetch(longTokenUrl.toString());
    const longData = await longRes.json();
    if (!longRes.ok) {
      return NextResponse.json({ step: "long_token", error: longData }, { status: 400 });
    }
    const longLivedUserToken = longData.access_token as string;

    // 3) 用長期 User Token 拿「永久 Page Access Token」清單
    const pagesUrl = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/me/accounts`);
    pagesUrl.searchParams.set("access_token", longLivedUserToken);

    const pagesRes = await fetch(pagesUrl.toString());
    const pagesData = await pagesRes.json();
    if (!pagesRes.ok) {
      return NextResponse.json({ step: "pages", error: pagesData }, { status: 400 });
    }

    // 直接把結果渲染成簡單頁面,方便複製
    const pages = (pagesData.data || []) as Array<{
      id: string;
      name: string;
      access_token: string;
    }>;

    const rows = pages
      .map(
        (p) => `
        <tr>
          <td style="padding:8px;border:1px solid #ddd;">${p.name}</td>
          <td style="padding:8px;border:1px solid #ddd;font-family:monospace;">${p.id}</td>
          <td style="padding:8px;border:1px solid #ddd;font-family:monospace;word-break:break-all;">${p.access_token}</td>
        </tr>`
      )
      .join("");

    const html = `
      <html><head><meta charset="utf-8"><title>Page Tokens</title></head>
      <body style="font-family:sans-serif;max-width:900px;margin:40px auto;">
        <h1>取得成功 ✅</h1>
        <p>下面每個 Page 的 access_token 就是<strong>永久 Page Access Token</strong>(除非你撤銷授權或改密碼)。</p>
        <table style="border-collapse:collapse;width:100%;">
          <thead>
            <tr>
              <th style="padding:8px;border:1px solid #ddd;text-align:left;">Page 名稱</th>
              <th style="padding:8px;border:1px solid #ddd;text-align:left;">Page ID</th>
              <th style="padding:8px;border:1px solid #ddd;text-align:left;">Access Token</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
        <p style="color:#b00;margin-top:24px;">
          ⚠️ 這頁會把 token 明碼顯示,複製到你的 n8n / .env 之後,記得關掉這個分頁,
          不要把畫面截圖或貼到聊天工具、公開頻道。
        </p>
      </body></html>`;

    return new NextResponse(html, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? "unknown error" }, { status: 500 });
  }
}
