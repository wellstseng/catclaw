# 01 — 架構概覽

> 最近更新：2026-03-19

## 專案目標

輕量獨立的 Discord bot，直接透過 Claude Code CLI 進行對話。

- Persistent session per channel（`--resume` 延續）
- 多人並行（不同 channel 並行，同 channel 串行）
- DM 直接觸發（無需 mention）
- 串流回覆（`--include-partial-messages`）
- Typing indicator + Turn timeout

## 依賴

| 套件 | 用途 |
|------|------|
| `discord.js` ^14 | Discord Gateway 連線、訊息收發 |
| `dotenv` ^17 | .env 環境變數載入 |
| `typescript` ^5 | 編譯 |
| `@types/node` ^22 | Node.js 型別 |
| `claude` (PATH) | Claude Code CLI，外部安裝 |

套件管理：**pnpm**

## 資料流

```
Discord 訊息
    │
    ▼
[discord.ts] onMessageCreate()
    │  bot filter → 白名單 → 觸發模式 → strip mention
    ▼
debounce(channelId:authorId, 500ms)
    │  多則訊息 \n 合併
    ▼
[reply.ts] createReplyHandler(message)
    │  建立 event handler + 啟動 typing
    ▼
[session.ts] enqueue(channelId, text, onEvent)
    │  per-channel Promise chain + AbortController timeout
    ▼
[acp.ts] runClaudeTurn(sessionId, text)
    │  spawn claude -p stream-json → diff 累積文字 → yield delta
    ▼
[reply.ts] onEvent → buffer → 2000字分段 → Discord 送出
```

## 專案結構

```
claude_discord/
├── src/
│   ├── index.ts        進入點：dotenv + Discord login
│   ├── config.ts       環境變數讀取與驗證
│   ├── discord.ts      Discord client + debounce + 觸發模式
│   ├── session.ts      Session 快取 + per-channel queue + timeout
│   ├── acp.ts          Claude CLI spawn + 串流 diff + event 解析
│   └── reply.ts        Discord 回覆分段 + code fence 平衡 + typing
├── _AIDocs/            知識庫
│   └── modules/        各模組詳細文件
├── .env.example        環境變數範本
├── package.json
└── tsconfig.json
```

## Session 策略

| 場景 | Session Key | 行為 |
|------|------------|------|
| Guild 頻道 | `channelId` → UUID | 同頻道所有人共享對話 |
| DM | `channelId`（每人唯一） | per-user session |

首次 → claude CLI 建立 session → `system/init` 取得 UUID → 快取。
後續 → `--resume <UUID>` 延續。
