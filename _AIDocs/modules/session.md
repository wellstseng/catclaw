# modules/session — Session 快取 + 串行佇列 + 磁碟持久化

> ⚠️ **舊版參考**：以下內容描述的是 `src/session.ts`（V1 ACP/CLI 架構）。新版 `src/core/session.ts` 採用 `SessionManager` class 設計，詳見文末「新版 SessionManager」段落。

> 檔案：`src/session.ts`（舊版）

## 職責

1. 維護 `channelId → sessionId`（UUID）的快取
2. 以 Promise chain 實作 per-channel 串行佇列
3. 磁碟持久化：sessionCache 寫入 `data/sessions.json`，重啟不遺失
4. TTL 機制：超過 `sessionTtlHours` 的 session 自動開新（不帶 `--resume`）
5. 錯誤處理：錯誤時保留 session，下次訊息繼續 `--resume` 同一 session
6. 傳遞 `channelId` 給 `runClaudeTurn()`（注入 `CATCLAW_CHANNEL_ID` env var）
7. 對外暴露 `enqueue()` + `loadSessions()` + `getRecentChannelIds()`

## Session 策略

| 場景 | Session Key | 行為 |
|------|------------|------|
| Guild 頻道 | `channelId` | 同頻道所有人共享對話 |
| DM | `channelId`（每人唯一） | per-user session |

- 首次對話：不帶 `--resume`，claude CLI 自動建立 session
- `session_init` event → 取得 UUID → 快取 + 持久化
- 後續：`--resume <UUID>` 延續上下文
- 超過 TTL → 不帶 `--resume`，開新 session

## 型別定義

```typescript
/** enqueue 的 event 回呼 */
export type OnEvent = (event: AcpEvent) => void | Promise<void>;

/** sessions.json 內每個 channel 的資料 */
interface SessionRecord {
  sessionId: string;
  updatedAt: number;  // Unix timestamp（毫秒）；每次 turn 完成都刷新，作為 TTL 基準
}

/** sessions.json 的完整結構 */
type SessionStore = Record<string, SessionRecord>;

/** active-turns/{channelId}.json 的結構（crash recovery 用） */
export interface ActiveTurnRecord {
  startedAt: number;  // turn 開始時間（Unix ms），用於過期判斷
  prompt: string;     // 使用者 prompt 前 200 字（重啟後顯示確認用）
}

/** enqueue() 的選項參數 */
export interface EnqueueOptions {
  // cwd 和 claudeCmd 已移除，由 acp.ts 從環境變數取得
  turnTimeoutMs: number;          // 基礎回應超時毫秒數，超時自動 abort
  turnTimeoutToolCallMs: number;  // tool_call 偵測後延長至此值
  sessionTtlMs: number;           // session 閒置超時毫秒數
}
```

## 持久化路徑

| 資料 | 路徑 | 說明 |
|------|------|------|
| Session 快取 | `<CATCLAW_WORKSPACE>/data/sessions.json` | `resolveWorkspaceDir()` 取路徑 |
| Active-turn 追蹤 | `<CATCLAW_WORKSPACE>/data/active-turns/{channelId}.json` | 暫存，turn 結束自動刪除 |

## 磁碟持久化

### 檔案位置

`<CATCLAW_WORKSPACE>/data/sessions.json`（已加入 `.gitignore`）

### 檔案格式

```json
{
  "<channelId>": {
    "sessionId": "claude-session-uuid",
    "updatedAt": 1710000000000
  }
}
```

### I/O 時機

| 事件 | 動作 |
|------|------|
| 啟動時（`loadSessions()`） | 讀檔 → 填充 `sessionCache` + `sessionUpdatedAt` |
| `session_init` 攔截 | `recordSession()` → 更新快取 + 原子寫入磁碟 |
| turn 完成後 | `recordSession()` → 刷新 `updatedAt` + 原子寫入磁碟 |

### 原子寫入

```
writeFileSync(sessions.json.tmp) → renameSync(sessions.json)
```

避免寫入中途 crash 導致 JSON 損壞。

### 過期清理

`saveSessions(ttlMs)` 寫入時順便清理超過 TTL 的 session（從記憶體 + 磁碟同時移除）。

## 錯誤處理（保留 Session）

錯誤時**不清除 session**，保留現有 session ID。下次使用者傳訊時繼續 `--resume` 同一 session。

- `hasError`：`for await` loop 中收到 `event.type === "error"` 時設為 `true`
- 錯誤發生時僅 `log.warn`，不刪除 session、不重試

```
帶 --resume 執行 → 收到 error event（hasError=true）
  → log.warn（記錄錯誤）
  → 保留 session（不清除 cache / 磁碟）
  → 下次訊息繼續 --resume 同一 session
```

**設計理由**：避免因暫時性錯誤清除 session 導致上下文遺失。

## Per-Channel 串行佇列

```
同一 channel：turn1 → turn2 → turn3（Promise chain 串行）
不同 channel：完全並行
```

實作：`queues: Map<channelId, Promise<void>>`

### Chain 建立流程

