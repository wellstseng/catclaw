# modules/config — JSON 設定載入

> 檔案：`src/config.ts`

## 職責

從 `config.json` 載入設定，提供 per-channel 存取 helper。
結構參考 OpenClaw 的 channel 設定模式。

## 設定來源

`config.json`（根目錄，已加入 `.gitignore`）
範本：`config.example.json`

## 型別

### `BridgeConfig`

| 欄位 | 型別 | 預設值 | 說明 |
|------|------|--------|------|
| `token` | `string` | *(必填)* | Discord Bot Token |
| `showToolCalls` | `boolean` | `true` | 是否顯示 🔧 工具訊息 |
| `dm` | `DmConfig` | `{ enabled: true }` | DM 設定 |
| `guilds` | `Record<string, GuildConfig>` | `{}` | per-guild/channel 設定 |
| `claudeCwd` | `string` | `$HOME` | Claude CLI spawn cwd |
| `claudeCommand` | `string` | `"claude"` | CLI binary 路徑 |
| `debounceMs` | `number` | `500` | 訊息合併等待 |
| `turnTimeoutMs` | `number` | `300000` | 回應超時（5 分鐘） |
| `logLevel` | `LogLevel` | `"info"` | Log 層級 |

### Per-Channel 結構

```json
{
  "guilds": {
    "<guildId>": {
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

### 存取規則

| 情境 | 行為 |
|------|------|
| DM | 看 `dm.enabled`，不需 mention |
| `guilds` 為空物件 | 所有頻道允許，requireMention 預設 true |
| `guilds` 有設定 | 只允許明確 `allow: true` 的頻道 |
| 頻道未列出 | 不允許 |

## API

### `getChannelAccess(guildId, channelId): ChannelAccess`

```typescript
interface ChannelAccess {
  allowed: boolean;
  requireMention: boolean;
}
```

供 `discord.ts` 在訊息過濾時呼叫。

### `config: BridgeConfig`

全域單例，啟動時載入一次。
