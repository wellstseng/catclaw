# modules/discord — Discord Client + 訊息處理

> 檔案：`src/discord.ts`

## 職責

建立 Discord Client，處理 `messageCreate` 事件：bot 過濾 → 白名單 → 觸發模式判斷 → debounce 合併 → 觸發 session + reply。

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
  ├─ 非 DM + 不在白名單 → 忽略
  ├─ mention 模式 + 未 mention bot → 忽略
  ├─ strip mention → 文字為空 → 忽略
  └─ 通過 → debounce → enqueue
```

### 觸發模式

| 模式 | Guild | DM |
|------|-------|----|
| `mention` | 需 @mention bot | 永遠觸發 |
| `all` | 白名單頻道所有訊息 | 永遠觸發 |

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

## 對外 API

### `createDiscordClient(config): Client`

建立已綁定 `messageCreate` handler 的 Client（尚未 `login`）。
