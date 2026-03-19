# modules/config — 環境變數與設定

> 檔案：`src/config.ts`

## 職責

從 `process.env` 讀取所有環境變數，進行型別轉換與驗證，export 單一 `BridgeConfig` 物件。
缺少必填欄位時直接拋出錯誤，讓問題在啟動時立即浮現。

## 型別

### `TriggerMode`

```typescript
type TriggerMode = "mention" | "all";
```

### `BridgeConfig`

| 欄位 | 型別 | 環境變數 | 預設值 | 說明 |
|------|------|---------|--------|------|
| `discordToken` | `string` | `DISCORD_BOT_TOKEN` | *(必填)* | Discord Bot Token |
| `triggerMode` | `TriggerMode` | `TRIGGER_MODE` | `"mention"` | 訊息觸發模式 |
| `allowedChannelIds` | `Set<string>` | `ALLOWED_CHANNEL_IDS` | 空集合（全部允許） | 白名單頻道 ID |
| `claudeCwd` | `string` | `CLAUDE_CWD` | `$HOME` | Claude CLI spawn 的 cwd |
| `claudeCommand` | `string` | `CLAUDE_COMMAND` | `"claude"` | CLI binary 路徑 |
| `debounceMs` | `number` | `DEBOUNCE_MS` | `500` | 同一人連續訊息合併等待 |
| `turnTimeoutMs` | `number` | `TURN_TIMEOUT_MS` | `300000` | 回應超時（5 分鐘） |

## 驗證邏輯

1. `DISCORD_BOT_TOKEN` 未設定 → `throw Error`
2. `TRIGGER_MODE` 非 `"mention"` / `"all"` → `throw Error`
3. `ALLOWED_CHANNEL_IDS` → 逗號分隔，trim + filter 空字串
4. 數值欄位（`DEBOUNCE_MS`、`TURN_TIMEOUT_MS`）：`parseInt` → `isNaN` fallback 預設值

## Export

```typescript
export const config: BridgeConfig = loadConfig(); // 全域單例
```

啟動時載入一次，後續其他模組直接 import 使用。
