# CatClaw V3 計畫書：自律化 Agent 編排

> 版本：V3.1（完整版）
> 日期：2026-03-27
> 前置：V2 平台（platform-rebuild branch）已完成

---

## V3 主題：自律化（Autonomous Orchestration）

V2 建立了單一 agent 的完整執行環境。
V3 目標：**讓 agent 能自主拆解任務、派遣子 agent 分工並行執行**。

CatClaw 無 Gateway，子 agentLoop **同步等待結果**，架構比 OpenClaw 簡單。
但核心能力對齊 OpenClaw：spawn / registry / steer / kill / 附件 / 持久模式。

---

## 核心設計決策

| 決策 | 說明 |
|------|------|
| 同步等待 | 子 loop 完成才回傳，不用 announcement queue |
| allowSpawn: false | 子 agent 天生無 spawn 能力（邏輯面限制），不是 prompt 說「不行」 |
| 並行執行 | 同一輪多個 spawn_subagent → Promise.all()，時間 = max(A,B) |
| 2 層架構 | 父→子，子不可再 spawn；未來 opt-in allowNestedSpawn |
| 統一 SpawnResult | `{ status, result, sessionKey, turns }`，父永遠收到結構化結果 |

---

## SpawnResult 統一格式

```typescript
type SpawnResult =
  | { status: "completed"; result: string; sessionKey: string; turns: number }
  | { status: "timeout"; result: null }
  | { status: "error"; error: string }
  | { status: "forbidden"; reason: "no_spawn_allowed" | "max_concurrent" }
```

---

## Sprint 規劃

### S-V3-1：Subagent 核心 spawn

**目標**：LLM 能呼叫 `spawn_subagent` tool，子 loop 隔離執行並同步回傳結果，支援並行。

#### `src/core/subagent-registry.ts`（新建）

```typescript
interface SubagentRunRecord {
  runId: string
  parentSessionKey: string
  childSessionKey: string      // 格式：{parent}:sub:{uuid}
  task: string
  label?: string
  status: "running" | "completed" | "failed" | "killed" | "timeout"
  result?: string
  error?: string
  abortController: AbortController
  createdAt: number
  endedAt?: number
  keepSession: boolean         // cleanup: "keep" 時不刪 session
}

class SubagentRegistry {
  spawn(opts): SubagentRunRecord
  get(runId): SubagentRunRecord | undefined
  listByParent(parentSessionKey, recentMinutes?): SubagentRunRecord[]
  kill(runId): void
  complete(runId, result): void
  fail(runId, error): void
  timeout(runId): void
  countRunning(parentSessionKey): number
}

// max concurrent = 3（per parent session）
```

#### `src/tools/builtin/spawn-subagent.ts`（新建）

```typescript
// Tool schema
{
  name: "spawn_subagent",
  description: `產生隔離子 agent 執行指定任務，同步等待完成後回傳結果。
適合：可獨立拆解的子任務、需要隔離 context、並行加速。
不適合：一步能完成的簡單操作。
多個任務可同時呼叫（本輪多個 spawn_subagent 將並行執行）。`,
  input_schema: {
    task: string,          // 子 agent 的任務描述
    label?: string,        // 顯示名稱（列表時方便識別）
    provider?: string,     // 指定 provider ID（預設繼承父）
    maxTurns?: number,     // 最多執行幾輪（預設 10）
    timeoutMs?: number,    // 超時毫秒（預設 120000）
    keepSession?: boolean  // 完成後保留 session（debug 用，預設 false）
  }
}

// 執行流程
async function executeSpawnSubagent(params, ctx):
  1. 檢查 allowSpawn === false → { status: "forbidden", reason: "no_spawn_allowed" }
  2. 檢查 concurrent >= 3 → { status: "forbidden", reason: "max_concurrent" }
  3. 建立 childSessionKey：{parentKey}:sub:{uuid}
  4. 注入 subagent system prompt（告知角色/禁止 spawn）
  5. Promise.race(agentLoop, timeout) → 回傳 SpawnResult
  6. 完成後若 !keepSession → 刪除 child session
```

#### `src/core/agent-loop.ts` 修改

