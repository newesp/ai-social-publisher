# LINE Channel Access Token 產生器

用 Channel ID + Channel Secret 直接換發 **Channel Access Token v2.1**,不用進 Console 手動點。

## 1. 取得 Channel ID / Secret

LINE Developers Console → 你的 Provider → 你的 Messaging API Channel → **Basic settings** 分頁,可以看到:
- **Channel ID**
- **Channel Secret**

## 2. 環境變數

複製 `.env.local.example` 為 `.env.local`,填入:

```
LINE_CHANNEL_ID=xxxx
LINE_CHANNEL_SECRET=xxxx
```

## 3. 本機執行

```bash
npm install
npm run dev
```

打開 http://localhost:3000,點「取得 Channel Access Token」,會呼叫 LINE 的
`POST https://api.line.me/oauth2/v2.1/token`,回傳 `access_token` / `expires_in`(秒,約 30 天)/ `key_id`。

## 4. 部署到 Vercel

```bash
vercel
```

到 Vercel Project → Settings → Environment Variables 補上 `LINE_CHANNEL_ID` / `LINE_CHANNEL_SECRET`。

## 關於 v2.1 token 的重點

- **效期固定 30 天**,不像 Long-lived token 可以永久,所以你的自動化(n8n)最好排一個排程(例如每 25 天)重打 `/api/line/issue-token` 换新的,並更新 n8n 的 credential
- 同一個 Channel 最多可以同時發行 **30 組** v2.1 token,超過上限要先撤銷舊的才能再發新的 —— 頁面上有「撤銷這組 Token」按鈕可以清掉不用的
- 如果你不想處理 30 天到期的問題,回到 Console 手動按一次 **Issue** 產生 **long-lived token** 反而更省事(那個是永久的);這個 app 適合你想要「完全自動化、不想手動碰 Console」的情境

## 安全提醒

- `LINE_CHANNEL_SECRET` 只放伺服器端環境變數,不要加 `NEXT_PUBLIC_` 前綴,也不要 commit 進 git
- 拿到的 access_token 顯示在畫面上,複製走後記得關掉分頁,不要截圖分享
