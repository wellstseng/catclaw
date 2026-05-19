# modules/session — SessionManager（`src/core/session.ts`）

> Session = 一個頻道/帳號的對話上下文（messages history + provider binding）。
> 全域唯一 session 系統，舊版 `src/session.ts` 已於 2026-04-09 移除。

## 設計要點

- Session key 格式：`{platform}:ch:{channelId}`（群組）或 `{platform}:dm:{accountId}:{channelId}`（DM）
- 持久化：atomic write（先寫 `.tmp` 再 `rename`），含 SHA-256 checksum 驗證
- TTL 清理：啟動時 `cleanExpired()` 掃描，**過期 session 改 rename 到 `_expired/` archive 不直接 unlink**；下次同 sessionKey 對話時 `getOrCreate` 會自動還原
- Archive GC：啟動時 `purgeArchive(30)` 二級清理 `_expired/` 超過 30 天的封存（總保留期 ≈ 7 天 active TTL + 30 天 archive ≈ 37 天）
- Turn Queue：per-session FIFO 佇列，max depth 5，排隊超時自動移出
- 全域單例模式：`initSessionManager()` / `getSessionManager()`

## 型別定義

```typescript
export interface Session {
  sessionKey: string;
  accountId: string;
  channelId: string;
  providerId: string;
  messages: Message[];       // 對話歷史（provider base.ts 的 Message 型別）
  createdAt: number;         // timestamp ms
  lastActiveAt: number;
  turnCount: number;
}

export interface TurnRequest {
  sessionKey: string;
  accountId: string;
  prompt: string;
  signal?: AbortSignal;
  enqueuedAt: number;
  resolve: () => void;
  reject: (err: Error) => void;
}
```

## SessionManager API

| 方法 | 說明 |
|------|------|
| `init()` | 初始化：建立 persistDir、清除過期、載入所有 session |
| `getOrCreate(sessionKey, accountId, channelId, providerId)` | 取得或建立 session |
| `get(sessionKey)` | 取得 session（不存在回傳 undefined） |
| `addMessages(sessionKey, messages)` | 新增訊息（user + assistant），觸發 compact + persist |
| `getHistory(sessionKey)` | 取得對話歷史 `Message[]` |
| `replaceMessages(sessionKey, messages)` | CE 壓縮後寫回精簡版 messages（備份原始至 `_ce_backups/`，保留最近 3 份） |
| `clearMessages(sessionKey)` | 清空訊息（保留 session 殼），回傳被清除數 |
| `delete(sessionKey)` | 刪除 session（記憶體 + 磁碟，**不 archive**），觸發 `session:end` event |
| `purgeExpired()` | 批次處理過期 session（archive 到 `_expired/`），回傳處理數 |
| `purgeArchive(maxAgeDays=30)` | 二級 GC：刪除 `_expired/` 中 mtime 超過 N 天的封存，回傳刪除數 |
| `list()` | 回傳所有 session 陣列 |

## Turn Queue API

| 方法 | 說明 |
|------|------|
| `enqueueTurn(request)` | 排入 turn queue，回傳 Promise（可開始執行時 resolve）。depth >= 5 → reject |
| `dequeueTurn(sessionKey)` | 前一個 turn 完成，讓下一個開始 |
| `getQueueDepth(sessionKey)` | 取得目前佇列深度 |
| `clearQueue(sessionKey)` | 清除等待佇列（保留正在執行的 position=0），回傳被取消數 |

## Turn Queue 設計

- Max depth: 5（超過 reject `BUSY`）
- 排隊超時：`Math.max(config.turnTimeoutMs, 120s)`（取自全域 config.turnTimeoutMs），超時自動 reject `TIMEOUT`
- 第一個進入 queue 的 turn 立即 resolve（不排隊）
- `dequeueTurn()` 由 caller 在 turn 完成後主動呼叫

## 持久化