```typescript
// 1. 取得現有 chain 尾端（無佇列時用 Promise.resolve() 作為起點）
const tail = queues.get(channelId) ?? Promise.resolve();

// 2. 建立帶 timeout 的 AbortController（每個 turn 獨立）
const ac = new AbortController();
const timer = setTimeout(() => ac.abort(), opts.turnTimeoutMs);

// 3. 接在尾端：tail 完成後才執行本 turn
const next = tail.then(() =>
  runTurn(channelId, text, onEvent, ..., ac.signal)
    .catch((err: unknown) => {
      // rejection 在此消化，chain 不中斷
      // 超時 vs 一般錯誤分流
      const message = ac.signal.aborted
        ? `回應超時（${Math.round(opts.turnTimeoutMs / 1000)}s），已取消`
        : err instanceof Error ? err.message : String(err);
      void onEvent({ type: "error", message });
    })
    .finally(() => clearTimeout(timer))   // 正常完成也清除 timer
);

// 4. 更新 queues（後續 turn 會以此為 tail）
queues.set(channelId, next);

// 5. chain 完成後清理 Map（避免記憶體洩漏）
//    identity check：若已有新 turn 接入（queues.get !== next），不刪
next.finally(() => {
  if (queues.get(channelId) === next) queues.delete(channelId);
});
```

**關鍵設計點**：
- `enqueue()` 回傳 `void`，fire-and-forget，呼叫方不等待結果
- `.catch()` 消化 rejection → chain 永遠不會因單一 turn 失敗而中斷
- identity check（`=== next`）防止後進 turn 誤刪其他人建立的 chain entry

## Turn Timeout（分級 + 預警）

基礎機制：`new AbortController()` + `setTimeout(turnTimeoutMs)` → `ac.abort()`
- acp.ts 收到 signal → SIGTERM → 250ms → SIGKILL
- 超時錯誤訊息：`` 回應超時（${N}s），已取消 ``
- `.finally(cleanup)` 正常完成時清除所有 timer

### 80% 預警

到達 `turnTimeoutMs × 0.8` 時，送出 `timeout_warning` event → reply.ts 顯示：
```
⏳ 任務仍在進行中，已耗時 N 分鐘...
```
不中斷流程，純通知。

### 分級 Timeout（tool_call 自動延長）

`runTurn()` 首次偵測到 `tool_call` event → 呼叫 `extendTimeout()` → 延長至 `turnTimeoutToolCallMs`：
- 重新計算剩餘時間，重設主 timer
- 預警 timer 也跟著重設（若尚未送出）
- 只延長不縮短（`turnTimeoutToolCallMs <= currentTimeoutMs` 時跳過）
- config 可設 `turnTimeoutToolCallMs`，預設 `turnTimeoutMs × 1.6`

## Crash Recovery（Active-Turn 追蹤）

turn 執行中寫入 `data/active-turns/{channelId}.json`，結束時刪除。
bot crash 後重啟，`scanAndCleanActiveTurns()` 掃描殘留檔案，向使用者確認是否接續。

### 流程

```
turn 開始 → markTurnActive(channelId, prompt)
              寫入 data/active-turns/{channelId}.json
                     ↓
            turn 執行（runTurn finally 區塊保證清理）
                     ↓
turn 結束 → markTurnDone(channelId)
              unlinkSync(active-turns/{channelId}.json)
```

若在執行中間 crash：
- `active-turns/{channelId}.json` 殘留
- 重啟後 `scanAndCleanActiveTurns()` 偵測（10 分鐘內算有效）
- `index.ts` 向頻道發送確認訊息

### `markTurnActive(channelId, prompt)` / `markTurnDone(channelId)`

私有函式，由 `runTurn()` 的 try/finally 自動呼叫，呼叫方無需管理。

## 對外 API

### `clearMessages(sessionKey): number`

清空指定 session 的訊息記錄（保留 session 本身）。回傳被清除的訊息數量。

### `purgeExpired(): number`

批次清除所有超過 TTL 的過期 session。回傳被清除的 session 數量。

### `loadSessions()`

啟動時呼叫，從 `<CATCLAW_WORKSPACE>/data/sessions.json` 載入 session 快取。
檔案不存在或格式錯誤時靜默忽略（視為首次啟動）。

### `scanAndCleanActiveTurns(maxAgeMs?): Array<{ channelId, record }>`

掃描 `data/active-turns/` 目錄，回傳未過期（預設 10 分鐘內）的中斷 turn 列表。
掃描後**無論是否過期都清理**所有 active-turn 檔案。
由 `index.ts` 在 ready 事件中呼叫。

### `getRecentChannelIds(ttlMs): string[]`

回傳 TTL 內最近活躍的 channel ID 列表。
用於需要通知多個頻道的場景（例如重啟廣播）。

### `enqueue(channelId, text, onEvent, opts)`

將一個 turn 加入指定 channel 的串行佇列。
同一 `channelId` 的呼叫依序執行，不同 `channelId` 完全並行。

## session_init 攔截

