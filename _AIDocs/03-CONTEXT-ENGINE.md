# Context Engineering (CE) 機制

> catclaw 的 LLM context 管理層。
> 在每次 `LLM call` **之前**對 messages 套一連串 strategies，
> 把超量 / 老舊 / 重複的內容壓縮、衰減、截斷，避免撞 context window 上限。
>
> Source: `src/core/context-engine.ts`
> 觸發點: `agent-loop.ts` 每個 loop 呼叫 LLM 前
> 觀測: `MessageTrace.contextEngineering` + dashboard trace UI

---

## 1. 設計理念

| 維度 | catclaw CE |
|---|---|
| 架構 | **Strategy Pattern**（`ContextEngine` 持有 `Map<name, ContextStrategy>`）|
| 順序 | `decay` → `compaction` → `overflow-hard-stop`（hardcoded `order` 陣列） |
| 開關 | 每個 strategy 各自 `enabled`，可獨立 A/B |
| Token 估算 | 粗估 `~4 chars/token`（`estimateTokens()`），無 LLM 成本 |
| 觸發點 | `ContextEngine.build(messages, opts)`；每次 LLM call 前都跑 |
| 副作用 | 改寫 `messages` 內容（**不改 session 原始 messages**，只回傳壓過的副本給 LLM） |

`build()` 三段流程：
1. 估 `messageTokens + systemPromptTokens + toolsTokens = tokensBeforeCE`
2. 依 `order` 跑每個 strategy 的 `shouldApply()` + `apply()`，累積 `applied` / `details`
3. 回傳壓過的 `messages` + 把 metadata 寫進 `lastBuildBreakdown`（給 trace 收集）

---

## 2. 三大 Strategy

### 2.1 DecayStrategy — 漸進式衰減

> 把舊訊息按「年齡（turn 距今多遠）」分層壓縮 / 移除。
> 老的訊息保留少 tokens，更老的直接移除。**零 LLM 成本**。

**Default Levels**（依年齡升級）：

| Level | minAge | 動作 |
|---|---|---|
| L1 | ≥ 1 turn 老 | 截到 maxTokens=2000（精簡）|
| L2 | ≥ 3 turn 老 | 截到 maxTokens=500（核心）|
| L3 | ≥ 6 turn 老 | 截到 maxTokens=80（stub）|
| L4 | ≥ 10 turn 老 | **完全移除** |

兩種衰減模式（`config.contextEngine.decay.mode`）：
- `discrete`（預設）：按 `levels[]` 表階梯衰減
- `continuous`：用指數公式 `exp(-baseDecay × tempoMultiplier × age)` 算 `retainRatio`，再對照閾值表（>80% L0、>40% L1、>10% L2、>5% L3、否則 L4）

**截斷規則**（`truncateContent` / `truncateBlocks`）：
- 純文字：截至 `maxTokens × 4 chars`，附加 `[⚠️ CE 已截斷：原文 N chars，僅保留前 M chars。後續內容已丟失，勿假設完整性]` 提示
- `tool_result` blocks：個別截，rich content（圖片）+ externalized stub 不截
- `tool_use` blocks：input JSON 完整保留（裡面有 tool 呼叫 args，截了會壞）

**外部化**（`ExternalizeConfig`）：
- 超 N token 的 tool result 寫到 `<dataDir>/externalized/<sessionKey>/<msgId>.txt`，messages 內換成「`[📄 外部化] tool_result 原文 N chars，已存到 <path>`」指標
- agent 用 `read_file` 取完整內容（避免 context 被一個 large output 佔滿）
- TTL 由 `cleanupExternalized()` 定期清

### 2.2 CompactionStrategy — LLM 摘要壓縮

> Decay 衰減後若 token 仍超閾值，用 LLM 把舊訊息摘要成 4-section 結構化摘要。**有 LLM 成本**。

**觸發**：`ctx.messageTokens > triggerTokens`（預設 `20_000`）— 只看 messages，不算 sys/tools

**保留窗口**：最近 `preserveRecentTurns`（預設 8）turn 不壓縮

**摘要 4 sections**（`SummaryStructure`）：
```markdown
## Active Task
（唯一一句話的當前進行任務）

## Resolved Questions
- Q→A 配對的已解決項
- ...

## Pending Questions
- 只列問題未答的項
- ...

## Remaining Work
- 名詞描述的待辦項
- ...
```

