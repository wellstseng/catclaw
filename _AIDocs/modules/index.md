# modules/index — 進入點

> 檔案：`src/index.ts`

## 職責

程式進入點：載入設定 → 設定 log level → 建立 Discord Client → 登入 → 優雅關閉。

## 啟動順序

```text
1. import { config }            ← 載入 config.json、驗證
2. setLogLevel(config.logLevel) ← 設定 log 層級
3. loadSessions()               ← 從磁碟載入 session 快取
4. createDiscordClient(config)  ← 建立 Client + 綁定事件
5. client.once("ready")         ← 印出上線資訊
6. await client.login()         ← 連線 Discord Gateway
```

## Ready 事件輸出

```
[bridge] Bot 上線：BotName#1234
  DM：啟用
  Guild 設定：2 個
  工具訊息：隱藏
  Claude 工作目錄：/Users/xxx
```

## 優雅關閉

`SIGINT` / `SIGTERM` → `client.destroy()` → `process.exit(0)`

## 全域錯誤捕捉

```typescript
process.on("unhandledRejection", (reason) => {
  log.error("[bridge] unhandledRejection:", reason);
});
```

避免 Node.js 靜默忽略未處理的 Promise rejection。
