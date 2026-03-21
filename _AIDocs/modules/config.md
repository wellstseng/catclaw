# modules/config — JSON 設定載入

> 檔案：`src/config.ts`

## 職責

從 `config.json` 載入設定，提供 per-channel 存取 helper + config hot-reload。

## 設定來源

`config.json`（根目錄，已加入 `.gitignore`）
範本：`config.example.json`

## 型別

### `BridgeConfig`（巢狀結構）

| 欄位 | 型別 | 預設值 | 說明 |
|------|------|--------|------|
| `discord.token` | `string` | *(必填)* | Discord Bot Token |
| `discord.dm.enabled` | `boolean` | `true` | 是否啟用 DM |
| `discord.guilds` | `Record<string, GuildConfig>` | `{}` | per-guild/channel 設定 |
| `claude.cwd` | `string` | `$HOME` | Claude CLI spawn cwd |
| `claude.command` | `string` | `"claude"` | CLI binary 路徑 |
| `claude.turnTimeoutMs` | `number` | `300000` | 回應超時（5 分鐘） |
| `claude.sessionTtlHours` | `number` | `168` | Session 閒置超時（7 天） |
| `showToolCalls` | `"all" \| "summary" \| "none"` | `"summary"` | 工具呼叫顯示模式 |
| `showThinking` | `boolean` | `false` | 是否顯示 Claude 推理過程 |
| `debounceMs` | `number` | `500` | 訊息合併等待 |
| `fileUploadThreshold` | `number` | `4000` | 回覆超過此字數上傳為 .md |
| `logLevel` | `LogLevel` | `"info"` | Log 層級 |
| `cron.enabled` | `boolean` | `false` | 是否啟用排程服務 |
| `cron.maxConcurrentRuns` | `number` | `1` | 同時執行的排程 job 上限 |

> NOTE: 排程 job 定義不在 config.json，在 `data/cron-jobs.json`（參考 `cron-jobs.example.json`）。

### Cron 共用型別（config.ts export）

| 型別 | 說明 |
|------|------|
| `CronSchedule` | `{ kind: "cron" \| "every" \| "at", ... }` 排程時間 |
| `CronAction` | `{ type: "message" \| "claude", channelId, ... }` 執行動作 |

### Per-Channel 結構

```json
{
  "guilds": {
    "<guildId>": {
      "allow": true,
      "allowBot": false,
      "allowFrom": [],
      "channels": {
        "<channelId>": {
          "allow": true,
          "requireMention": false
        }
      }
    }
  }
}
```

| 欄位 | 預設 | 說明 |
|------|------|------|
| `allow` | — | 是否允許回應此頻道 |
| `requireMention` | `true` | 是否需 @mention bot |
| `allowBot` | `false` | 是否回應其他 bot |
| `allowFrom` | `[]` | 白名單（空 = 不限） |

### 存取規則

| 情境 | 行為 |
|------|------|
| DM | 看 `dm.enabled`，不需 mention |
| `guilds` 為空物件 | 所有頻道允許，requireMention 預設 true |
| `guilds` 有設定 | 只允許明確 `allow: true` 的頻道 |
| 頻道未列出 | 不允許 |
| `allowBot=true` + `allowFrom` 有設定 | 需同時通過白名單檢查 |

## Hot-Reload

`watchConfig()` 用 `fs.watch()` 監聽 config.json（500ms debounce）。
token 變更只警告（需重啟），其他設定即時生效。

## API

### `getChannelAccess(guildId, channelId): ChannelAccess`

```typescript
interface ChannelAccess {
  allowed: boolean;
  requireMention: boolean;
}
```

### `config: BridgeConfig`

全域可替換物件（`let` 而非 `const`），hot-reload 時整個替換。

### `watchConfig()`

啟動 config.json 監聽，變動時自動重載。
