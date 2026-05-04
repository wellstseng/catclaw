# fts-query

> 對應原始碼：`src/memory/fts-query.ts`
> 建立日期：2026-05-04（CatClaw 整合 Hermes 計畫項目 9 Phase 2/3）

## 用途

NDJSON 訊息索引的查詢介面（Phase 2）+ 統計聚合（Phase 3）。
Phase 1（`message-index-store.ts`）負責寫入；本檔負責讀。

設計考量：catclaw 已捨棄 SQLite native 依賴 → 用 NDJSON 線性掃描。
量大時可升 SQLite FTS5（`searchMessages` / `aggregateMessages` 簽名 stable，內部換掉即可）。

## Exports

```typescript
export interface FtsQueryOpts {
  query: string;
  days?: number;
  since?: number;
  sessionKey?: string;
  channelId?: string;
  accountId?: string;
  agentId?: string;
  role?: "user" | "assistant" | "tool_result";
  limit?: number;       // 預設 50
}

export interface FtsHit {
  message: IndexedMessage;
  matchOffset: number;
  preview: string;       // 命中前後各 60 字
}

export function searchMessages(opts: FtsQueryOpts): FtsHit[];

export interface MessageAggregate {
  total: number;
  byRole: Record<string, number>;
  bySession: Record<string, number>;
  topChannels: Array<{ channelId: string; count: number }>;
  topTools: Array<{ name: string; count: number }>;
  hourHistogram: number[];   // 24-hour
  earliestTs?: number;
  latestTs?: number;
}

export function aggregateMessages(opts: { days?: number }): MessageAggregate;
```

## 跨檔掃描

兩個函式都跨主檔 + rotation 歷史檔（`messages.ndjson` / `messages.{ts}.ndjson`）。新檔優先掃描；達 limit 即返回。

## 上層 caller

| Caller | 用途 |
|--------|------|
| `src/skills/builtin/recall.ts`（`/recall`）| 跨 session 訊息搜尋 |
| `src/skills/builtin/insights.ts`（`/insights`）| 統計報告（Phase 3）|
| `src/tools/builtin/memory-search-fulltext.ts` | LLM 用的訊息搜尋 tool |
| `src/core/dashboard.ts` GET `/api/insights` | Dashboard「洞察」tab |

## 不做（Phase 4+）
- 升 SQLite FTS5（量大才評估）
- 模糊匹配 / 同義詞展開（先做 substring）
- 相似度排序（current sort by ts desc）