**兩種模式**：
- `first-time`：第一次壓縮，從零生成
- `iterative`：基於上輪 `[對話摘要]` 訊息做 diff（避免反覆失真）

**過濾**：標記類訊息（`[工具索引]` / `[已壓縮]` / `[📄 外部化]` / `[user stub]` / `[對話摘要]`）不進摘要輸入

**Fallback**：無 `ceProvider` → `_fallbackSlide()` 純 sliding window（保留最近 N 條）

**Provider**：用 `opts.ceProvider`（platform 注入）或 `this._ceProvider`（`setCeProvider`）

### 2.3 OverflowHardStopStrategy — 緊急截斷

> 跑完 decay+compaction 仍超 context window 硬上限時的最後防線。

**觸發**：`ctx.estimatedTokens > cfg.contextWindowTokens`（預設 `100_000`）

**行為**：sliding window 留最近 N 條，前面的全部丟。
**設計考量**：到這層代表前兩層失效，這是「不掉資料就會撞 max tokens」的緊急處置。

---

## 3. 套用順序與互動

```
messages in
  ↓
[decay] 按年齡分層壓縮 / 移除（零 LLM）
  ↓
[compaction] 若 messageTokens 仍超 → LLM 摘要 4-section
  ↓
[overflow-hard-stop] 若還超 → 緊急 sliding window
  ↓
messages out (送給 LLM)
```

每個 strategy 套用後同步 `ctx.messageTokens / estimatedTokens`（`updateCtxTokens()`），下一個 strategy 看的是新值，**不會雙重壓縮**。

---

## 4. 觀測介面

### 4.1 Trace
`MessageTrace.contextEngineering`：
```json
{
  "strategiesApplied": ["decay", "compaction"],
  "tokensBefore": 25000,
  "tokensAfter": 8000,
  "strategyDetails": [
    {
      "name": "decay",
      "tokensBefore": 25000,
      "tokensAfter": 18000,
      "messagesDecayed": 12,
      "messagesRemoved": 3,
      "levelChanges": [
        { "messageIndex": 5, "fromLevel": 0, "toLevel": 1, "tokensBefore": 1500, "tokensAfter": 500 }
      ]
    },
    {
      "name": "compaction",
      "tokensBefore": 18000,
      "tokensAfter": 8000,
      "summaryMode": "iterative",
      "summaryStructure": { ... }
    }
  ]
}
```

### 4.2 Dashboard
Trace 列表「CE」欄位顯示：`📦 decay(-7.0K) compaction(-10.0K)`
hover tooltip：每 strategy + 每 message level 變化（msg#5: L0→L1 (1.5K→500)）

### 4.3 Log
- `[context-engine] strategy=decay applied, tokens 25000→18000`
- `[context-engine] strategy=compaction applied, tokens 18000→8000 mode=iterative`
- `[context-engine] strategy=overflow-hard-stop applied, tokens 7000→4500`

---

## 5. Tool Pairing Repair

> Decay 移除舊訊息時可能砍掉 tool_use 但保留對應 tool_result（或反之），LLM 會抱怨 unpaired。

`repairToolPairing(messages)` 在 CE 跑完後掃一次：
- 找孤立 `tool_use`（無對應 `tool_result`） → 補一個 placeholder tool_result
- 找孤立 `tool_result`（無對應 `tool_use`） → 移除該 result

修補後送 LLM，避免 422 / unpaired error。

---

## 6. Config 路徑

`catclaw.json`:
```json
{
  "contextEngine": {
    "decay": {
      "mode": "discrete",
      "levels": [...],
      "baseDecay": 0.3,
      "minRetainRatio": 0.05,
      "tempoRange": [0.5, 2.0]
    },
    "compaction": {
      "enabled": true,
      "triggerTokens": 20000,
      "preserveRecentTurns": 8,
      "model": "claude-haiku-4-5"
    },
    "overflowHardStop": {
      "enabled": true,
      "contextWindowTokens": 100000
    },
    "externalize": {
      "enabled": true,
      "minTokensToExternalize": 5000,
      "ttlDays": 7
    }
  }
}
```

