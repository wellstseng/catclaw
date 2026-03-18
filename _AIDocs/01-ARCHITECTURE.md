# 01 — discord-claude-bridge 架構設計

> 建立日期：2026-03-18

---

## 專案目標

將 OpenClaw 的 Discord 訊息處理邏輯剝離，建立一個輕量獨立的 Discord bot，
直接透過 ACP protocol 串接 Claude CLI（claude-agent-acp），支援：

- Persistent session per channel（頻道級對話記憶）
- 多人並行（不同 channel 完全並行，同 channel 串行）
- 常駐互動（session 重啟後可 resume）
- DM 直接觸發（無需 mention）

---

## 依賴

| 套件 | 用途 |
|------|------|
| `discord.js` ^14 | Discord Gateway 連線、訊息收發 |
| `typescript` ^5 | 編譯 |
| `@types/node` ^22 | Node.js 型別 |
| `acpx` (PATH) | Claude ACP runtime，外部安裝，不在 package.json |

---

## 整體資料流

```
Discord 訊息
    │
    ▼
[discord.ts] onMessageCreate()
    │  1. 忽略 bot 自身訊息
    │  2. TRIGGER_MODE 檢查（mention / all）
    │     DM 永遠觸發，無視 TRIGGER_MODE
    │  3. ALLOWED_CHANNEL_IDS 白名單過濾
    │  4. strip mention prefix
    │
    ▼
debounce(channelId:authorId, DEBOUNCE_MS)
    │  同一人 500ms 內多則訊息 → 合併成一則（\n 連接）
    │
    ▼
[session.ts] enqueue(channelId, text, onEvent)
    │  per-channel Promise chain（serialize 同 channel turns）
    │  不同 channel → 完全並行
    │
    ▼
[session.ts] ensureSession(channelId)
    │  有快取 sessionName → 直接用
    │  沒有 → 呼叫 acpx sessions ensure --name <channelId>
    │
    ▼
[acp.ts] runTurn(sessionName, text) → AsyncGenerator<AcpEvent>
    │  spawn: acpx --format json --json-strict --cwd <CLAUDE_CWD>
    │         --approve-all prompt --session <name> --file -
    │  stdin: text
    │  stdout: JSON lines → parse events
    │
    ▼
[reply.ts] streamReply(message, events)
    │  text_delta → 累積 buffer
    │  buffer >= 2000 → chunk → Discord send
    │  code fence 跨 chunk 自動平衡
    │  done → flush 剩餘 buffer
    │  error → reply 錯誤訊息
    │
    ▼
Discord 回覆送出
```

---

## 專案結構

```
claude_discord/
├── src/
│   ├── index.ts        進入點：載入 config、啟動 Discord client
│   ├── config.ts       環境變數讀取與驗證
│   ├── discord.ts      Discord client + 訊息事件 + debounce
│   ├── session.ts      ACP session 管理 + per-channel queue
│   ├── acp.ts          ACP protocol 實作（spawn acpx + event 解析）
│   └── reply.ts        Discord 回覆（chunk + code fence 平衡）
├── _AIDocs/            知識庫（本目錄）
├── .env.example        環境變數範本
├── package.json
└── tsconfig.json
```

---

## 模組說明

### config.ts

讀取環境變數，export 單一 `BridgeConfig` 物件。

```typescript
interface BridgeConfig {
  discordToken: string          // DISCORD_BOT_TOKEN（必填）
  triggerMode: "mention" | "all"  // 預設 "mention"
  allowedChannelIds: Set<string>  // 空 = 全部允許
  claudeCwd: string             // 預設 $HOME
  acpxCommand: string           // 預設 "acpx"
  debounceMs: number            // 預設 500
}
```

### acp.ts

直接實作 ACP 協定，不依賴 OpenClaw。兩個核心函式：

**ensureAcpSession(sessionName, cwd, acpxCmd)**
- spawn: `acpx --format json --json-strict --cwd <cwd> sessions ensure --name <name>`
- 收集 stdout → 解析 JSON lines
- 找到含 `agentSessionId` 或 `acpxSessionId` 的行 → 成功
- 找不到 → throw Error