- 新增 `allowSpawn?: boolean`（預設 true）到 `AgentLoopOpts`
- spawn 子 agent 時傳入 `allowSpawn: false`（邏輯面限制，tool 清單不含 spawn_subagent）
- **並行執行**：同一輪 tool calls 中多個 `spawn_subagent` → `Promise.all()` 並行，其他 tool 串行
- 父 /stop 觸發時，linked abort 傳給所有子的 AbortController

**System prompt（subagent 模式）**
```
你是一個專門執行子任務的 agent。請完成以下任務並回傳結果。
你沒有 spawn_subagent 工具。如需拆解，請在自己的 turns 內完成。
任務：{task}
```

**通過條件**
- [ ] 父 agent 呼叫 spawn_subagent → 子 loop 執行完畢 → 父收到 SpawnResult
- [ ] 子 agent 工具清單不含 spawn_subagent（邏輯確認）
- [ ] 同一輪 2 個 spawn_subagent → 並行執行，時間 < 串行總和
- [ ] timeout → `{ status: "timeout" }`，不 crash
- [ ] concurrent 超限 → `{ status: "forbidden", reason: "max_concurrent" }`
- [ ] 父 /stop → 子 AbortController 觸發
- [ ] TypeScript 編譯無錯誤

---

### S-V3-2：管理工具（list / kill / steer）+ cleanup + /subagents Skill

**目標**：LLM 與使用者都能查看、終止、轉向子 agent；支援 keepSession debug。

#### `src/tools/builtin/subagents.ts`（新建）

```typescript
{
  name: "subagents",
  description: "管理目前的子 agent：列出、終止、或發送新指令轉向",
  input_schema: {
    action: "list" | "kill" | "steer",
    runId?: string,          // kill/steer 指定 runId，kill 省略 = kill all
    message?: string,        // steer 用：發給子 agent 的新指令
    recentMinutes?: number   // list 回溯視窗（預設 30，最大 1440）
  }
}

// list 回傳：runId, label, status, task 前 80 字, 執行秒數, provider
// kill 回傳：killed count
// steer：向子 agent session 注入新 user message（append to session history）
//        子 agent 下一個 turn 會看到新指令
```

**steer 機制**：透過 `SessionManager.append(childSessionKey, { role: "user", content: message })` 注入，子 loop 在下一輪自然讀到。

#### `src/skills/builtin/subagents.ts`（新建）

```typescript
// /subagents [kill <runId>] [steer <runId> <message>]
// 無參數 → 列出目前所有子 agent（表格格式）
// /subagents kill <runId> → 終止指定子 agent
// /subagents kill all → 終止所有子 agent
```

#### `catclaw.json` 新增 `subagents` 設定

```jsonc
"subagents": {
  "maxConcurrent": 3,          // per parent session 最大並行數
  "defaultTimeoutMs": 120000,  // 預設超時 2 分鐘
  "defaultKeepSession": false  // 完成後是否保留 session
}
```

**通過條件**
- [ ] `/subagents` Discord 回覆子 agent 狀態表（runId / label / status / 執行時間）
- [ ] `/subagents kill <runId>` 成功終止，AbortController 觸發
- [ ] `/subagents kill all` 終止所有 running 子 agent
- [ ] `subagents(action:"steer")` 注入後子 loop 下一輪收到指令
- [ ] `keepSession: true` spawn → 完成後 session 保留，可 `/sessions` 查看
- [ ] `keepSession: false`（預設）→ session 完成後自動清除

---

### S-V3-3：多 Provider 子 agent + Workspace 繼承 + 附件傳遞

**目標**：子 agent 可指定不同 provider；共享父工作目錄；spawn 時可附帶資料。

#### `spawn_subagent` 加強

```typescript
{
  provider?: string,          // 如 "codex"（ProviderRegistry 解析）
  workspaceDir?: string,      // 預設繼承父的 workspaceDir
  attachments?: Array<{       // 隨 task 附帶的資料
    name: string,
    content: string,
    encoding?: "utf8" | "base64"
  }>
}
```

#### `AgentLoopOpts` 加入 `workspaceDir`

- 傳給 read-file / write-file 工具，以此路徑為根目錄
- 子 agent 繼承父的路徑，共用檔案空間

#### 附件處理

- `attachments` 在 spawn 前寫入 `{workspaceDir}/attachments/{uuid}/`
- 注入 subagent system prompt 尾部：`可用附件：{name1}, {name2}（位於 attachments/{uuid}/）`
- 完成後若 `keepSession: false` → 一併清除 attachments 目錄

