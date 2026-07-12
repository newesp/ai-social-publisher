# FB Page Token 產生器

一個小型 Next.js App,自動完成「登入 → 短期 token → 換長期 token → 拿永久 Page Access Token」整套流程,不用再手動貼 Graph API Explorer 的網址。

## 1. Meta App 設定

1. 到 https://developers.facebook.com/apps 建立(或使用既有)App,類型選 **Business**
2. 左側選單加入 **Facebook Login** 產品
3. 到 **Facebook Login → Settings**,在 **Valid OAuth Redirect URIs** 填入你的 callback 網址,例如:
   - 本機測試:`http://localhost:3000/api/facebook/callback`
   - 部署後:`https://your-app.vercel.app/api/facebook/callback`
4. 到 **Settings → Basic** 複製 **App ID** 和 **App Secret**

## 2. 環境變數

複製 `.env.local.example` 為 `.env.local`,填入:

```
FB_APP_ID=xxxx
FB_APP_SECRET=xxxx
FB_REDIRECT_URI=http://localhost:3000/api/facebook/callback
```

## 3. 本機執行

```bash
npm install
npm run dev
```

打開 http://localhost:3000,點「用 Facebook 登入並取得 Page Token」,登入並同意權限後,會列出你管理的所有 Page 及其**永久 Access Token**。

## 4. 部署到 Vercel

```bash
vercel
```

部署後記得:
- 到 Vercel Project → Settings → Environment Variables 補上 `FB_APP_ID` / `FB_APP_SECRET` / `FB_REDIRECT_URI`(用正式網址)
- 回 Meta App Dashboard 把正式網址加進 Valid OAuth Redirect URIs

## 權限(Scopes)

目前預設要求:
- `pages_show_list`
- `pages_read_engagement`
- `pages_manage_posts`

如果你的 App 還在 **Development Mode**,只有 App 角色成員(Admin/Developer/Tester)能走這個流程並拿到權限;要開放給其他人用,需要送 **App Review**。你自己用來拿自己粉專的 token,不需要送審。

## 安全提醒

- `/api/facebook/callback` 這頁會把 token 明碼印在畫面上,只在自己瀏覽器看、複製到 `.env` / n8n credential 之後就關掉分頁
- `FB_APP_SECRET` 絕對不要放到前端(`NEXT_PUBLIC_` 開頭)或 commit 進 git
- Page Token 理論上永久有效,但如果使用者(你自己)改密碼、移除 App 授權,或 60 天內都沒使用,還是會失效,建議定期用 [Access Token Debugger](https://developers.facebook.com/tools/debug/accesstoken/) 檢查
