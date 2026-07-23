# AI Social Publisher & LINE AI Customer Support

全方位的社群媒體與客戶服務 AI 平台。整合 **AI 社群貼文與圖片自動生成與排程發布**，以及 **LINE AI 自動客服與真人接管收件匣**。

目前發布功能支援 Meta（Facebook Page）與 LINE Official Account；客服功能支援 LINE 一對一訊息自動回覆、FAQ 知識庫檢索與真人接管機制。

---

## 核心功能

### 1. AI 社群貼文發布 (AI Social Publishing)
- **多 AI 供應商與圖文生成**：整合 Google Gemini 與 OpenAI API，可自動生成適合各平台的社群貼文文案與圖片提示詞/圖像。
- **平台專屬預覽與編輯**：針對 Meta (Facebook Page) 及 LINE 格式獨立建置貼文預覽，支援個別文案與 Hashtag 編輯。
- **圖片上傳與託管**：支援使用 Vercel Blob 保存與託管自動生成或使用者上傳的圖片。
- **多平台發布與排程**：提供「立即發布」與「指定時間排程發布」，並包含完整的發布狀態追蹤與失敗重試。
- **平台連線管理**：使用者可獨立連結與管理其社群帳號（Meta 採用 OAuth 2.0，LINE 採用 Channel Access Token 與 Secret），所有敏感憑證皆採用 AES 加密存儲。

### 2. LINE AI 客服自動回覆 (LINE AI Customer Support)
- **一對一自動訊息回覆**：透過 LINE Webhook 接收顧客訊息，利用工作流 (Workflow) 與大語言模型自動生成適切流暢的回覆。
- **FAQ 知識庫管理 (Knowledge Base / RAG)**：可自訂 FAQ 內容，包含分類、關鍵字、優先權與內部備註，讓 AI 依據知識庫精準回答顧客問題。
- **人機接管與狀態管理 (Handoff & State Machine)**：
  - 精細的對話狀態維護（`ai_active`, `waiting_human`, `human_handled`, `resolved`）。
  - 當 AI 無法解答或顧客主動請求時，系統自動將對話轉交人工處理（`waiting_human`）。
  - **客服收件匣 (Support Inbox)**：專用管理介面，提供線上紀錄瀏覽、手動接管 (Take over)、發送 LINE Push 回覆、交回 AI (Return to AI)、標記結案 (Resolve) 與 Undo 狀態撤銷功能。
- **系統就緒檢查儀表板 (Readiness Check)**：提供完整的系統發布前檢查，包含 LINE 連線狀態、AI 模型設定、FAQ 數量、Webhook 驗證、Redelivery 聲明與原生自動回覆停用檢查。
- **隱私與安全合規**：
  - 顧客識別碼、顯示名稱、LINE Reply Token 與傳送內文皆經過安全加密儲存。
  - **資料保留自動清理排程**：每日定期分批清理超過 30 天的對話文字與過期 Reply Token，符合個資資安條款與最小化保存原則。

### 3. 權限與身份驗證 (Auth & Access Control)
- **Google OAuth 登入**：基於 NextAuth.js 實作安全驗證。
- **雙重存取模式**：
  - `demo` 模式：允許任意 Google 帳戶登入體驗。
  - `production` 模式：嚴格限制僅允許 `ALLOWED_GOOGLE_EMAILS` 白名單與 `ADMIN_EMAILS` 管理者存取。

---

## 技術棧

- **前端與框架**：Next.js (App Router)、React、Mantine UI (@mantine/core, @mantine/dates, @mantine/hooks, @mantine/notifications)、Tabler Icons
- **身份驗證**：NextAuth.js (Google Provider)
- **資料庫與 ORM**：Turso / libSQL (SQLite 相容)、Drizzle ORM
- **媒體儲存**：Vercel Blob
- **AI API**：Google Gemini SDK (`@google/genai`)、OpenAI SDK (`openai`)
- **工作流與任務**：Vercel Workflow (`workflow`)

---

## 快速開始

### 系統需求

- Node.js 20+ 與 npm
- 可用的 Turso / libSQL 資料庫
- Vercel Blob 儲存空間

### 1. 安裝與設定環境變數

```bash
npm install
# Windows PowerShell
Copy-Item .env.example .env.local
# Linux / macOS
cp .env.example .env.local
```

在 `.env.local` 填入必要設定：

```dotenv
NEXTAUTH_URL=http://localhost:3000
NEXTAUTH_SECRET=<隨機長字串>
GOOGLE_CLIENT_ID=<Google OAuth client ID>
GOOGLE_CLIENT_SECRET=<Google OAuth client secret>

# AUTH_MODE 設定為 demo (允許任一 Google email) 或 production (必須設定白名單)
AUTH_MODE=demo
ALLOWED_GOOGLE_EMAILS=
ADMIN_EMAILS=admin@example.com

TURSO_DATABASE_URL=libsql://<database>.turso.io
TURSO_AUTH_TOKEN=<Turso auth token>
SETTINGS_ENCRYPTION_KEY=<32-byte base64 加密金鑰>

# 圖片儲存設定（二擇一；本機通常使用 BLOB_READ_WRITE_TOKEN）
BLOB_READ_WRITE_TOKEN=<Vercel Blob token>
# VERCEL_OIDC_TOKEN=<Vercel OIDC token>
# BLOB_STORE_ID=<Vercel Blob store ID>
```

