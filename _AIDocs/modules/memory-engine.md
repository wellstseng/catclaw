# modules/memory-engine — 記憶引擎（global + project + account + agent）

> 檔案：`src/memory/engine.ts` + `src/memory/` 子模組
> 更新日期：2026-11-06

## 職責

組裝所有 memory 子模組，對外提供 MemoryEngine 介面。
生命週期：`init()` → `recall/extract/write` → `shutdown()`

## 子模組

| 檔案 | 職責 |
|------|------|
| `engine.ts` | 主引擎：初始化 + API facade |
| `recall.ts` | Vector-First recall：keyword 快篩 → vector → 純 cosine 排序 + keyword 微調（5 步管線） |
| `memory-api.ts` | Memory 管理 API：atom CRUD + recall-test + stats（供 Dashboard 使用） |
| `extract.ts` | 知識萃取：從對話中提取 KnowledgeItem |
| `consolidate.ts` | 整合：promotion / archive / ACT-R decay（與 recall 共用 `computeActivation()`） |
| `context-builder.ts` | Context 組裝：budget 截斷（ACT-R/層級預算已移除） |
| `atom.ts` | Atom CRUD：讀寫 markdown atom 檔案 |
| `write-gate.ts` | 寫入閘門：dedup（餘弦相似度閾值）＋威脅掃描＋敏感字眼（`findSensitiveWords`） |
| `usefulness.ts` | 效用帳：送出去的卡有沒有被用上、用上後回合成不成功 → access.json 三欄＋帳本＋報表 |
| `atom-access.ts` | `<atom>.access.json` 遙測讀寫（曝光 read_hits／timestamps、confirmations、效用三欄） |
| `index-manager.ts` | MEMORY.md 索引管理 |
| `episodic.ts` | Episodic memory：session 統計 + rut 偵測 + TTL 清理 |
| `session-memory.ts` | Session note：per-channel 對話筆記（Ollama 萃取） |

## 目錄結構

```
{memoryRoot}/
  ├── *.md                   — 全域 atom
  ├── MEMORY.md              — 索引
  ├── projects/{projectId}/  — 專案層 atom
  ├── accounts/{accountId}/  — 個人層 atom
  ├── episodic/              — episodic memory
  └── _vectordb/             — LanceDB 向量資料庫

~/.catclaw/workspace/agents/{agentId}/memory/  — agent 專屬記憶
```

### 記憶四層結構

| 層 | namespace | 目錄 | 用途 |
|---------|---------------|--------------------------------------|--------------------------|
| global  | `global`      | `{memoryRoot}/`                      | 平台共用知識             |
| project | `project/{id}`| `{memoryRoot}/projects/{id}/`        | 專案知識（暫停用）       |
| account | `account/{id}`| `{memoryRoot}/accounts/{id}/`        | 使用者偏好/個人資訊      |
| agent   | `agent/{id}`  | `~/.catclaw/workspace/agents/{id}/memory/`     | agent 專屬記憶           |

Recall 範圍 = global + account(當前使用者) + agent(若有 agentId)。
寫入：agent context 下寫入 agent 層。

## MemoryEngine API

### 生命週期

```typescript
init(): Promise<void>     // 初始化 vector service + 確保目錄
shutdown(): Promise<void>  // 關閉 vector service
```

### Recall

```typescript
recall(
  prompt: string,
  ctx: RecallContext,
  overrides?: { vectorSearch?: boolean; vectorTopK?: number }
): Promise<RecallResult>
```

RecallResult：
- `fragments: AtomFragment[]` — 命中的 atom 片段
- `blindSpot: boolean` — 所有層均無命中時為 true（Blind-Spot 警告）
- `degraded: boolean` — vector service 離線時走 keyword fallback（固定分數 0.5）

### Context 組裝

```typescript
buildContext(
  fragments: AtomFragment[],
  prompt: string,
  budget = 2000,
  _ratios?: { global: number; project: number; account: number },
  blindSpot = false
): ContextPayload
```

ContextPayload：
- `text: string` — 注入到 system prompt 的文字
- `tokenCount: number` — 估算 token 數
- `layerCounts: Record<MemoryLayer, number>` — 各層 fragment 數量（global/project/account/agent）
- `blindSpotWarning?: string` — BlindSpot 警告字串（若有）

### 萃取

