# modules/event-bus — 強型別事件匯流排

> 檔案：`src/core/event-bus.ts`
> 更新日期：2026-04-05

## 職責

Node.js EventEmitter 封裝。所有子系統透過 EventBus 溝通，不直接互相 import。
事件定義對應架構文件第 11 節。

## API

```typescript
const eventBus = new CatClawEventBus();

eventBus.on("turn:before", (ctx) => { ... });
eventBus.emit("turn:before", ctx);
eventBus.off("turn:before", listener);
eventBus.once("session:end", (sessionId) => { ... });
```

MaxListeners 設為 100（避免大量模組訂閱時的 leak 警告）。

## 事件清單

### 平台生命週期

| 事件 | Payload | 說明 |
|------|---------|------|
| `platform:startup` | — | 平台啟動 |
| `platform:shutdown` | — | 平台關閉 |

### Session

| 事件 | Payload | 說明 |
|------|---------|------|
| `session:created` | sessionId, accountId | 新 session |
| `session:idle` | sessionId, idleMs | 閒置 |
| `session:end` | sessionId | 結束 |

### Turn

| 事件 | Payload | 說明 |
|------|---------|------|
| `turn:before` | TurnContext | Turn 開始前 |
| `turn:after` | TurnContext, response | Turn 完成後 |
| `turn:queued` | sessionKey, accountId | 排入佇列 |
| `turn:started` | sessionKey, accountId | 開始執行 |

### Tool

| 事件 | Payload | 說明 |
|------|---------|------|
| `tool:before` | ToolCall | 工具執行前 |
| `tool:after` | ToolCall, ToolResult | 工具完成後 |
| `tool:error` | ToolCall, Error | 工具錯誤 |

### Provider

| 事件 | Payload | 說明 |
|------|---------|------|
| `provider:error` | providerId, Error | Provider 錯誤 |
| `provider:rateLimit` | providerId, retryAfterMs | Rate limit |

### 檔案

| 事件 | Payload | 說明 |
|------|---------|------|
| `file:modified` | path, tool, accountId | 檔案被修改 |
| `file:read` | path, accountId | 檔案被讀取 |

### 記憶

| 事件 | Payload | 說明 |
|------|---------|------|
| `memory:recalled` | atoms[], layer | 記憶被召回 |
| `memory:extracted` | items[] | 知識被萃取 |
| `memory:written` | atom, layer | Atom 被寫入 |
| `memory:promoted` | atom, from, to | Atom 晉升 |
| `memory:archived` | atom, score | Atom 歸檔 |

### 工作流

| 事件 | Payload | 說明 |
|------|---------|------|
| `workflow:rut` | RutWarning[] | 重複模式偵測 |
| `workflow:oscillation` | atom, count | 擺盪偵測 |
| `workflow:sync_needed` | files[] | 需同步 |

### Subagent

| 事件 | Payload | 說明 |
|------|---------|------|
| `subagent:completed` | parentSessionKey, runId, label, result | 子 agent 完成 |
| `subagent:failed` | parentSessionKey, runId, label, error | 子 agent 失敗 |

### Task UI

| 事件 | Payload | 說明 |
|------|---------|------|
| `task:ui` | channelId, TaskUiPayload[] | 任務 UI 更新 |

### 帳號

| 事件 | Payload | 說明 |
|------|---------|------|
| `account:created` | accountId | 帳號建立 |
| `account:linked` | accountId, platform | 身份綁定 |

### 排程 / Skill

| 事件 | Payload | 說明 |
|------|---------|------|
| `cron:executed` | jobId | 排程 job 執行完成 |
| `skill:invoked` | skillName, accountId | Skill 被觸發 |

## 訂閱者

| 訂閱者 | 監聽事件 |
|--------|---------|
| workflow/file-tracker | `tool:after`（file:modified 偵測） |
| workflow/sync-reminder | `file:modified` |
| workflow/rut-detector | `turn:after` |
| workflow/oscillation-detector | `memory:written` |
| workflow/wisdom-engine | `turn:after` |
| workflow/memory-extractor | `turn:after` |
| workflow/aidocs-manager | `file:modified` |
| safety/collab-conflict | `file:modified` |
| agent-loop | emit `turn:before`, `turn:after`, `tool:before`, `tool:after` |