**runAcpTurn(sessionName, text, cwd, acpxCmd, signal?)**
- spawn: `acpx --format json --json-strict --cwd <cwd> --approve-all prompt --session <name> --file -`
- stdin: prompt text
- stdout: JSON lines → yield AcpEvent
- AbortSignal → `acpx cancel --session <name>` → SIGTERM(250ms) → SIGKILL

**AcpEvent 類型：**
| type | 說明 |
|------|------|
| `text_delta` | 輸出文字片段（累積後送 Discord） |
| `tool_call` | Claude 使用工具（顯示 🔧 提示） |
| `done` | turn 完成，flush buffer |
| `error` | 錯誤，回覆錯誤訊息 |
| `status` | 略過（usage update 等） |

### session.ts

管理 session 生命週期與 per-channel 串行佇列。

```
handles: Map<channelId, sessionName>   // session 快取
queues:  Map<channelId, Promise<void>> // per-channel Promise chain tail
```

`enqueue(channelId, text, onEvent)` 確保同 channel turn 串行執行。

### reply.ts

Discord 回覆邏輯：
- 2000 字硬限（Discord API 限制）
- Code fence 平衡：奇數個 ``` → 跨 chunk 自動補開/補關
- 第一段用 `message.reply()`，後續用 `channel.send()`

### discord.ts

discord.js Client 設定：
- Intents: Guilds + GuildMessages + MessageContent + DirectMessages
- Partials: Channel（DM 必要）
- Debounce key: `${channelId}:${authorId}`

---

## 環境變數

| 變數 | 必填 | 預設值 | 說明 |
|------|------|--------|------|
| `DISCORD_BOT_TOKEN` | ✅ | — | Discord bot token |
| `TRIGGER_MODE` | | `mention` | `mention` 或 `all` |
| `ALLOWED_CHANNEL_IDS` | | 空（全部） | 逗號分隔 channel ID |
| `CLAUDE_CWD` | | `$HOME` | Claude session 工作目錄 |
| `ACPX_COMMAND` | | `acpx` | acpx binary 路徑 |
| `DEBOUNCE_MS` | | `500` | debounce 毫秒數 |

---

## ACP CLI 指令參考

（來源：openclaw/extensions/acpx/src/runtime.ts）

```bash
# 確保 session 存在
acpx --format json --json-strict --cwd <cwd> \
     sessions ensure --name <sessionName>

# 執行 turn
acpx --format json --json-strict --cwd <cwd> \
     --approve-all \
     prompt --session <sessionName> --file -

# 取消執行中的 turn
acpx --format json --json-strict --cwd <cwd> \
     cancel --session <sessionName>
```

---

## Session 策略

| 場景 | Session Key | 行為 |
|------|------------|------|
| Guild 頻道 | `channelId` | 同頻道所有人共享一段對話 |
| DM | `channelId`（每人唯一） | 等同 per-user session |

---

## 關鍵常數

| 常數 | 值 | 來源 |
|------|-----|------|
| TEXT_LIMIT | 2000 | Discord API 訊息字數上限 |
| DEBOUNCE_MS | 500 | 多訊息合併等待時間 |
| SIGTERM_GRACE | 250ms | abort 時 SIGTERM → SIGKILL 間隔 |

---

## 已知邊界條件與陷阱

1. **DM 需加 `Partials.Channel`**：discord.js 預設不接收 DM 事件
2. **Bot self-filter 必須在 debounce 前**：避免 bot 回覆訊息佔 debounce 容量
3. **Code fence 跨 chunk 必須平衡**：否則 Discord 渲染亂掉
4. **acpx sessions ensure 可能需要安裝**：首次使用需確認 acpx 在 PATH
5. **同 channel 串行不是 Node.js 限制**：是 ACP session 協定要求（一次一個 turn）
6. **DM trigger 無視 TRIGGER_MODE**：DM 永遠觸發，不需 mention
