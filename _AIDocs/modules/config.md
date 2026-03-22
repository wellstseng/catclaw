# modules/config — JSON 設定載入

> 檔案：`src/config.ts`

## 職責

從 `catclaw.json` 載入設定，提供 per-channel 存取 helper + config hot-reload。
提供環境變數路徑解析（`resolveWorkspaceDir` / `resolveClaudeBin`）。
export 所有型別定義（包括 cron.ts 使用的 `CronSchedule` / `CronAction`）。

## 設定來源

- `catclaw.json`（位於 `$CATCLAW_CONFIG_DIR` 目錄，預設 `~/.catclaw/`）
- 範本：`config.example.json`（專案根目錄）
- 格式：JSONC（支援 `//` 整行 + 行尾註解，strip 後 JSON.parse）
- 路徑相關設定已從 config.json 移除，改由環境變數控制

## 型別定義

### `BridgeConfig`（完整欄位）

| 欄位 | 型別 | 預設值 | 必填 | 說明 |
|------|------|--------|------|------|
| `discord.token` | `string` | — | ✓ | Discord Bot Token |
| `discord.dm.enabled` | `boolean` | `true` | — | 是否啟用 DM 回應 |
| `discord.guilds` | `Record<string, GuildConfig>` | `{}` | — | per-guild 設定，空物件=全部允許 |
| `turnTimeoutMs` | `number` | `300000` | — | 回應超時毫秒（5 分鐘），頂層欄位 |
| `sessionTtlHours` | `number` | `168` | — | Session 閒置超時（7 天），頂層欄位 |
| `showToolCalls` | `"all" \| "summary" \| "none"` | `"all"` | — | 工具呼叫顯示模式 |
| `showThinking` | `boolean` | `false` | — | 是否顯示 Claude 推理過程 |
| `debounceMs` | `number` | `500` | — | 訊息合併等待毫秒 |
| `fileUploadThreshold` | `number` | `4000` | — | 超過此字數上傳 .md，0=停用 |
| `logLevel` | `LogLevel` | `"info"` | — | Log 層級 |
| `cron.enabled` | `boolean` | `false` | — | 是否啟用排程服務 |
| `cron.maxConcurrentRuns` | `number` | `1` | — | 同時執行的排程 job 上限 |

> **重構變更**：`claude.cwd` / `claude.command` 已移除，改由環境變數控制。`turnTimeoutMs` / `sessionTtlHours` 從 `claude.*` 提升至頂層。

> `showToolCalls` 舊版支援 boolean：`true` → `"all"`，`false` → `"none"`。

> NOTE: 排程 job 定義不在 catclaw.json，在 `data/cron-jobs.json`（參考 `cron-jobs.example.json`）。

### `GuildConfig` / `ChannelConfig`

```typescript
interface ChannelConfig {
  allow?: boolean;           // 是否允許回應此頻道
  requireMention?: boolean;  // 是否需要 @mention bot 才觸發
  allowBot?: boolean;        // 是否允許處理 bot 訊息
  allowFrom?: string[];      // 白名單 user/bot ID（空陣列 = 不限制）
}

interface GuildConfig {
  allow?: boolean;           // Guild 預設：是否允許，預設 false
  requireMention?: boolean;  // Guild 預設：是否需要 @mention，預設 true
  allowBot?: boolean;        // Guild 預設：是否處理 bot，預設 false
  allowFrom?: string[];      // Guild 預設：白名單，預設 []
  channels?: Record<string, ChannelConfig>;  // per-channel 覆寫
}
```

### Cron 共用型別（供 `cron.ts` 使用）

```typescript
export type CronSchedule =
  | { kind: "cron"; expr: string; tz?: string }   // cron 表達式（如 "0 9 * * *"）
  | { kind: "every"; everyMs: number }              // 固定間隔（毫秒）
  | { kind: "at"; at: string };                     // 一次性 ISO 8601 時間

export type CronAction =
  | { type: "message"; channelId: string; text: string }    // 直接發訊息
  | { type: "claude"; channelId: string; prompt: string };  // 跑 Claude turn

export interface CronConfig {
  enabled: boolean;
  maxConcurrentRuns: number;
}
```

### `RawConfig`（內部型別，不對外 export）

config.json 原始 JSON 結構，所有欄位皆為 optional。`loadConfig()` 解析後填入預設值，轉為完整 `BridgeConfig`。

### `ChannelAccess`（`getChannelAccess` 回傳值）

```typescript
export interface ChannelAccess {
  allowed: boolean;          // 是否允許回應
  requireMention: boolean;   // 是否需要 @mention bot
  allowBot: boolean;         // 是否允許處理 bot 訊息
  allowFrom: string[];       // 白名單（空陣列 = 不限制）
}
```

