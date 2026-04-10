# CatClaw V2 — 訊息流 + Context Engineering 重構計劃

> 基於 V1（platform-rebuild S1-S14）之上的第二階段重構
> 聚焦：訊息完整性 / Context Engineering / Inbound History
> V1 catclaw-platform-architecture.md 保持不變，V2 為獨立新計劃
> 版本：0.4-DRAFT | 日期：2026-03-26

---

## 目錄

1. [背景與動機](#1-背景與動機)
2. [問題點清單](#2-問題點清單)
3. [設計原則](#3-設計原則)
4. [設計方向](#4-設計方向)
5. [子系統規格](#5-子系統規格)
6. [Sprint 計劃](#6-sprint-計劃)
7. [架構影響範圍](#7-架構影響範圍)

---

## 1. 背景與動機

V1 完成了平台骨架（EventBus、AccountRegistry、AgentLoop、Provider 層、Session、Memory Engine 等），但訊息流有三個根本缺口：

| 缺口 | 現象 |
|------|------|
| 無 Context Engineering | session 越長 token 線性增長；compaction = slice 硬截斷，語義消失 |
| History 不完整 | 只存純文字，tool results / tool context 在 turn 結束後消失 |
| Channel 脈絡盲區 | 被 BUSY 拒絕或 requireMention 過濾的訊息，AI 永遠不知道 |

次要缺口：Extract pipeline 預設 disabled、無 token 追蹤、無訊息流追蹤。

---

## 2. 問題點清單

### P1 — Context Engineering 缺失
`session.ts:103` 只做 `slice(-maxTurns * 2)`，硬截斷無語義保留。

### P2 — Tool Results 不存入 History
`agent-loop.ts:331` 只存純文字 response，tool 執行脈絡 turn 結束後消失。

### P3 — Channel 脈絡盲區
session history 只記 bot 處理到的 turns，BUSY/requireMention 過濾的訊息 AI 不知道。

### P4 — Extract Pipeline Disabled
`platform.ts:144` `extract: { enabled: false }`，知識不沉澱。

### P5 — 無可視性
每次 LLM call 消耗多少 token、CE 是否觸發、訊息流整體路徑 — 完全不可見，無法驗證效果。

### P6 — 無即時回饋
用戶送訊息後無任何視覺狀態，tool 跑中無法得知進度。

---

## 3. 設計原則

1. **CE 模組高擴充性**：Strategy Pattern，各機制（Compaction、BudgetGuard 等）可獨立插拔，未來加新策略不動核心。

2. **全面開關控制**：所有 CE 相關機制都有獨立開關，可個別開關進行 A/B 比較驗證效果差異。

3. **CE 模型可自訂**：壓縮/摘要使用的 LLM 可在 catclaw.json 獨立設定；全域設定為預設，各 agent 可覆寫。

4. **Tool Result 外存**：Tool results 存為獨立 log 檔，session history 只存索引摘要（操作記錄 + 路徑指標）。

5. **Turn Audit Log**：每個 turn 完整記錄訊息流處理進程（token 消耗、CE 觸發、inbound 注入量、時間分解）。

6. **Inbound History 獨立 + 時間衰退**：頻道訊息日誌與 session history 並存，注入前依時間分 bucket 處理；消費後刪除。

7. **平台前綴**：所有持久化檔名含平台標識（`discord_`、`telegram_` 等），避免多平台衝突。

---

## 4. 設計方向

### 4.1 Context Engineering — Strategy Pattern 架構

```
ContextEngine
 ├─ strategies: Map<string, ContextStrategy>
 │   ├─ "compaction"     — 觸發閾值時 LLM 摘要壓縮
 │   ├─ "budget-guard"   — 超 token budget 前強制壓縮
 │   ├─ "sliding-window" — 僅保留最近 N 輪（現況升級版）
 │   └─ (未來可加 "rag-retrieval"、"importance-scoring" 等)
 └─ build(messages, opts) → Message[]
```

**catclaw.json 設定**：
```jsonc
{
  "contextEngineering": {
    "enabled": true,
    "model": "claude-haiku-4-5-20251001",  // CE 專用模型（全域預設）
    "strategies": {
      "compaction":    { "enabled": true, "triggerTurns": 20, "preserveRecentTurns": 5 },
      "budgetGuard":   { "enabled": true, "maxUtilization": 0.8 },
      "slidingWindow": { "enabled": false }
    }
  },
  "agents": {
    "support-bot": {
      "contextEngineering": { "model": "claude-haiku-4-5-20251001" }  // agent 可覆寫
    }
  }
}
```

### 4.2 Tool Result 外存 + History 索引

```
Turn 結束後（有 tool calls 時）：
  tool results → data/tool-logs/{platform}_{sessionKey}/turn_{n}.json
  session history 追加：
    { role:'system', content: '[工具記錄] read_file×2, edit_file×1 → tool-logs/discord_ch_111/turn_42.json' }
```

LLM 知道「有工具操作、做了什麼」，需要細節時有路徑可查，不佔 context。

### 4.3 Inbound History — 時間衰退機制

**記錄時機**：訊息不進 agent loop 時（requireMention 未觸發、BUSY 拒絕等），append 到 `data/inbound/discord_{ch}.jsonl`。

**消費時機**：mention 觸發 → agent loop 開始前處理所有未消費 entries。

**三 bucket 處理流程**：
```
所有未消費 entries
  ├─ Bucket A（< fullWindow，預設 24h）
  │     → 全量帶入（程式處理，無 LLM）
  │
  ├─ Bucket B（fullWindow ~ decayWindow，預設 24~168h）
  │     → LLM 壓縮
  │     → 壓縮後 > bucketBTokenCap（預設 600）
  │           → Decay II：截掉舊端 → 重新壓縮 → 上限 decayIITokenCap（預設 300）
  │           （Decay II 純程式，無額外 LLM call）
  │
  └─ Bucket C（> decayWindow，預設 168h）
        → 直接清除（程式處理）

組合：A（全量）+ B（壓縮後）→ 注入 system prompt "channel context" section
消費後：刪除這批 entries
```

**config**：
```jsonc
{
  "inboundHistory": {
    "enabled": true,
    "fullWindowHours": 24,
    "decayWindowHours": 168,
    "bucketBTokenCap": 600,
    "decayIITokenCap": 300,
    "inject": { "enabled": false }  // 預設關閉，需要時開
  }
}
```

### 4.4 Turn Audit Log

每個 turn 記完整快照，JSONL append-only：

```jsonl
{
  "ts": "2026-03-26T14:00:00Z",
  "platform": "discord",
  "sessionKey": "discord:ch:111",
  "turnIndex": 42,
  "phase": { "inboundReceived": "14:00:00.000", "queueWaitMs": 120, "agentLoopStartMs": 140, "completedMs": 4340 },
  "inboundInjected": { "bucketA": 5, "bucketB": 3, "decayIIApplied": false, "tokens": 480 },
  "contextBreakdown": { "systemPrompt": 380, "recall": 210, "history": 1520, "inboundContext": 480, "current": 230 },
  "ceApplied": ["compaction"],
  "tokensBeforeCE": 3200,
  "tokensAfterCE": 1850,
  "model": "claude-sonnet-4-6",
  "inputTokens": 2820,
  "outputTokens": 390,
  "toolCalls": 2,
  "toolLogPath": "tool-logs/discord_ch_111/turn_42.json",
  "durationMs": 4200
}
```

新增 `/turn-audit` skill：
```
/turn-audit              → 本 session 最近 10 turn 摘要
/turn-audit --last 5     → 最近 5 turn 詳細
/turn-audit --ce         → 只顯示 CE 有觸發的 turns
```

### 4.5 Extract Pipeline 啟用

`platform.ts` 預設改為：
```typescript
extract: { enabled: true, perTurn: true, minToolCalls: 1, onSessionEnd: false }
```
Extract 呼叫為 async fire-and-forget，不阻塞 reply。

### 4.6 Session Snapshot + /stop 回退

**快照時機**：每個 turn 開始前（agentLoop 執行前）拍一次。

```
turn 開始
  → snapshot(session.messages) → data/session-snapshots/{platform}_{key}_snap_{n}.json
  → CE build（可能壓縮）
  → agentLoop 執行...

正常完成：
  → 刪除本次 snapshot
  → 若 CE 有壓縮：保留 snapshot 48h（供 /rollback 手動還原）

/stop 觸發（Discord 指令）：
  → AbortController.abort()（強殺，不等 tool call）
  → 還原 session.messages → 本次 turn 的 snapshot
  → 通知使用者：「已中斷，session 還原至 turn #N 前」
  → 刪除本次 snapshot
```

**指令集**：

| 指令 | 行為 |
|------|------|
| `/stop` | 強制中斷當前 turn + 自動回退 session |
| `/queue` | 查看 TurnQueue 狀態（幾條排隊） |
| `/queue clear` | 清空排隊（不中斷當前） |
| `/rollback` | turn 正常完成但 CE 品質不好，手動還原 CE 壓縮 |
| `/rollback --list` | 列出可用 snapshots |

**兩種回退場景的差別**：
- `/stop` → turn 執行中強制中斷 + 自動回退（session 回到這條訊息未送出前的狀態）
- `/rollback` → turn 已正常完成，CE 壓縮語義損失，手動還原

### 4.7 Ack Reaction 狀態機

```
訊息進 queue → ⏳
agentLoop 開始 → 🤔
tool call 執行中 → 🔧
完成 → 移除（靜默）
/stop 中斷 → ❌（附通知訊息）
錯誤 → ❌
```

---

## 5. 子系統規格

### S-V2-1：ContextEngine（新模組）
**位置**：`src/core/context-engine.ts`

```typescript
export interface ContextStrategy {
  name: string;
  shouldApply(ctx: ContextBuildContext): boolean;
  apply(ctx: ContextBuildContext): Promise<ContextBuildContext>;
}

export class ContextEngine {
  register(strategy: ContextStrategy): void;
  async build(messages: Message[], opts: BuildOpts): Promise<Message[]>;
  estimateTokens(messages: Message[]): number;
  lastBuildBreakdown: ContextBreakdown;
  lastAppliedStrategy: string | undefined;
}
```

內建 strategies：`CompactionStrategy`、`BudgetGuardStrategy`、`SlidingWindowStrategy`

### S-V2-2：TurnAuditLog（新模組）
**位置**：`src/core/turn-audit-log.ts`

JSONL 持久化，rolling 30 天。整合 token 追蹤 + CE 追蹤 + inbound 注入量 + 時間分解。
支援 `/turn-audit` skill 查詢。

### S-V2-3：ToolLogStore（新模組）
**位置**：`src/core/tool-log-store.ts`

儲存 tool 執行完整記錄，回傳 log path 供 history 索引。
路徑格式：`data/tool-logs/{platform}_{safe_session_key}/turn_{n}.json`

### S-V2-4：InboundHistoryStore（新模組）
**位置**：`src/discord/inbound-history.ts`

```typescript
export interface InboundEntry {
  ts: string;              // ISO 8601
  platform: string;        // "discord"
  authorId: string;
  authorName: string;
  content: string;
  wasProcessed: false;     // 未消費
}

export class InboundHistoryStore {
  append(channelId: string, entry: InboundEntry): void;
  consumeForInjection(channelId: string, cfg: InboundHistoryCfg, ceProvider: LLMProvider): Promise<string | null>;
  // consumeForInjection 返回組裝好的 context string，並刪除這批 entries
}
```

### S-V2-5：Agent Loop + Discord 改動

**agent-loop.ts**：
- context 組裝改走 `ContextEngine.build()`
- turn 結束後存 tool log + history 索引
- 記錄 `TurnAuditLog`

**discord.ts**：
- 訊息不進 agent loop → `inboundHistoryStore.append()`
- 進 agent loop 前 → `inboundHistoryStore.consumeForInjection()`
- 加 ack reaction 狀態機
- turn 完成後呼叫 extract（async fire-and-forget）

### S-V2-6：Session Key + 檔名平台前綴

Session key 格式：`{platform}:ch:{channelId}` / `{platform}:dm:{accountId}:{channelId}`
持久化檔名：`discord_ch_111.json`、`discord_ch_111.jsonl`
Migration：V1 sessions 重新命名（migration tool 加一步）

---

## 6. Sprint 計劃

| Sprint | 項目 | 估計 | 依賴 |
|--------|------|------|------|
| S-V2-1 | ContextEngine + Strategy 骨架 + 3 內建 strategy | 2 sessions | — |
| S-V2-2 | TurnAuditLog + `/turn-audit` skill | 1 session | — |
| S-V2-3 | ToolLogStore + agent-loop tool log 改動 | 1 session | S-V2-1 |
| S-V2-4 | InboundHistoryStore（含時間衰退 + 壓縮） | 1.5 sessions | S-V2-1 |
| S-V2-5 | Discord 層改動（inbound append + ack reaction + extract） | 1 session | S-V2-4 |
| S-V2-6 | Session key 平台前綴 + 檔名遷移 | 0.5 session | — |
| S-V2-7 | SessionSnapshot + /stop + /rollback + /queue skill | 1 session | S-V2-1 |
| S-V2-8 | Extract Pipeline 啟用 + config schema 更新 | 0.5 session | S-V2-5 |
| S-V2-9 | 整合測試 + CE 效果驗證（對比 TurnAuditLog） | 1 session | 全部 |

**建議執行順序**：
1. S-V2-6（平台前綴）— 基礎命名先統一，之後不用改
2. S-V2-2（TurnAuditLog）— 先有觀測工具
3. S-V2-1（ContextEngine）— 核心
4. S-V2-3（ToolLogStore）
5. S-V2-4 + S-V2-5（InboundHistory + Discord）
6. S-V2-7 + S-V2-8（整合 + 驗證）

---

## 7. 架構影響範圍

| 檔案 | 改動性質 |
|------|---------|
| `src/core/context-engine.ts` | **新增** |
| `src/core/turn-audit-log.ts` | **新增** |
| `src/core/tool-log-store.ts` | **新增** |
| `src/discord/inbound-history.ts` | **新增** |
| `src/skills/builtin/turn-audit.ts` | **新增** |
| `src/skills/builtin/stop.ts` | **新增**（/stop + /queue + /rollback） |
| `src/core/session-snapshot.ts` | **新增** |
| `src/core/agent-loop.ts` | 中度修改 |
| `src/core/session.ts` | 輕度修改（platform prefix） |
| `src/core/platform.ts` | extract 預設開啟 + CE 初始化 |
| `src/discord.ts` | inbound append + ack reactions + extract |
| `src/core/config.ts` | contextEngineering + inboundHistory config |
| `migration/` | session key 重新命名工具 |

**不動**：V1 全部子系統、`catclaw-platform-architecture.md`（待驗收）

---

## 注意事項

- V2 實作前 V1 需先完整驗收（`platform-rebuild` branch）
- ContextEngine LLM 壓縮呼叫建議用 haiku 級別模型，控制成本
- InboundHistory Bucket B LLM 壓縮 + Decay II 純程式，共 1 次 LLM call
- Extract 啟用後需 async fire-and-forget，不阻塞 reply
- Ack reaction 需要 bot 有 `ADD_REACTIONS` Discord permission
- InboundHistory / TurnAuditLog JSONL rolling 清理避免磁碟問題
