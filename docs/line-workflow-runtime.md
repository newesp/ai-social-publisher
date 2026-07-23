# LINE Workflow 執行說明

此文件提供開發與維運人員排查 LINE 客服 Workflow 的參考，不是一般客服操作手冊。

## 實作限制

- LINE webhook 與對話狀態轉換路由，必須靜態匯入並傳給 `start()` 的 Workflow。以 template string 或其他動態方式匯入，會讓 Workflow SDK 無法在正式部署中註冊該 Workflow。
- Workflow 編排模組不可直接引入 Node.js 專用的資料庫、加密、AI 供應商或 LINE 傳送實作。這些工作必須放在對應 `*-steps.js` 檔案中、由匯出的 `"use step"` 函式執行。
- 傳入 production Workflow 與 step 的資料必須可序列化。需要目前時間時，使用無參數的 clock step，而不是把不可序列化物件傳入 Workflow。

## 執行模型

LINE 訊息會先取得事件與對話的處理權，再合併短時間內的同一對話訊息。Workflow 對 AI 供應商的暫時性錯誤最多嘗試三次；持續失敗時會將對話轉交人工。推播失敗則依可重試狀態等待後重送，並在每段等待期間更新處理權，避免併發執行造成重複傳送。

對話狀態轉換會保留十秒的 Undo 視窗；由另一個 Workflow 在時間到期後提交。切勿直接修改對話或 outbox 資料來跳過此流程。

## 排查方式

1. 先在 Vercel Workflow 執行紀錄中依 request ID、事件或安全錯誤資訊找出失敗的 run／step。
2. `WorkflowNotRegisteredError` 表示 Workflow 註冊或打包回歸，優先檢查靜態匯入與部署產物；它不是 FAQ 檢索或 AI 供應商錯誤。
3. 若資料庫交易已成功、但 LINE 傳送尚未開始，應重試或替換同一個 Workflow 事件；不要建立新的 outbox row 或新的 retry key。
4. 已終態的傳送或已由人工接手的對話，應依安全稽核狀態調查，絕不可強制恢復為自動傳送。
