# Mode — Per-channel 模式管理

> 對應原始碼：`src/core/mode.ts`
> 更新日期：2026-04-06

## 概觀

Per-channel 模式系統，影響 thinking level、CE 策略、system prompt 額外區段、tool budget。
模式可在 config.modes.presets 自訂，也有 builtin presets。

## 核心函式

| 函式 | 說明 |
|------|------|
| `getChannelMode(channelId)` | 取得當前模式名稱（預設 `"normal"`） |
| `setChannelMode(channelId, modeName)` | 設定模式 |
| `resetChannelMode(channelId)` | 重設為預設 |
| `getDefaultMode()` | 預設模式（config.modes.defaultMode ?? "normal"） |
| `listModes()` | 列出所有可用模式（builtin + config） |
| `resolveMode(modeName)` | 解析 → ModePreset（config 覆寫 builtin） |
| `getChannelModePreset(channelId)` | 取得 channel 解析後的 ModePreset |
| `getModeThinking(preset)` | 取得 thinking level |

## ModePreset 介面

定義在 `src/core/config.ts`：

```ts
interface ModePreset {
  thinking?: ThinkingLevel;  // "none" | "low" | "medium" | "high"
  ceStrategy?: string;
  systemPromptExtra?: string;
  toolBudget?: number;
}
```

## 解析優先順序

config preset > builtin preset。若兩者同名，config 的欄位覆寫 builtin。

## 儲存

In-memory `Map<channelId, modeName>`。不持久化，重啟後回到預設。
`/mode` skill 負責使用者互動（見 skills.md）。
