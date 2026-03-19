# modules/discord — Discord Client + 訊息處理

> 檔案：`src/discord.ts`

## 職責

建立 Discord Client，處理 `messageCreate` 事件：bot 過濾 → `getChannelAccess()` 查詢 per-channel 設定 → debounce 合併 → 觸發 session + reply。

## Client 設定

```typescript
intents: [Guilds, GuildMessages, MessageContent, DirectMessages]
partials: [Partials.Channel]
```

> **陷阱**：DM 必須加 `Partials.Channel`，否則 discord.js 不會觸發 DM 的 `messageCreate`。

## 訊息過濾流程

```
messageCreate
  ├─ bot 自身 → 忽略
  ├─ getChannelAccess(guildId, channelId)
  │   ├─ allowed = false → 忽略
  │   └─ requireMention = true + 未 mention → 忽略
  ├─ strip mention → 文字為空 → 忽略
  └─ 通過 → 下載附件 → debounce → 加 displayName 前綴 → enqueue
```

### Per-Channel 設定

透過 `config.ts` 的 `getChannelAccess()` 查詢：

| 情境 | allowed | requireMention |
|------|---------|---------------|
| DM | `dm.enabled` | `false` |
| guilds 空 | `true` | `true` |
| 頻道有設定 | `channel.allow` | `channel.requireMention ?? true` |
| 頻道未列出 | `false` | — |

Mention strip：`content.replace(/<@!?\d+>/g, "").trim()`

## Debounce

同一人在 `debounceMs`（預設 500ms）內的多則訊息合併為一則。

**Key**：`channelId:authorId`

**三個 Map**：

| Map | Key | Value |
|-----|-----|-------|
| `debounceTimers` | key | `setTimeout` handle |
| `debounceBuffers` | key | `string[]`（累積行） |
| `debounceMessages` | key | 第一則 `Message`（用於 reply） |

**流程**：

1. 收到訊息 → 清除上一個 timer → 累積文字 → 記錄第一則 message
2. timer 到期 → `lines.join("\n")` → `onFire(combinedText, firstMessage)`
3. 清理三個 Map

## 訊息去重

`processedMessages` Set 追蹤已處理的 message ID，防止 DM partial channel 導致重複觸發。超過 1000 筆時整批清除。

## 附件下載

`downloadAttachments(message)` 將 Discord 訊息附件（圖片、檔案等）下載至暫存目錄：

- 路徑：`/tmp/claude-discord-uploads/{messageId}/{fileName}`
- 下載後路徑嵌入 prompt：`[使用者附件，請用 Read 工具讀取]\n- /path`
- 讓 Claude CLI 可透過 Read 工具存取使用者上傳的檔案

## 使用者識別

多人頻道中，prompt 前綴 `displayName:`，讓 Claude 分辨發言者：

```text
Wells: 這個 API 怎麼用？
```

## 對外 API

### `createDiscordClient(config): Client`

建立已綁定 `messageCreate` handler 的 Client（尚未 `login`）。
