# Step 3 平台連線名稱預覽設計

## 目標

Step 3 的 Meta 與 LINE 預覽標題應顯示目前登入帳號實際連結的平台名稱，例如「小朋友機器人」，不再顯示硬編碼的 New ESP 名稱。

## 設計

- `CreatePostWizard` 沿用既有 `/api/platform-connections` 回應，不新增 API 請求。
- 載入 active connections 時，保留各平台非空白的 `displayName`。
- 精靈直接將對應的 `displayName` 傳給 `PlatformPreview`。
- `PlatformPreview` 只負責顯示傳入名稱；Meta 缺少名稱時顯示「Meta」，LINE 缺少名稱時顯示「LINE」。
- 不修改 `buildPlatformPreviews`、發布 payload、AI 生成內容、平台連線 API 或 sessionStorage 草稿格式。
- 平台重新連線後，既有連線重新載入流程會帶入最新名稱。

## 測試

- 元件契約測試確認精靈把 active connection 的 `displayName` 傳給平台預覽。
- 預覽元件測試確認實際名稱與 Meta／LINE fallback。
- 執行相關測試、完整測試與 production build，確保既有功能沒有回歸。
