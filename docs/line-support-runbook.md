# LINE AI 客服維運手冊

本手冊適用於一對一、文字訊息的 LINE AI 客服 MVP。所有正式驗收都必須使用專用的測試 LINE Official Account 和測試 LINE 使用者；不得用真實客戶帳戶測試。

## 部署前門檻

1. 先在部署目標執行無副作用的 Workflow smoke gate，並在 Vercel Workflow 儀表板確認 run、step 和受控失敗的重試紀錄。未取得這項證據時，不要啟用客服。
2. 確認 runtime 設定：`AUTH_MODE`、`ALLOWED_GOOGLE_EMAILS`（production）、`SETTINGS_ENCRYPTION_KEY`、`TURSO_DATABASE_URL`、`TURSO_AUTH_TOKEN`、Blob 設定，以及 `CRON_SECRET`。AI provider key 和 LINE channel credential 只透過受保護設定介面儲存，絕不貼進文件、log 或 issue。
3. 資料庫 schema 變更必須先停止相關 worker/cron、建立並驗證可還原的 Turso 備份，再設定一次性的 `SUPPORT_MIGRATION_BACKUP_CONFIRMED=YES` 執行 `npm run migrate:support-schema`。若備份、還原演練或授權任一項缺失，停止 migration。

## LINE Console 與就緒狀態

在設定頁連線專用 LINE Official Account，設定品牌/助理/模型，至少建立一筆啟用 FAQ，並承認 redelivery 與停用 LINE 原生自動回覆。再執行「refresh readiness」讓服務建立和驗證 webhook，最後明確啟用客服。

`ready` 只表示下列條件已在本系統檢查完成：LINE connection 已連線且為 active、已設定 AI provider、至少一筆啟用 FAQ、webhook 已驗證、redelivery 已確認、原生回覆已停用。`needs_attention` 表示至少一項未滿足；`state: disabled` 表示不得自動回覆；`state: enabled` 仍不取代 Workflow/LINE 的實際 smoke 證據。

若 connection 變成 `needs_reconnect`，立即在設定頁重新連線該 LINE account，重新檢查 readiness、驗證 webhook、再次執行 provider test，確認所有 check 都回復後才啟用客服。不要嘗試手動修改資料庫狀態。

## 日常操作與事故處理

- 人工處理：在 inbox 先 Take over，才可用 composer 發送 Push 回覆。若訊息顯示 failed，使用相同的 in-app retry 動作；不要在 LINE OA Manager 補發，否則系統不會同步那筆回覆或其狀態。
- Workflow：在 Vercel 檢查 request ID 對應的 run/step、重試和安全錯誤碼。不要將 customer text、reply token、access token、channel secret、未遮罩 LINE ID 或 provider response 複製到 log/工單。
- 用量：在 Vercel 檢查 Workflow、Function、Blob 和資料庫用量；異常時先停用客服，再保留安全的 request ID、時間與錯誤碼進行調查。
- 緊急停用：設定頁將客服切為 disabled，並確認新訊息進入人工處理而非自動回覆。若需停止所有入口，另外在 LINE Console 停用 webhook；恢復前必須再次完成 readiness 與專用測試帳戶 smoke。

## 資料保留與排程

Vercel 每日 01:30 UTC 以 `GET /api/cron/support-retention` 執行清理，且必須提供完全相符的 `Authorization: Bearer <CRON_SECRET>`。每次最多執行十個 100-row batch；回應只包含 `messagesCleared`、`replyTokensCleared` 與 `outboundBodiesCleared`。

清理會分批移除超過 30 天的訊息文字與已完成 delivery 的 canonical Push body，並在 token 到期時立即移除 LINE reply-token 密文；delivery status、時間戳、safe error code 和其他非內容稽核欄位會保留。可重試 delivery 保留 canonical body 直到它進入終態，因此不會破壞 24 小時 retry window。排程錯誤時，確認 cron secret、部署路由與資料庫可用性；不要以手動 SQL 匯出或回填受保護內容。

## 專用帳戶驗收（需另行授權）

在任何 live 動作前，請明確提供：專用測試 LINE Official Account、測試 LINE 使用者、部署 URL、選定 LLM provider/model，以及要送出的精確測試訊息。獲授權後才依序驗證：Workflow dashboard、webhook 設定、一對一 AI 回覆、明確要求人工的 handoff、人工 Push、非文字 handoff、return/resolve/undo、導覽與 refresh 的獨立性、資料庫/運行 log 遮罩，以及 Vercel 用量。

LINE Official Account Manager 的人工回覆不會同步回本系統，不能作為驗收或正式人工回覆介面。
# Final review verification note

The post-0004 support migrations use a manual metadata policy: do not treat `drizzle-kit generate` as authoritative. Before applying any production migration, complete and record the existing verified backup prerequisite, set `SUPPORT_MIGRATION_BACKUP_CONFIRMED=YES` only for the approved run, and use the documented rollback/restore decision. No migration is applied by local automated verification.

## Workflow replay recovery

If a Workflow run fails after its database transaction commits but before LINE
delivery begins, retry or replace the same workflow event; do not insert a new
outbox row or invent a new retry key. Recovery is automatic only while the
exact event and conversation ownership claims are current. A handoff
acknowledgement can be recovered while the conversation is `waiting_human`
only when the persisted event, handoff decision, and outbox all match. A
terminal delivery or explicit human takeover must be investigated from the
safe audit status and must never be forced back into automated delivery.