`runTurn()` 攔截 `session_init` event → 存入 `sessionCache` + 持久化 → **不轉發**給 reply handler。
上層 reply.ts 永遠不會收到 `session_init`。

## Dashboard API 端點（session 管理）

| 端點 | 方法 | 說明 |
|------|------|------|
| `/api/sessions/clear` | POST | 清空指定 session 訊息（body: `{ sessionKey }`) |
| `/api/sessions/delete` | POST | 刪除指定 session（body: `{ sessionKey }`) |
| `/api/sessions/compact` | POST | 強制觸發 CE 壓縮（body: `{ sessionKey }`) |
| `/api/sessions/purge-expired` | POST | 批次清除所有過期 session |

Dashboard UI 在 Sessions 分頁提供 per-session 操作按鈕（Clear / Compact / Delete）及全域 Purge Expired 按鈕。

## 內部函式

| 函式 | 說明 |
|------|------|
| `getValidSessionId(channelId, ttlMs)` | 取得有效 session ID，TTL 超過時清除並回傳 null |
| `recordSession(channelId, sessionId, ttlMs)` | 更新快取 + 刷新 updatedAt + 寫入磁碟 |
| `saveSessions(ttlMs)` | 原子寫入磁碟，同時清理過期 session |
| `runTurn(...)` | 執行單一 turn，攔截 session_init，錯誤時保留 session，try/finally 清理 active-turn |
| `markTurnActive(channelId, prompt)` | 寫入 active-turn 追蹤檔（crash recovery 用） |
| `markTurnDone(channelId)` | 刪除 active-turn 追蹤檔（turn 結束時自動呼叫） |

---

## 新版 SessionManager（`src/core/session.ts`）

> V2 架構。Session = 頻道/帳號的對話上下文（messages history + provider binding）。

### 設計要點

- Session key 格式：`{platform}:ch:{channelId}`（群組）或 `{platform}:dm:{accountId}:{channelId}`（DM）
- 持久化：atomic write（先寫 `.tmp` 再 `rename`），含 SHA-256 checksum 驗證
- TTL 清理：啟動時 `cleanExpired()` 掃描刪除過期 session
- Turn Queue：per-session FIFO 佇列，max depth 5，排隊超時自動移出
- 全域單例模式：`initSessionManager()` / `getSessionManager()`

### 型別定義

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

### SessionManager API

| 方法 | 說明 |
|------|------|
| `init()` | 初始化：建立 persistDir、清除過期、載入所有 session |
| `getOrCreate(sessionKey, accountId, channelId, providerId)` | 取得或建立 session |
| `get(sessionKey)` | 取得 session（不存在回傳 undefined） |
| `addMessages(sessionKey, messages)` | 新增訊息（user + assistant），觸發 compact + persist |
| `getHistory(sessionKey)` | 取得對話歷史 `Message[]` |
| `replaceMessages(sessionKey, messages)` | CE 壓縮後寫回精簡版 messages（備份原始至 `_ce_backups/`，保留最近 3 份） |
| `clearMessages(sessionKey)` | 清空訊息（保留 session 殼），回傳被清除數 |
| `delete(sessionKey)` | 刪除 session（記憶體 + 磁碟），觸發 `session:end` event |
| `purgeExpired()` | 批次清除過期 session（含磁碟孤兒檔案），回傳清除數 |
| `list()` | 回傳所有 session 陣列 |

### Turn Queue API

| 方法 | 說明 |
|------|------|
| `enqueueTurn(request)` | 排入 turn queue，回傳 Promise（可開始執行時 resolve）。depth >= 5 → reject |
| `dequeueTurn(sessionKey)` | 前一個 turn 完成，讓下一個開始 |
| `getQueueDepth(sessionKey)` | 取得目前佇列深度 |
| `clearQueue(sessionKey)` | 清除等待佇列（保留正在執行的 position=0），回傳被取消數 |

### Turn Queue 設計

- Max depth: 5（超過 reject `BUSY`）
- 排隊超時：`Math.max(config.turnTimeoutMs, 120s)`（取自全域 config.turnTimeoutMs），超時自動 reject `TIMEOUT`
- 第一個進入 queue 的 turn 立即 resolve（不排隊）
- `dequeueTurn()` 由 caller 在 turn 完成後主動呼叫

### 持久化

- 路徑：`{SessionConfig.persistPath}/{safe_key}.json`
- Atomic write：`writeFileSync(tmp)` → `renameSync()`
- SHA-256 checksum 寫入 `_checksum` 欄位，載入時驗證（失敗 → 備份 `.bak` 跳過）
- 舊格式（無 `_checksum`）向下相容

### Compact 機制

`addMessages()` 時自動觸發：messages 超過 `maxHistoryTurns × 2` 時 slice 保留最近 N 輪。

### 工具函式

```typescript
export function makeSessionKey(channelId, accountId, isDm, platform?): string;
export function initSessionManager(cfg: SessionConfig, eventBus?): SessionManager;
export function getSessionManager(): SessionManager;
export function resetSessionManager(): void;
```
