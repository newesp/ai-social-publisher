# LINE AI 客服維運手冊

本手冊適用於已部署的 LINE AI 客服。請使用專用測試 LINE Official Account 驗收；不要以客戶帳號、真實客戶對話或正式憑證進行測試。

## 啟用前準備

1. 確認部署環境已設定 `AUTH_MODE`、`SETTINGS_ENCRYPTION_KEY`、`TURSO_DATABASE_URL`、`TURSO_AUTH_TOKEN`、Vercel Blob 憑證與 `CRON_SECRET`。AI 供應商金鑰和 LINE 憑證由登入使用者在系統設定中管理，切勿貼入 issue、日誌或聊天訊息。
2. 在「設定」的「發布平台」分頁連結 LINE Messaging API Channel；連線狀態顯示為「已連線」後再繼續。
3. 在 LINE Developers Console 的 Messaging API 設定中啟用 **Use webhook** 與 **Webhook redelivery**。
4. 在 LINE Official Account Manager 的回應設定中停用 **Greeting messages** 與 **Auto-reply messages**，並啟用 Webhook。原生自動回覆和本系統同時啟用會導致客戶收到重複訊息。

## 設定與啟用 AI 客服

1. 前往「設定」的「客服」分頁，填入品牌名稱、客服名稱、語氣、AI 供應商與模型，然後儲存。
2. 在「FAQ 知識庫」新增至少一則 FAQ 並啟用。AI 只會依已啟用的 FAQ 回答；沒有足夠資料時，系統會轉交人工處理。
3. 在「LINE 就緒狀態」勾選已啟用 Webhook redelivery，以及已停用 LINE 原生歡迎與自動回覆。
4. 點選「檢查 LINE 就緒狀態」。系統會驗證 LINE 連線、Webhook、AI 設定與 FAQ；未通過的項目必須先修正。
5. 點選「測試 AI 供應商」。這會發出一次實際的 AI 請求，可能產生供應商用量。
6. 全部檢查通過後，點選「啟用 AI 客服」。顯示「已啟用」才會處理新的 LINE 客戶訊息。

## 日常操作

- 在「客服」收件匣查看對話與 AI 判斷結果。由人工接手時，使用 **Take over**；人工訊息會以 LINE Push Message 傳送。
- 需要恢復自動回覆時，將對話交回 AI；問題已結束時標記為結案。狀態變更提供短暫的 Undo 視窗，應在送出前確認對話與狀態。
- LINE Official Account Manager 內人工回覆的內容不會同步回本系統；請在本系統收件匣處理需留存的人工對話。
- 發送失敗時，先確認 LINE 連線狀態，再使用收件匣中的重試功能。請勿手動寫入資料庫或重用 Reply Token。

## 常見狀況

| 狀況 | 處理方式 |
| --- | --- |
| LINE 顯示需要重新連線 | 在「設定」重新連結 LINE，重新執行就緒檢查後再啟用客服。 |
| AI 客服無法啟用 | 逐項檢查 LINE 連線、AI 供應商與模型、至少一則已啟用 FAQ、Webhook 驗證及兩項 LINE Console 確認。 |
| 客戶未收到回覆 | 查看收件匣是否已轉人工、LINE 連線是否有效，以及對應訊息的安全錯誤狀態；不要在日誌中記錄客戶訊息或憑證。 |
| Workflow 執行失敗 | 在 Vercel 的 Workflow 執行紀錄依 request ID 或安全錯誤資訊排查；詳見 [Workflow 執行說明](line-workflow-runtime.md)。 |

## 資料保留與排程

Vercel Cron 每天於 01:30 UTC 呼叫 `GET /api/cron/support-retention`。端點必須提供完全相符的 `Authorization: Bearer <CRON_SECRET>`。

清理工作會分批移除超過 30 天的訊息文字、已過期的 LINE Reply Token 密文，以及已進入終態的推播內容；保留傳送狀態、時間戳與安全錯誤碼等非內容稽核資料。可重試的推播內容會保留到進入終態，避免破壞重試流程。

排程失敗時，確認 cron secret、部署路由與資料庫可用性。不要使用手動 SQL 匯出、回填或修改受保護的訊息內容。

## Schema migration

在正式環境套用客服 migration 前，先停止舊版 worker 與 cron、建立並驗證可還原的資料庫備份，再只為核准的執行階段設定 `SUPPORT_MIGRATION_BACKUP_CONFIRMED=YES`，並執行 `npm run migrate:support-schema`。此變數只是確認備份已完成，並不會建立備份。migration 失敗時，保持 worker 停止並依已驗證的備份進行復原；不要以手動 SQL 修補客服資料。