依需求設定 AI 供應商、社群平台與排程金鑰：

```dotenv
# 至少填寫一個 AI Provider Key
GOOGLE_AI_API_KEY=
OPENAI_API_KEY=

# Meta OAuth App 設定 (發布貼文用)
META_APP_ID=
META_APP_SECRET=
META_OAUTH_REDIRECT_URI=http://localhost:3000/api/platform-connections/meta/callback

# Cron 排程端點保護金鑰
CRON_SECRET=<隨機長字串>

# LINE 客服安全測試與驗收用 (選擇性)
SUPPORT_WORKFLOW_SMOKE_ENABLED=false
```

### 2. 資料庫 Migration 與啟動服務

在套用 migration 前，請先完成並驗證資料庫備份；兩個 migration 指令都會要求明確確認備份。依要更新的功能設定對應的確認變數，再執行指令：

```bash
# 平台連線與貼文 Schema
$env:PLATFORM_MIGRATION_BACKUP_CONFIRMED = "YES" # PowerShell
# export PLATFORM_MIGRATION_BACKUP_CONFIRMED=YES  # Linux / macOS
npm run migrate:platform-schema

# LINE 客服對話、FAQ 與收件匣 Schema
$env:SUPPORT_MIGRATION_BACKUP_CONFIRMED = "YES" # PowerShell
# export SUPPORT_MIGRATION_BACKUP_CONFIRMED=YES  # Linux / macOS
npm run migrate:support-schema

# 遷移平台連線憑證，並清理舊版未加密憑證
# （同樣需要 PLATFORM_MIGRATION_BACKUP_CONFIRMED=YES）
npm run migrate:platform-connections

# 啟動本地開發伺服器
npm run dev
```

開啟瀏覽器前往 [http://localhost:3000](http://localhost:3000) 登入即可開始使用。

---

## 常用指令

```bash
npm run dev                         # 啟動開發伺服器 (包含環境變數檢查)
npm run build                       # 生產環境編譯 (Next.js build)
npm start                           # 啟動生產環境伺服器
npm test                            # 執行 Node 原生單元測試
npm run check:runtime-config        # 驗證必要環境變數設定
npm run migrate:platform-schema     # 套用平台連線與貼文 Schema（需先確認資料庫備份）
npm run migrate:support-schema      # 套用 LINE 客服相關 Schema（需先確認資料庫備份）
npm run migrate:platform-connections # 遷移平台連線憑證並清理舊版憑證（需先確認資料庫備份）
npm run cleanup:legacy-platform-credentials # 清理資料庫中的舊版未加密憑證
```

---

## 排程作業 (Cron Jobs)

系統提供兩個由 `Authorization: Bearer <CRON_SECRET>` 保護的自動化排程端點，請於部署平台（如 Vercel Cron）設定定時觸發：

1. **貼文排程發布 (`GET /api/cron`)**
   - **功能**：自動掃描並發布到達指定時間的排程貼文，可重試的供應商錯誤會保持排程狀態，其他錯誤標示為失敗。

2. **客服資料保留清理 (`GET /api/cron/support-retention`)**
   - **建議頻率**：每日 01:30 UTC 執行一次。
   - **功能**：符合個資保護規範，分批清理超過 30 天的歷史對話文字、過期的 LINE Reply Token 密文以及已結案的推播內容；稽核欄位與安全錯誤碼將予以保留。

---

## 操作與維運手冊

- [LINE AI 客服維運手冊](docs/line-support-runbook.md)：LINE Console 設定、就緒檢查、日常操作、事故處理與資料保留。
- [平台連線資料庫遷移手冊](docs/platform-connection-migration-runbook.md)：資料庫備份、migration、驗證與復原程序。
- [LINE Workflow 執行說明](docs/line-workflow-runtime.md)：供開發人員排查 Workflow 註冊與執行問題。
- [LINE 客服 RAG 設計規格](docs/support-rag-implementation-spec.md)：尚未實作的後續擴充設計，不是目前產品功能說明。

---

## 安全性與注意事項

- **保護敏感資訊**：切勿將 `.env.local`、API Keys、OAuth Secret、Turso Database Token 或 `SETTINGS_ENCRYPTION_KEY` 提交至版本控制系統。
- **正式環境防護**：生產環境務必將 `AUTH_MODE` 設定為 `production` 並指定 `ALLOWED_GOOGLE_EMAILS`。
- **測試隔離**：請使用專用的測試 Meta 專頁與測試 LINE Official Account 驗收流程，嚴禁以客戶真實帳戶測試。

---

## 專案結構

```text
src/app/             Next.js 頁面與 API 路由 (/api/posts, /api/support, /api/webhooks/line, /api/cron 等)
src/components/      前端 UI 元件 (貼文精靈, 平台預覽, 客服收件匣 Support Inbox, FAQ 管理器, 設定面板)
src/lib/             核心業務邏輯 (AI 生成, AI 客服工作流, Auth 驗證, 加密, Turso DB 操作, 排程與發布)
drizzle/             Drizzle SQL Migration 檔案
scripts/             環境變數檢查與資料庫 Migration / 清理腳本
```

---

## 授權

[MIT](LICENSE)
