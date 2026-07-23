# 平台連線資料庫遷移手冊

此程序僅供維運人員執行。`npm run migrate:platform-connections` 會套用 `drizzle/` 中所有尚未執行的 migration、驗證平台連線 schema，然後移除舊版共用平台憑證並終止未綁定連線的風險貼文目標。

## 維護窗口前

1. 停止舊版應用程式的 worker、cron 與排程器，避免舊程式碼在遷移期間寫入資料。
2. 建立並獨立驗證可還原的 Turso/libSQL 資料庫備份；在變更紀錄中記下備份識別碼與時間。
3. 僅在操作程序中設定 `TURSO_DATABASE_URL`、`TURSO_AUTH_TOKEN` 與 `SETTINGS_ENCRYPTION_KEY`，切勿輸出或記錄其值。
4. 確認備份可還原後，再設定 `PLATFORM_MIGRATION_BACKUP_CONFIRMED=YES`。此變數只是人工確認，不會建立備份。

## 套用與驗證

```powershell
$env:PLATFORM_MIGRATION_BACKUP_CONFIRMED = "YES"
npm run migrate:platform-connections
```

命令會先執行 schema migration，確認平台連線 renewal lease 欄位、每位使用者／平台僅一個有效連線的索引與資料一致性，接著清除舊版憑證。請記錄輸出的清理設定與失敗貼文目標數量；若數量不符預期，先調查再部署。

若需診斷，可依序執行 `npm run migrate:platform-schema` 與 `npm run cleanup:legacy-platform-credentials`。後者還需要 `SETTINGS_ENCRYPTION_KEY`；不得反轉順序，也不得跳過備份確認。

## 部署與驗收

1. 僅在 migration 與清理驗證成功後部署新版應用程式。
2. 在新版啟動後恢復 worker 與 cron。
3. 以專用測試帳號驗證 Meta 頁面選取、LINE 連線、立即發布、排程發布、取消排程與中斷連線保護。不要使用客戶帳號。

## 失敗與復原

- schema 套用或驗證失敗時，維持 worker 停止，且不要執行清理。請先在還原副本上診斷。
- 清理失敗時，其交易會回滾；保留不含密鑰的錯誤紀錄、修正原因後，再重新執行完整程序。
- 必須復原時，還原已驗證的備份、確認資料已回到遷移前狀態，部署前一版應用程式後才恢復 worker。
- 不得手動修改加密設定、lease 欄位或平台連線狀態。