```typescript
/** 逐輪萃取（fire-and-forget）— engine 自動注入 maxItems + cooldownMs from config */
extractPerTurn(
  newText: string,
  opts: ExtractOpts
): Promise<KnowledgeItem[]>
```

### 寫入閘門

```typescript
checkWrite(content: string, namespace: string, bypass = false): Promise<WriteGateResult>
```

WriteGateResult：
- `allowed: boolean`
- `reason: "bypass" | "injection" | "duplicate" | "ok"`
- `similarity?: number` — dedup 比對相似度（duplicate 時有值）

`bypass=true` 跳過 gate，但真實 token／私鑰照擋（記憶會被注入送給模型供應商）。LLM 端透過 `atom_write` tool 的 `bypass` 參數觸發；agent 應依使用者明確指令（「記住 / 記下來 / 強制存 / 覆蓋記憶」）才填 true，autonomous 自主寫入維持 false。

真實 token 格式：`sk-`、`sk-ant-`、JWT 三段式、`gh[pousr]_`、`github_pat_`、`glpat-`、`AKIA`、`xox?-`、各式 `BEGIN … PRIVATE KEY`。

敏感字眼（`findSensitiveWords`，對拍 ~/.claude `lib/sensitive_gate.py`）：密碼／私鑰／金鑰／憑證／api key／access token、身分證、手機號碼、信用卡、銀行帳號、住家地址、薪資、內網 IP（10.x、172.16–31.x、192.168.x）、共用資料夾（`\\host\share`、`//host/share`）。排除「密碼學」「1Password」、協定相對網址（`src="//cdn…"`）、前後接數字或點的 IP 樣式。只回報不擋；背景萃取（`workflow/memory-extractor.ts decideExtractLayer`，內容＋觸發詞一起判）命中時 global／project 層改寫 account 層——沒人能判斷該不該公開，就不放進所有使用者都撈得到的層；累積的那段對話有不只一人發言（群組）→ 分不出是誰的資訊，不寫。

擋下真實 token／私鑰時 `reason` 回 `secret`（混有 prompt injection 才回 `injection`）；JWT 樣式要 `eyJ` 開頭，長套件名三段式不再被當 token。

### Seed & Rebuild

```typescript
seedFromDir(
  dir: string,
  namespace: string
): Promise<{ seeded: number; skipped: number; errors: number }>
```

掃描記憶目錄下所有 atom `.md` 檔，嵌入並寫入 LanceDB。
用途：首次安裝或手動複製 atom 後補跑 embedding。
排除：`_vectordb`、`episodic`、`_staging`、`_reference` 目錄和 `MEMORY.md`。

```typescript
rebuildIndex(namespace: string): Promise<void>
```

重建指定 namespace 的向量索引（呼叫 VectorService.rebuild）。

### 狀態

```typescript
getStatus(): MemoryStatus
```

## Recall — Vector-First 5 步管線

```
recall(query)
  1. Cache 檢查（Jaccard ≥ 0.7, 60s TTL）
  2. Keyword 快篩（MEMORY.md trigger match）→ 微調加分用
  3. Embed query → vector（失敗 → keyword fallback）
  4. Vector search（各層並行，code defaults topK=8 / minScore=0.55，config defaults topK=10 / minScore=0.65 覆寫）（失敗 → keyword fallback）
  5. Merge + dedup + keyword 微調 + touchAtom + cache + return
```

### Keyword Fallback（向量不可用兜底）

Step 3 embed 或 Step 4 vector search 失敗時，自動退化為純 keyword 路徑：

- 以 Step 2 的 `keywordHits` 為來源
- `readAtom()` 讀取 atom → 固定分數 0.5
- 回傳 `degraded: true`，下游 trace 可見

### AtomFragment.matchedBy

| 值 | 來源 |
|------|------|
| `"vector"` | 正常向量搜尋命中 |
| `"keyword"` | keyword fallback 命中 |

### 常數

| 常數 | 值 | 說明 |
|------|------|------|
| `KEYWORD_BONUS` | 0.05 | keyword trigger 命中微調加分 |

## Context Builder

- **Budget**：函式預設 `budget = 2000`，config 預設 `contextBudget = 3000`（呼叫端由 config 傳入覆寫）。無層級分配（`contextBudgetRatio` 已定義但 context-builder 內未使用）
- 按 vector score 排序，超出 budget 截斷
- **Atom 過肥偵測**：若單顆 atom 本身就超過 budget（首顆且 blockTokens > budget），發 `log.warn` 建議拆分為多個較小的原子單元

