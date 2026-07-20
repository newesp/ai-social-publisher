# AI Social Publisher

使用 AI 產生社群貼文與圖片，預覽、校對後可立即或排程發布到已連線的社群平台。目前支援 Meta（Facebook Page）與 LINE Official Account。

## 功能

- Google Gemini 或 OpenAI 生成各平台貼文文案與圖片。
- 依 Meta、LINE 的格式建立可個別編輯的內容預覽。
- Google 登入；正式環境可用 email allowlist 限制存取。
- 每位使用者獨立管理平台連線；Meta 使用 OAuth、LINE 使用 Channel access token。
- 立即發布、指定日期排程發布、發布紀錄與失敗狀態。
- 使用 Turso/libSQL 與 Drizzle 保存貼文、目標平台、連線設定與稽核資料；敏感連線資訊會加密保存。

## 技術

Next.js、React、Mantine、NextAuth、Drizzle ORM、Turso/libSQL、Vercel Blob、Google Gemini 與 OpenAI API。

## 快速開始

需求：Node.js 20+、npm，以及可用的 Turso/libSQL 資料庫與 Vercel Blob 儲存空間。

```bash
npm install
Copy-Item .env.example .env.local
```

在 `.env.local` 填入下列必要設定：

```dotenv
NEXTAUTH_URL=http://localhost:3000
NEXTAUTH_SECRET=<隨機長字串>
GOOGLE_CLIENT_ID=<Google OAuth client ID>
GOOGLE_CLIENT_SECRET=<Google OAuth client secret>

# demo 允許任一非空 Google email；production 必須設定 allowlist。
AUTH_MODE=demo
ALLOWED_GOOGLE_EMAILS=
ADMIN_EMAILS=admin@example.com

TURSO_DATABASE_URL=libsql://<database>.turso.io
TURSO_AUTH_TOKEN=<Turso auth token>
SETTINGS_ENCRYPTION_KEY=<32-byte base64 key>

# 二擇一：本機通常使用前者；Vercel 可使用後者組合。
BLOB_READ_WRITE_TOKEN=<Vercel Blob token>
# VERCEL_OIDC_TOKEN=<Vercel OIDC token>
# BLOB_STORE_ID=<Vercel Blob store ID>
```

依需要加入 AI、發布與排程設定：

```dotenv
GOOGLE_AI_API_KEY=
OPENAI_API_KEY=

META_APP_ID=
META_APP_SECRET=
META_OAUTH_REDIRECT_URI=http://localhost:3000/api/platform-connections/meta/callback

CRON_SECRET=<隨機長字串>
```

`GOOGLE_AI_API_KEY` 與 `OPENAI_API_KEY` 至少設定一個，並在介面選擇對應供應商。啟動前套用資料庫 migration：

```bash
npm run migrate:platform-connections
npm run dev
```

開啟 [http://localhost:3000](http://localhost:3000)，以 Google 帳戶登入後，先在「設定」連線 Meta 或 LINE，再建立貼文。

## 常用指令

```bash
npm run dev                         # 開發伺服器
npm run build                       # production build
npm start                           # 啟動 production server
npm test                            # Node 測試
npm run check:runtime-config        # 驗證必要環境變數
npm run migrate:platform-connections # 套用並驗證平台連線 schema，再清理舊憑證
```

## 排程發布

排程工作由受保護的端點執行：

```text
GET /api/cron
Authorization: Bearer <CRON_SECRET>
```

將此請求設定在部署平台的排程服務中。端點會處理到期的已排程貼文；可重試的供應商錯誤會保留為排程狀態，其他錯誤則標示為失敗。

## LINE AI 客服維運

LINE AI 客服的完整設定、就緒檢查、事故復原、資料保留與專用測試帳戶驗收程序位於 [docs/line-support-runbook.md](docs/line-support-runbook.md)。

部署時同一個 `CRON_SECRET` 會保護兩個排程端點：每日 01:00 UTC 的貼文排程 `/api/cron`，以及每日 01:30 UTC 的客服內容保留清理 `/api/cron/support-retention`。後者只清除超過 30 天的訊息文字、已過期的 LINE reply token 密文，以及已結案（sent／failed／human_review）的原始推播內容；可重試推播內容、安全狀態與稽核欄位會保留。

## 資料庫 migration 注意事項

在 production 執行 `migrate:platform-connections` 前，請先停止舊 worker／cron、建立並驗證可還原的 Turso 備份，並設定：

```dotenv
PLATFORM_MIGRATION_BACKUP_CONFIRMED=YES
```

完整的操作與復原程序在 [docs/platform-connection-migration-runbook.md](docs/platform-connection-migration-runbook.md)。

## 安全性

- 不要提交 `.env.local`、API key、OAuth secret、資料庫 token 或加密金鑰。
- production 請設定 `AUTH_MODE=production` 與 `ALLOWED_GOOGLE_EMAILS`。
- 請使用專用測試帳戶驗證 Meta、LINE 與排程流程，避免以客戶帳戶做部署測試。

## 專案結構

```text
src/app/             Next.js 頁面與 API routes
src/components/      建立貼文、設定與平台預覽介面
src/lib/             AI、登入、資料庫、排程與發布邏輯
drizzle/             Drizzle SQL migrations
scripts/             runtime 驗證與 migration 指令
tests/               Node test suite
docs/                設計文件與維運 runbook
```

## 授權

[MIT](LICENSE)
