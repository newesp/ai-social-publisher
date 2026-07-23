# 後續優化待辦

本文件記錄尚未實作的改善項目，供後續維護者與 agent 排程。除非另有明確授權，任何項目都不得直接對正式 LINE、AI 供應商、資料庫 migration 或部署環境執行操作。

## 客服收件匣更新效率

### 現況

- `SupportInbox` 僅在頁面可見時以 15 秒間隔輪詢；使用者回到可見分頁時會立即重新載入。
- 每次輪詢會取得對話列表與待確認狀態轉換；若已選取對話，也會重新取得該對話詳細內容。
- 目前每頁最多載入 30 筆對話摘要。小至中型客服量可繼續使用此模式。

### 優先項目：保留輪詢、降低無變更成本

- [ ] 為對話列表 API 加入增量讀取協定，例如 `updatedSince`、版本游標或 ETag／`If-None-Match`；沒有變更時回傳 `304 Not Modified` 或極小回應。
- [ ] 將列表摘要、待確認狀態轉換與已選取對話的更新條件分開；沒有活動、未讀變化或待確認狀態時，不重新抓取 detail。
- [ ] 依情境調整輪詢頻率：一般閒置時維持 15–30 秒；有 `waiting_human`、傳送重試或已選取的活躍對話時縮短為約 5 秒。
- [ ] 對連續失敗加入指數退避與手動重新整理提示；分頁重新可見時立即恢復正常更新。
- [ ] 補齊測試：分頁不可見不請求、請求取消不覆寫新資料、無變更回應不重繪、退避與恢復邏輯正確。

**啟動條件：** 同時有數十名客服長時間開啟收件匣，或監測到輪詢造成明顯的資料庫／API 成本與延遲。

### 第二階段：即時通知（僅在有明確需求時）

- [ ] 若新訊息必須在 1–2 秒內顯示，評估 SSE、WebSocket 或受管理的即時事件服務。
- [ ] 保持既有授權模型：事件只傳送對話 ID、版本與變更類型；前端收到事件後，仍透過既有授權 API 取得摘要或詳細內容。不得廣播客戶訊息、LINE token 或任何敏感內容。
- [ ] 設計斷線重連、事件遺失回補、重複事件去重、分頁不可見時暫停訂閱，以及每位 owner 的資料隔離。
- [ ] 驗證 Vercel 部署與所選即時服務的連線生命週期、成本、可觀測性與降級回輪詢機制。

**完成標準：** 新訊息可在目標延遲內顯示；斷線後不遺失資料；所有 owner scope、授權與敏感資料保護測試通過；即時服務不可用時可安全退回輪詢。

## LINE 客服 RAG Phase 2：Embedding 與 Hybrid Retrieval

**狀態：** 尚未實作。現行客服僅使用已啟用的 FAQ；完整設計參見 [support-rag-implementation-spec.md](support-rag-implementation-spec.md)。

### 適用時機

- [ ] 確認知識量超過約 100 則，或文件內容已長到單靠 FAQ／關鍵字檢索無法取得可靠結果。
- [ ] 先以測試資料量測現行 lexical/CJK 檢索的命中率、轉人工率、延遲與成本，再決定是否導入 embedding。

### 實作項目

- [ ] 建立 owner-scoped 的知識文件與 chunk 資料模型；每個 chunk 約 300–700 個中文字元，保留文件、段落與版本 metadata。
- [ ] 建立文件新增、更新、刪除時的 chunk 與 embedding 產生／失效流程；必須可重試、可去重，且不阻塞 LINE webhook 回應。
- [ ] 抽出 `retrieveRagKnowledge()` 介面，先維持 lexical/CJK top-k，再加入 vector similarity 與 hybrid rerank；embedding 失敗時安全退回 lexical retrieval。
- [ ] 限制檢索、向量與資料庫查詢都依 owner scope 執行；禁止跨 owner 搜尋或混用 embedding。
- [ ] 將實際採用的 source ID 寫入 AI decision，並讓收件匣 detail 顯示可追溯的來源。
- [ ] 擴充 AI decision schema、提示詞與伺服器端驗證：模型只能引用取得的來源；來源不足、格式錯誤或高風險內容時 fail closed 並轉人工。
- [ ] 任何 `internalNotes` 或內部文件內容不得送進 LLM prompt、API response、Inbox 顯示或 LINE 訊息。

### 驗證與交付

- [ ] 單元測試：中文／關鍵字檢索、hybrid 排序、owner 隔離、chunk 版本、embedding 失敗回退、prompt-injection 與 internal notes 不外洩。
- [ ] 整合測試：`decideAndPersist()` 能在單一交易中保存 decision、outbox 與來源；引用不存在 source ID 時拒絕結果。
- [ ] Workflow 與 production build 測試：確認所有 Node.js／供應商呼叫仍在 `"use step"` 中，Workflow 可在部署中註冊並執行。
- [ ] 使用專用測試 LINE 帳號完成驗收，確認回答正確引用知識來源、未知問題轉人工、delivery 為 `sent`；不得使用客戶資料或帳號。
- [ ] 交付時記錄 schema migration、模型／向量供應商成本假設、測試結果、`npm test`、`npm run build`、secrets scan 及部署後驗收結果。