## Per-Channel 繼承鏈

```
Thread → channels[threadId] → channels[parentId] → Guild 預設
```

各欄位用 `??` 逐層 fallback，只有 `undefined` 才往下找（顯式設 `false` 不 fallback）。

### 存取規則四種情境

| 情境 | allowed | requireMention |
|------|---------|----------------|
| DM（guildId=null） | `dm.enabled` | 永遠 `false` |
| `guilds` 為空物件 `{}` | `true` | `true` |
| `guildId` 找不到 | `false` | `true` |
| 找到 guild → 繼承鏈查找 | 逐層 fallback | 逐層 fallback |

DM：永遠 `allowBot = false`（硬擋 bot 互敲）。

## 主要函式

### `resolveConfigPath(): string`（私有）

讀取 `CATCLAW_CONFIG_DIR` 環境變數，回傳 `catclaw.json` 完整路徑。未設定時 throw 錯誤（不猜預設值）。

### `resolveWorkspaceDir(): string`（public export）

讀取 `CATCLAW_WORKSPACE` 環境變數，回傳 Claude CLI agent 工作目錄。未設定時 throw 錯誤。
用途：acp.ts spawn cwd、session.ts 磁碟持久化路徑。

### `resolveClaudeBin(): string`（public export）

讀取 `CATCLAW_CLAUDE_BIN` 環境變數，回傳 claude binary 路徑。未設定時回傳 `"claude"`（依賴 PATH）。

### `loadConfig(): BridgeConfig`（私有）

1. `resolveConfigPath()` 取得 catclaw.json 路徑
2. Strip `//` JSONC 註解：`text.replace(/\/\/.*$/gm, "")`
3. `JSON.parse`
4. 驗證 `discord.token` 必填（缺少時拋出錯誤）
5. 正規化 guilds：填入預設值
6. 驗證 logLevel（不合法 → 回退 `"info"`）
7. 回傳完整 `BridgeConfig`（`turnTimeoutMs` / `sessionTtlHours` 在頂層）

### `parseShowToolCalls(value): "all" | "summary" | "none"`（私有）

相容舊格式：`true → "all"`，`false → "none"`，字串直接 pass-through（不合法回退 `"all"`）。

### `reloadConfig(): void`（私有）

- 呼叫 `loadConfig()` 建立新設定
- token 變更時只 `log.warn`，不阻止替換（但 Gateway 連線需重啟才更新）
- 替換全域 `config`（`let` 宣告）
- 同步更新 `setLogLevel(config.logLevel)`
- parse 失敗 → 維持舊設定，`log.warn`

## Hot-Reload

```
watchConfig()
  → fs.watch(catclaw.json)
  → 500ms debounce
  → reloadConfig()
      ├─ token 變更 → log.warn（需重啟，不套用）
      └─ 其他設定 → config = newConfig + setLogLevel
```

parse 失敗 → `log.warn` 維持舊設定，不 crash。

## 對外 API

### `getChannelAccess(guildId, channelId, parentId?): ChannelAccess`

查詢指定頻道的存取設定（含繼承鏈）。

```typescript
export function getChannelAccess(
  guildId: string | null,   // DM 時為 null
  channelId: string,        // Channel 或 Thread ID
  parentId?: string | null  // Thread 的父頻道 ID（非 Thread 時 null）
): ChannelAccess
```

### `export let config: BridgeConfig`

全域可替換物件（`let` 而非 `const`），hot-reload 時整個替換。

### `watchConfig(): void`

啟動 config.json 監聯，變動時自動重載（500ms debounce）。

## 完整 Export 列表

```typescript
export let config: BridgeConfig;
export function watchConfig(): void;
export function getChannelAccess(...): ChannelAccess;
export function resolveWorkspaceDir(): string;   // 環境變數 CATCLAW_WORKSPACE
export function resolveClaudeBin(): string;       // 環境變數 CATCLAW_CLAUDE_BIN
export interface ChannelConfig;
export interface GuildConfig;
export interface DmConfig;
export interface DiscordConfig;
export interface BridgeConfig;    // 不再包含 ClaudeConfig（已移除）
export interface ChannelAccess;
export type CronSchedule;
export type CronAction;
export interface CronConfig;
```

## 注意事項

- `config` 是 `let`（非 `const`），hot-reload 會整體替換物件引用
- discord.ts 不在 closure 中捕獲 config，每次 messageCreate 讀全域 `config`，確保 hot-reload 生效
- token 變更警告但無法阻止，重啟才能套用新 token
- `claude.cwd` / `claude.command` 已移除，路徑相關設定由環境變數控制
- 環境變數未設定時 `resolveConfigPath()` / `resolveWorkspaceDir()` 直接 throw，不猜預設值