對應 strategy 建構子讀 `Partial<DecayStrategyConfig>` / `Partial<CompactionConfig>` / `Partial<OverflowHardStopConfig>`，所有欄位都有 default 可省。

---

## 7. 外部化索引（External Index）

> 跑長任務（如 trend-scout / investment-daily）會產生大量 tool_result，全進 context 會撐爆。
> catclaw 把超大 tool_result 寫到 `<dataDir>/externalized/<sessionKey>/`，messages 內換成短指標。

`tool-output-store.ts` 配合 CE：
- `isExternalizedStub(content)` 判斷某 tool_result 是不是 stub（CE 不會再壓縮 stub）
- agent 用 `read_file` 取完整內容
- turn 開始前由 `injectExternalizedIndex()` 在 system prompt 加索引表，agent 知道有哪些檔可讀

---

## 8. 觸發時機（agent-loop 整合）

每次 loop 呼叫 LLM 前：
```
1. drain interrupt queue → 注入 messages
2. inject background-job results → messages.push
3. ContextEngine.build(messages, opts) → 套 CE
4. provider.stream(messages, opts) → 真正打 LLM
```

Trace 在 step 3 之後立即 snapshot `messagesBeforeCE` / `messagesAfterCE` 到 `data/trace-contexts/<date>/<traceId>.json`（lazy load，dashboard 點開 trace 才讀）。

---

## 9. 性能與成本

| Strategy | LLM 成本 | 觸發頻率（典型 session） | 壓縮率 |
|---|---|---|---|
| decay | 0 | 每次 LLM call 都跑（shouldApply 看年齡）| 30-60%（看年齡分布）|
| compaction | 高（每次 LLM call 多燒一次 Haiku） | turn ≥ 8 且 messageTokens > 20k 才觸發，~10% turn | 50-80% |
| overflow-hard-stop | 0 | 罕見（前兩層失敗才到） | 不定 |

**經驗閾值**：
- triggerTokens=20k 對 sonnet/opus 200k context 算保守
- decay maxAge=10 等於最近 10 turn 內的訊息會逐步衰減（catclaw 一次對話 turn ≈ 1-3 messages）
- compaction preserveRecentTurns=8 確保最近 8 個 turn 完整保留

---

## 10. 相關檔案

| 檔案 | 角色 |
|---|---|
| `src/core/context-engine.ts` | 本體（1278 行）|
| `src/core/context-references.ts` | 外部化引用解析 |
| `src/core/tool-output-store.ts` | 外部化檔案 IO |
| `src/core/session-snapshot.ts` | CE 壓縮前 messages 快照（`/rollback` 用）|
| `src/core/message-trace.ts` | Trace 收集 strategiesApplied / details |
| `src/core/dashboard.ts` | Trace UI 顯示 CE column |
| `src/core/agent-loop.ts` | 觸發 `ContextEngine.build()` 的地方 |

---

## 11. Rollback 機制

> CE 壓縮**有資訊損失**。每次 compaction 前 catclaw 會在 `SessionSnapshotStore` 存一份 pre-compaction snapshot。

`/rollback` skill：
- 找最近一個 `ceApplied=true` 的 snapshot
- 還原 `session.messages = snap.messages`
- 等於「撤銷 CE 壓縮」，回到壓前狀態

`/rollback --list` 列出可用快照。
`/stop` skill 內部也走 snapshot 還原 session 至 turn N 之前。

---

## 附錄：常見問題

**Q: 為何 trace 看到 `ceApplied=true` 但 tokens 沒減少？**
A: Decay 對「無壓縮可做」的 messages（短 / 新）會回傳原樣，仍計 strategiesApplied 但 tokensBefore=tokensAfter。

**Q: Compaction 用什麼 model？**
A: 由 `CompactionConfig.model` 指定（catclaw.json），預設未設 → 用 `opts.ceProvider`（platform 注入，通常是 claude-haiku-4-5）

**Q: 外部化檔案會自動清嗎？**
A: 會。`ExternalizeConfig.ttlDays` 控（預設 7 天），`cleanupExternalized()` 定期跑。

**Q: 我能停用整個 CE 嗎？**
A: 把三個 strategy `enabled=false`。但會撞 context window 上限，**不建議**。建議單獨關 compaction（保留 decay 即可大部分場景夠）。
