# modules/index — 進入點

> 檔案：`src/index.ts`

## 職責

程式進入點：載入環境變數 → 建立 Discord Client → 登入 → 優雅關閉。

## 啟動順序

```
1. import "dotenv/config"    ← 載入 .env 到 process.env
2. import { config }          ← 讀取環境變數、驗證
3. createDiscordClient(config) ← 建立 Client + 綁定事件
4. client.once("ready")       ← 印出上線資訊
5. await client.login()       ← 連線 Discord Gateway
```

> **陷阱**：`import "dotenv/config"` 必須在 `import { config }` **之前**，否則 `process.env` 尚未填充。

## Ready 事件輸出

```
[discord-claude-bridge] Bot 上線：BotName#1234
  觸發模式：mention
  允許頻道：全部
  Claude 工作目錄：/Users/xxx
```

## 優雅關閉

`SIGINT` / `SIGTERM` → `client.destroy()` → `process.exit(0)`

## 全域錯誤捕捉

```typescript
process.on("unhandledRejection", (reason) => {
  console.error("[discord-claude-bridge] unhandledRejection:", reason);
});
```

避免 Node.js 靜默忽略未處理的 Promise rejection。
