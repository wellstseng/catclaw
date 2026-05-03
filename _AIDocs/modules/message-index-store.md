# message-index-store

> 對應原始碼：`src/memory/message-index-store.ts`
> 建立日期：2026-05-04（CatClaw 整合 Hermes 計畫項目 9 Phase 1）

## 用途

跨 session 訊息全文索引，為後續 `/recall` skill（Phase 2）+ trajectory fingerprint
訓練資料源（項目 12 階段 2）預埋資料。

**設計變動 vs Plan 9**：plan 寫 SQLite FTS5，但 catclaw 已捨棄 SQLite native 依賴
（`history.ts` 註解明示「不依賴 native build」）。Phase 1 改採 NDJSON append-only。

## 與其他寫入並存

| 路徑 | 來源 | 內容 |
|------|------|------|
| `data/history.ndjson` | `src/history.ts` | Discord-only message log（user/bot pairs） |
| **`data/messages.ndjson`** | **本模組** | **跨平台 + 跨 session 訊息全文索引** |

兩者 schema 不同；本模組為「跨 session recall + 訓練資料」目的，前者為「歷史回溯」目的。

## Exports

```typescript
export interface IndexedMessage {
  ts: number;
  messageId?: string;
  sessionKey: string;
  channelId?: string;
  accountId?: string;
  agentId?: string;
  role: "user" | "assistant" | "tool_result";
  turnIndex?: number;
  content: string;
  toolName?: string;     // role=tool_result 時用
}

export function initMessageIndex(): void;
export function indexMessage(msg: IndexedMessage): void;
export function getMessageIndexPath(): string;
```

## 接入點

- `platform.ts initPlatform` 末尾呼 `initMessageIndex`（確保 `data/` 目錄存在）
- `message-pipeline.ts` user message 進入後 `indexMessage(role="user")`
  （sessionKey 用 `${platform}:ch:${channelId}` inline 計算）
- `agent-loop.ts trace.recordResponse` 後 `indexMessage(role="assistant", content=fullResponse, turnIndex=savedTurnIndex)`

## 寫入策略

- **fire-and-forget**：失敗只 warn，不阻塞主 pipeline
- **append-only**：每訊息一行 JSON，不更新既有 entry
- **無 rotation**：本階段不限制檔案大小（用量觀察後 Phase 2 評估）

## 路徑

`~/.catclaw/workspace/data/messages.ndjson`（受 `CATCLAW_HOME` 環境變數覆寫）

## 未來升級路徑（Phase 2-3，本檔不做）

| 目標 | 路徑 |
|------|------|
| `memory_search_fulltext` LLM tool | 線性掃描 NDJSON 或升級 FTS5 |
| `/recall <query>` skill | 同上 |
| `/insights` 統計報告 | 從 NDJSON + trace 算 token / cost / activity |
| Dashboard 搜尋面板 | 同 query 介面 |

**升級 SQLite FTS5**：需引入 `better-sqlite3`（catclaw 設計避開 native build），
或評估 Node 22+ 內建 `node:sqlite`（FTS5 支援 Node 24+）。schema 已對齊 plan 9 的
`messages_fts` (FTS5 virtual) + `messages_meta` (PRIMARY KEY)。
