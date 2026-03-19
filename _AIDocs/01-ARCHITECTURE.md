# 01 — 架構概覽

> 最近更新：2026-03-19

## 專案目標

專案知識代理人 — 輕量 Discord bot，透過 Claude Code CLI 提供專案知識問答。

- Persistent session per channel（`--resume` 延續 + 磁碟持久化）
- 多人並行（不同 channel 並行，同 channel 串行）
- DM 直接觸發（無需 mention）
- 串流回覆（`--include-partial-messages`）
- Typing indicator + Turn timeout
- Session TTL（預設 7 天，可調）+ resume 失敗自動重試

## 依賴

| 套件 | 用途 |
|------|------|
| `discord.js` ^14 | Discord Gateway 連線、訊息收發 |
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
    │  bot filter → getChannelAccess() → requireMention → strip mention
    │  → 下載附件 → 加 displayName 前綴
    ▼
debounce(channelId:authorId, 500ms)
    │  多則訊息 \n 合併
    ▼
[reply.ts] createReplyHandler(message)
    │  建立 event handler + 啟動 typing
    ▼
[session.ts] enqueue(channelId, text, onEvent)
    │  TTL 檢查 → per-channel Promise chain + AbortController timeout
    │  session_init → 記錄 + 持久化到 data/sessions.json
    ▼
[acp.ts] runClaudeTurn(sessionId, text)
    │  spawn claude -p stream-json → diff 累積文字 → yield delta
    ▼
[reply.ts] onEvent → buffer → 2000字分段 → Discord 送出
```

## 專案結構

```
catclaw/
├── src/
│   ├── index.ts        進入點：設定 logLevel + loadSessions + Discord login
│   ├── config.ts       config.json 載入 + per-channel helper
│   ├── logger.ts       Log level 控制
│   ├── discord.ts      Discord client + debounce + per-channel 過濾
│   ├── session.ts      Session 快取 + 磁碟持久化 + TTL + per-channel queue
│   ├── acp.ts          Claude CLI spawn + 串流 diff + event 解析
│   └── reply.ts        Discord 回覆分段 + code fence 平衡 + typing
├── data/               執行期資料（gitignore）
│   └── sessions.json   channelId → sessionId 映射
├── _AIDocs/            知識庫
│   └── modules/        各模組詳細文件
├── config.example.json 設定範本（token + per-channel）
├── package.json
└── tsconfig.json
```

## Session 策略

| 場景 | Session Key | 行為 |
|------|------------|------|
| Guild 頻道 | `channelId` → UUID | 同頻道所有人共享對話（專案知識共享） |
| DM | `channelId`（每人唯一） | per-user session |

- 首次 → claude CLI 建立 session → `system/init` 取得 UUID → 快取 + 持久化
- 後續 → `--resume <UUID>` 延續
- 超過 TTL（預設 168h = 7 天）→ 開新 session
- resume 失敗 → 清除 session → 不帶 `--resume` 重試
- 重啟時 → `loadSessions()` 從 `data/sessions.json` 載入

## Log 控制

| 層級 | 內容 |
|------|------|
| info（預設） | session 載入/建立、bot 上線、錯誤 |
| debug | session 決策、event 流、過濾判斷 |
| ACP_TRACE=1 | acp stdout/stderr raw chunks（環境變數獨立控制） |