## 設定（MemoryConfig）

| 欄位 | 預設 | 說明 |
|------|------|------|
| `enabled` | true | 開關 |
| `root` | `{catclawDir}/memory` | 記憶根目錄 |
| `vectorDbPath` | `{root}/_vectordb` | 向量 DB 路徑 |
| `contextBudget` | 3000 | 注入 token 上限 |
| `writeGate.enabled` | true | 寫入閘門開關 |
| `writeGate.dedupThreshold` | 0.80 | 去重閾值 |
| `recall.vectorSearch` | true | 是否啟用向量搜尋 |
| `recall.vectorMinScore` | 0.65 | 向量最低相關度 |
| `recall.vectorTopK` | 10 | 向量 top-K |
| `extract.enabled` | true | 萃取功能開關 |
| `extract.perTurn` | true | 累積 flush 時是否跑萃取（關閉 = 全面停用） |
| `extract.maxItemsPerTurn` | 3 | 單次 flush 最多萃取幾條（非每 turn） |
| `extract.accumCharThreshold` | 200 | 累積字元閾值（達到後觸發萃取） |
| `extract.accumTurnThreshold` | 5 | 累積 turn 閾值 |
| `extract.cooldownMs` | 120000 | 同 session 萃取冷卻時間（ms） |
| `memoryPipeline.extraction.model` | (from ollama config) | 萃取用 LLM 模型（extract.ts doExtract 讀取此值傳給 Ollama） |

## 全域單例

```typescript
initMemoryEngine(cfg): MemoryEngine
getMemoryEngine(): MemoryEngine  // throw on null
```

由 `platform.ts` 步驟 9 初始化。

## Episodic Memory（`episodic.ts`）

Session 自動摘要，記錄修改/閱讀軌跡與覆轍信號。

### 觸發

`session:idle` / `platform:shutdown` 事件。

### 生成門檻

- `modifiedFiles ≥ 1` 且 session 持續 `≥ 2min`
- 或 `readFiles ≥ 5`

### 覆轍偵測（RutWarning）

| type | 條件 | 說明 |
|------|------|------|
| `same_file_3x` | 同一檔案修改 ≥ 3 次 | 可能在打轉 |
| `retry_escalation` | retryCount ≥ 2 | 建議啟動 Fix Escalation |

### 跨 Session 覆轍掃描

```typescript
detectRutPatterns(episodicDir, currentFile?): RutWarning[]
```

掃描近期 10 個 episodic，找到跨 session 反覆出現的同一檔案修改或 retry escalation（各需 ≥ 2 次）。
由 Workflow Guardian 在 session 啟動時注入警告。

### TTL

預設 24 天，`cleanExpired()` 在每次生成前自動清理過期檔案。

### API

```typescript
generateEpisodic(stats: SessionStats, opts: EpisodicOpts): Promise<string | null>
detectRutPatterns(episodicDir: string, currentFile?: string): RutWarning[]
```

## Session Memory（`session-memory.ts`）

對話中自動抄筆記（參考 Claude Code SessionMemory）。

### 機制

- **觸發**：每 `intervalTurns` 輪（預設 10）
- **萃取**：最近 `maxHistoryTurns` 輪（預設 15）→ Ollama chat → 摘要筆記
- **儲存**：`{memoryDir}/_session_notes/{channelId後8碼}.md`（覆寫，保留最新）
- **注入**：turn 開始前讀取，前置到 system prompt

### API

```typescript
getSessionNote(memoryDir, channelId): string | null           // 讀取筆記（供 prompt 注入）
checkAndSaveNote(channelId, turnCount, messages, memoryDir, opts): Promise<void>  // fire-and-forget 萃取
```

## Hook 整合

`MemoryEngine.recall()` 執行後觸發 **MemoryRecall** hook（observer），附 query / hitCount / durationMs。

## 效用帳（`usefulness.ts`）

回答「送出去的卡有沒有幫上忙」。晉升（`consolidate.ts`）目前只看被撈次數，撈得多不代表有用；這本帳記「用上」與「用上之後的結果」，報表分出有用的卡、常被撈卻沒用上的卡。對拍 ~/.claude 效用歸因（`hooks/handlers/stop.py _attribute_usefulness`），依 catclaw 改三處（判用扣掉使用者原句的詞、結果訊號、送卡單位）。