#### 使用場景驗證

```
使用者：「幫我分析 error.log 並修好問題」
→ 父 agent：讀 log → 拆解任務
  → 子 A（claude-api + log 附件）：分析原因
  → 子 B（codex）：產生修正程式碼
→ 父 agent：彙整 → 回報使用者
```

**通過條件**
- [ ] `provider: "codex"` 子 agent 確實使用 CodexOAuthProvider
- [ ] 子 agent 能讀寫父設定的 workspaceDir
- [ ] 兩個子 agent 並行，時間 < 串行總和（timer 驗證）
- [ ] attachments 寫入正確路徑，子 agent system prompt 含附件說明
- [ ] keepSession: false 時 attachments 目錄清除

---

## 新增檔案清單

```
src/core/subagent-registry.ts         新建
src/tools/builtin/spawn-subagent.ts   新建
src/tools/builtin/subagents.ts        新建
src/skills/builtin/subagents.ts       新建
```

## 修改檔案清單

```
src/core/agent-loop.ts       加 allowSpawn / workspaceDir / 並行 tool 執行
src/core/config.ts           加 SubagentsConfig
src/core/platform.ts         初始化 SubagentRegistry 全域單例
src/tools/registry.ts        註冊 spawn-subagent / subagents tools
src/skills/registry.ts       註冊 /subagents skill
~/.catclaw-test/catclaw.json 加 subagents 設定區塊
```

---

## 依賴關係

```
S-V3-1（核心 spawn + 並行）
    ↓
S-V3-2（list/kill/steer + keepSession + /subagents skill）
    ↓
S-V3-3（multi-provider + workspace + attachments）
```

---

## 與 OpenClaw 功能對照

| OpenClaw 功能 | V3 對應 | Sprint |
|--------------|---------|--------|
| sessions_spawn | spawn_subagent tool | SUB-1 |
| SubagentRegistry | SubagentRegistry | SUB-1 |
| 並行執行 | Promise.all() 並行 tool | SUB-1 |
| 深度限制 | allowSpawn: false（邏輯面） | SUB-1 |
| timeout | Promise.race + AbortController | SUB-1 |
| subagents list/kill | subagents tool + /subagents skill | SUB-2 |
| steer | subagents(action:"steer") | SUB-2 |
| cleanup: keep | keepSession: true | SUB-2 |
| multi-provider | provider 參數 | SUB-3 |
| workspace 繼承 | workspaceDir 繼承 | SUB-3 |
| attachments | attachments 寫檔 + prompt 注入 | SUB-3 |
| mode: session（持久） | ❌ 不實作（V3.x） | — |
| 完成通知 Discord | ❌ 不實作（V3.x，需改非同步） | — |
| ACP runtime | ❌ 不適用（CatClaw 無 ACP） | — |

---

## V3.x 未來方向

| 功能 | 說明 |
|------|------|
| 持久子 agent | mode: "session"，完成後 session 保留，使用者可後續對話 |
| 完成通知 Discord | 長任務完成後自動 push 到頻道（需改非同步 announcement） |
| Cron + subagent | 排程任務自動 spawn 子 agent 執行 |
| Subagent 結果寫入記憶 | 完成結果存入 MemoryEngine |
| allowNestedSpawn | opt-in 開放子 agent 再 spawn（多層架構） |
| Vector search 啟用 | memory recall 的 vectorSearch: true（Ollama 必須在線）|

---

## V2 → V3 差異總覽

| 層次 | V2 | V3 |
|------|----|----|
| 執行模式 | 單一 agent loop | 父 + 子（2 層，父 spawn，子不可 spawn） |
| Provider | 多 provider 路由 | 每個子 agent 可獨立指定 provider |
| Session | 單一 session per channel | parent + child（隔離，完成後清理） |
| 並行 | 無 | 同一輪多個 spawn_subagent 並行 |
| 使用者操控 | /stop /rollback /queue /turn-audit | + /subagents list/kill |
| LLM 操控 | 無子 agent 管理 | subagents tool（list/kill/steer） |
| 資料傳遞 | prompt 文字 | prompt + attachments 檔案 |
| Context 隔離 | CE 壓縮 | 子 agent 獨立 context，父不受污染 |
