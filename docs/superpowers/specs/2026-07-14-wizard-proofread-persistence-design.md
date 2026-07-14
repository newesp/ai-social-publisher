# 發文精靈校對、暫存與帳號頭像設計

## 目標

改善三步驟發文流程：Step 1 完整後才允許前進；以 `sessionStorage` 保留尚未送出的草稿；發布前使用 Step 2 選定的 LLM 檢查錯字；成功後提供「再新增貼文」；將非專有名詞的 UI 改為繁體中文；恢復 Google SSO 頭像。

## 已確認的產品規則

- Step 1 完整代表商品名稱與商品特色去除空白後仍有內容，目標受眾與內容語氣有值，且至少選擇一個發布平台。
- Step 1 未完整時，「下一步」及 Step 2、Step 3 的步驟圖示均不可點擊。
- Step 1 完整後可點 Step 2 或 Step 3；直接進 Step 3 時，若尚未生成內容，必須自動生成。
- Step 2 不顯示 `gemini-2.5-flash-lite`。此型號是錯置於圖片模型清單的 LLM 型號，因此從目前的圖片模型選項與預設移除，不作為圖片模型保留。
- 發布前以 Step 2 選定的 LLM 一次檢查所有平台的最終文案。只檢查錯字，不把品牌、產品名稱、LINE、Meta 等專有名詞當成錯字。
- 有疑似錯字或校對服務失敗時停止流程，不呼叫貼文建立 API。錯字結果顯示平台、原文片段、建議文字及原因。
- 僅在貼文回傳 `scheduled` 或 `published` 時視為成功，隱藏原發布按鈕並顯示「再新增貼文」。失敗或部分失敗保留結果，不顯示成功重設按鈕。
- 「再新增貼文」清除精靈 `sessionStorage`、回到 Step 1、重設表單、生成內容、圖片、錯字與發布結果；模型偏好仍沿用既有偏好儲存，不一併刪除。
- 狀態碼在資料/API 內維持英文，只有畫面使用中文對照（例如 `scheduled` 顯示「已排程」）。LINE、Google、OpenAI、Gemini、LLM、API Key、模型名稱等專有名詞保留。

## 架構與資料流

### 精靈狀態

新增 `wizard-draft-storage.js`，以版本化 key 儲存可序列化快照：目前步驟、表單、生成後的平台文案、圖片 URL、穩定的生成狀態與發布結果。元件初次掛載先讀取快照；沒有快照才套用模型偏好。初始化完成後，每次狀態更新寫回 `sessionStorage`。不保存 `loading` 等短暫狀態，避免重新載入後卡住。

### 步驟導覽

`wizard-flow.js` 提供純函式檢查 Step 1 完整性、步驟是否可選、進入預覽時是否需要生成。UI 將 Mantine Stepper 的 `allowStepClick`／`allowStepSelect` 與同一驗證結果連動，底部「下一步」也使用相同規則。

### 發布前校對

新增 `proofread-service.js` 與 `/api/proofread`。路由沿用現有登入者與每位使用者設定隔離機制，讀取該使用者的供應商金鑰。LLM 回傳嚴格 JSON；服務會驗證資料形狀並只接受屬於本次 targets 的平台。UI 先呼叫 `/api/proofread`，`issues` 為空才呼叫 `/api/posts`。

### Google 頭像

目前根因是 `AppShellFrame` 固定渲染字母 `A`，沒有讀取 session。頁首掛載時讀取 NextAuth `/api/auth/session`，以 `session.user.image` 作為 Mantine Avatar 的 `src`，並以名稱或 email 首字母作為載入失敗／缺圖時的 fallback。Auth callback 明確保留 Google `name` 與 `image`，避免自訂 JWT/session callback 遺失資料。

### 中文化

集中提供貼文與平台狀態的中文顯示函式，供精靈與歷史頁共用。設定頁、預覽說明、歷史 API fallback 錯誤及 metadata 描述改為繁體中文；專有名詞不翻譯。

## 錯誤處理與安全性

- 校對 provider、JSON 解析或設定讀取失敗皆以安全中文訊息回應；不得把 API Key、email 或 provider 原始私密內容送回前端。
- 校對沒有通過時不建立排程、不發布。
- `sessionStorage` 僅保存在目前分頁，登出或關閉分頁不做跨工作階段同步；內容不送入資料庫直到使用者確認發布。
- Google 頭像無 URL 或圖片載入失敗時仍顯示 fallback，不影響登出操作。

## 測試與驗收

- 純函式測試 Step 1 完整性、直接進 Step 3 生成條件、狀態中文對照及 sessionStorage 快照讀寫／損毀回復。
- API/服務測試 Google 與 OpenAI 校對請求、JSON 解析、錯字／無錯字、錯誤安全回應及登入者設定隔離。
- UI 契約測試校對先於發布、錯字阻擋、成功按鈕切換、草稿重設、Step 禁用、中文與頭像資料流。
- 執行完整 `npm.cmd test` 與 `npm.cmd run build`；完整測試允許保留基線既有的 1 個 `auth-policy` 失敗，但不得新增失敗。
- 以本機瀏覽器檢查桌面與窄版：按鈕無裁切、步驟禁用清楚、錯字提醒可讀、成功按鈕切換、設定往返草稿仍存在，以及右上角頭像呈現。