- 路徑：`{SessionConfig.persistPath}/{safe_key}.json`（一 session 一檔）
- Atomic write：`writeFileSync(tmp)` → `renameSync()`
- SHA-256 checksum 寫入 `_checksum` 欄位，載入時驗證（失敗 → 備份 `.bak` 跳過）
- 舊格式（無 `_checksum`）向下相容

## Compact 機制

`addMessages()` 時自動觸發：messages 超過 `maxHistoryTurns × 2` 時 slice 保留最近 N 輪。

## 清除行為

| 操作 | 方法 | 效果 |
|------|------|------|
| LLM tool `clear_session` | `clearMessages()` | 清空 messages + 重置 turnCount，session 殼保留 |
| Slash command `/reset-session` | `delete()` | 完整刪除 session（記憶體 + JSON 檔，**不 archive**） |
| Dashboard Clear 按鈕 | `clearMessages()` | 同 LLM tool |
| Dashboard Delete 按鈕 | `delete()` | 同 slash command |
| TTL 過期（自動） | `cleanExpired()` / `purgeExpired()` | **archive 到 `_expired/`**，下次對話可還原 |
| 損壞檔（JSON 解析失敗） | 同上 | rename 成 `_corrupt_{ts}_{name}.json`，留人工檢視，不直接刪 |

> 設計意圖：**「使用者明確 delete」≠「TTL 自動過期」**。前者代表「我要丟掉」→ 直接 unlink；後者代表「沒活動」→ 留 archive 副本，方便回頭重啟對話。

## 過期與封存（`_expired/` 機制）

```
{persistDir}/
├── discord_ch_xxxxx.json          ← active session
├── _ce_backups/                   ← CE 壓縮前的備份（保留最近 3 份）
└── _expired/                      ← TTL 過期的封存
    ├── discord_ch_yyyyy.json      ← 過期 archive，下次同 key 對話會還原
    └── _corrupt_1716...json       ← 損壞檔保留人工檢視
```

**流程**：

1. **過期觸發**（`cleanExpired` on init / `purgeExpired` 手動）：lastActiveAt < cutoff → `renameSync` 到 `_expired/`，從 active 區消失但檔案保留
2. **下次對話**（同 sessionKey）：`getOrCreate` 找不到記憶體 → `tryRestoreFromArchive` 把 `_expired/{safe_key}.json` rename 回 active 區，messages/turnCount 完整接續
3. **archive GC**（`purgeArchive` on init）：`_expired/` 中 mtime > 30 天的檔被 unlink（mtime ≈ 該 session 最後活躍時間，因為 `rename` 不改 mtime）
4. **手動 delete**（`/reset-session` / Dashboard）：仍是直接 unlink，**不進 archive**（語意：使用者要丟掉）

## Dashboard API 端點

| 端點 | 方法 | 說明 |
|------|------|------|
| `/api/sessions` | GET | 列出所有 session |
| `/api/sessions/clear` | POST | 清空指定 session 訊息（body: `{ sessionKey }`) |
| `/api/sessions/delete` | POST | 刪除指定 session（body: `{ sessionKey }`) |
| `/api/sessions/compact` | POST | 強制觸發 CE 壓縮（body: `{ sessionKey }`) |
| `/api/sessions/purge-expired` | POST | 批次清除所有過期 session |

## 工具函式

```typescript
export function makeSessionKey(channelId, accountId, isDm, platform?): string;
export function initSessionManager(cfg: SessionConfig, eventBus?): SessionManager;
export function getSessionManager(): SessionManager;
export function resetSessionManager(): void;
```

## 已移除（V1 遺留）

以下功能隨 `src/session.ts` 刪除（2026-04-09）：

- `sessionCache`（channelId → Claude CLI UUID）+ `--resume` 機制
- `data/sessions.json` 單檔持久化
- `enqueue()` → `runTurn()` → `runClaudeTurn()`（V1 ACP turn 執行引擎）
- `active-turns/` crash recovery（`markTurnActive/Done` + `scanAndCleanActiveTurns`）