### 一回合的流程

| 時機 | 做什麼 |
|------|--------|
| 送卡 | agent-loop 3b 每回合用**自己的 sessionKey** 呼一次 `noteTurnAtoms()`：呼叫端（pipeline）注入記憶時帶 `memoryInjectedByCaller.atoms`，只認這份名單（exclusive）；用凍結區塊時效用帳自己向 `session-snapshot` 拿 `memoryAtoms`；即時撈的用 `buildContext().includedAtoms`（預算用完沒放進去的不算）。pipeline 的 sessionKey 在 autoThread、Dashboard 對話、綁定子 agent 時跟 agent-loop 不同，所以不由 pipeline 登記 |
| `turn:after` | 每張卡判用 → 用上的 `used_count +1`、帳本記 `turn`；回合內已有 `workflow:rut`／`workflow:retry_escalation` → 直接結算失敗；否則掛「待結算」（每個 session 只留最新一回合；最新回合沒用上卡 → 前一筆作廢） |
| 使用者下一句（`discord.ts` → `noteUserMessage`） | 開頭 45 字內、不帶「嗎」的子句有糾正詞 → 失敗（排除不對稱／不對外、「我搞錯了」這種自責）；40 字內、不帶轉折與問句的肯定 → 成功；其他 → 判不出（記 unknown、不動分數）。bot 的訊息不算；**群組裡只認問那回合的同一人**（別人說話不判、待結算留著）。綁定子 agent 的 thread 用子 agent 的 sessionKey |
| reaction（`discord.ts messageReactionAdd` → `noteReaction`） | 對 bot 回覆按 👍✅❤️💯🙏🎉👏👌 → 成功、👎❌😡🙅🚫⛔ → 失敗；只認待結算那回合開始後送出的訊息、非 bot 按的、同一人按的 |
| 結算 | 成功 `useful_hits +1`、失敗 `used_fail +1`（先驗 1，同 ~/.claude），帳本記 `outcome` |

待結算放 6 小時；`session:end` 清狀態。

### 判用（`detectAtomUse`）

卡片本文（去標題與 `- Key:` 欄位行）抽識別詞：程式識別碼／路徑片段（≥5 字或含 `_ . 數字 / -`）＋中文雙字，去停用詞與路徑噪音，**再扣掉使用者這句話也有的詞**（卡是因為這些詞才被撈出來，AI 複述題目不算用上）。跟 AI 回覆共享數 ≥ need 才算用上：need = 識別詞一半夾在 3～6，且不少於識別詞的 15%；識別詞不到 3 個的卡永遠不判。

校準（2026-11-06 唯讀回放 100 個真實回合、972 次送卡）：沒有 15% 下限時判用上 84 次，抽看明確誤判都是上百詞的長卡撞泛用雙字；加下限後 33 次，抽看約 85–90% 是真的照卡片回答。使用者訊息 2525 則：判糾正 22（抽看都是真糾正）、判肯定 1——**成功訊號主要靠 👍 reaction**。

### 帳本與報表

- 帳本：`<workspace>/data/workflow/memory-usefulness.ndjson`，append-only，一行一筆 `{ts, kind: "turn"|"outcome", sessionKey, …}`；`turn` 的 `candidates` 是那回合在 prompt 裡的卡名名單
- `access.json` 三欄：`used_count`（判用上次數）、`useful_hits`（α）、`used_fail`（β）；舊檔讀取時補 0／1／1，任何寫入原樣保留
- `buildEffectReport(roots)`（Dashboard `GET /api/memory/effect-report`、記憶分頁「效用帳」卡）：有用的卡（Wilson 下界 z=1.28 排序）、在 prompt 裡 ≥5 回合卻 0 次用上（token 稅）、近 30 天沒被撈過。「在 prompt 回合」從帳本 `candidates` 算（凍結卡每回合都送＝每回合都付 token），不用 access.json 的 timestamps——那是 recall 階段就記，預算用完沒放進 prompt 的卡也算在內；「沒被撈過」才看 timestamps
- 晉升條件目前不吃這本帳；累積兩週數據後再決定要不要把 consolidate 從「被撈 ≥3 次」換成看有用率
