# CatClaw V3 計畫書：自律化 Agent 編排

> 版本：V3.0 草稿
> 日期：2026-03-27
> 前置：V2 平台（platform-rebuild branch）已完成，包含 AgentLoop / Provider / CE / Session 系統

---

## V3 主題：自律化（Autonomous Orchestration）

V2 建立了單一 agent 的完整執行環境。
V3 目標：**讓 agent 能自主拆解任務、派遣子 agent 分工執行**。

參考來源：OpenClaw `sessions_spawn` + `subagent-registry` + `subagent-announce` 機制，
但 CatClaw 無 Gateway，採**同步等待 + 直接結果回傳**，架構大幅簡化。

---

## 核心新增能力

| 能力 | 說明 |
|------|------|
| `spawn_subagent` tool | LLM 呼叫此工具產生隔離子 agent，傳入 task，等待結果 |
| SubagentRegistry | in-memory 追蹤 runId / depth / status / abort |
| `subagents` tool | LLM 用來 list / kill 自己的子 agent |
| `/subagents` skill | 使用者查看目前子 agent 狀態，可手動 kill |
| 多 provider 子 agent | 父走 claude-api，子可指定 codex 或其他 provider |
| Workspace 繼承 | 子 agent 繼承父的工作目錄，共用檔案存取 |

---

## Sprint 規劃

### S-V3-1：Subagent 核心 spawn

**目標**：LLM 能呼叫 `spawn_subagent` tool，子 loop 隔離執行並同步回傳結果。

**包含**：

#### `src/core/subagent-registry.ts`（新建）
```typescript
interface SubagentRunRecord {
  runId: string
  parentSessionKey: string
  childSessionKey: string     // 格式：{parent}:sub:{uuid}
  task: string
  label?: string
  status: "running" | "completed" | "failed" | "killed"
  depth: number               // spawn 層數（從 0 開始）
  result?: string             // 完成時的回傳文字
  abortController: AbortController
  createdAt: number
  endedAt?: number
}

// 限制：maxDepth = 3，maxConcurrent = 3（per parent session）
class SubagentRegistry {
  spawn(opts): SubagentRunRecord
  get(runId): SubagentRunRecord | undefined
  listByParent(parentSessionKey): SubagentRunRecord[]
  kill(runId): void
  complete(runId, result): void
  fail(runId, error): void
}
```

#### `src/tools/builtin/spawn-subagent.ts`（新建）
```typescript
// Tool schema
{
  name: "spawn_subagent",
  description: "產生隔離的子 agent 執行指定任務，同步等待結果",
  input_schema: {
    task: string,           // 子 agent 的任務描述
    label?: string,         // 顯示名稱（方便追蹤）
    provider?: string,      // 指定 provider ID（預設繼承父）
    maxTurns?: number,      // 最多執行幾輪（預設 10）
    timeoutMs?: number      // 超時毫秒（預設 120000）
  }
}

// 執行流程
async function executeSpawnSubagent(params, ctx):
  1. 檢查 depth >= 3 → 回傳 forbidden
  2. 檢查 concurrent >= 3 → 回傳 forbidden
  3. 建立隔離 session key：{parentKey}:sub:{uuid}
  4. 注入 subagent system prompt（告知角色/深度/禁止再 spawn self）
  5. 呼叫 agentLoop(task, { sessionKey: childKey, spawnDepth: depth+1 })
  6. 等待完成 → 回傳 { status, result, sessionKey, turns }
```

#### `src/core/agent-loop.ts` 修改
- 新增 `spawnDepth?: number` 到 `AgentLoopOpts`
- depth >= 3 時，tool 清單過濾掉 `spawn_subagent`
- subagent 的 session 完成後自動清理（不保留 history）

**通過條件**
- [ ] 父 agent 呼叫 spawn_subagent → 子 loop 執行完畢 → 父收到結果字串
- [ ] depth 超限（>=3）回傳 `{ status: "forbidden", reason: "max_depth" }`
- [ ] concurrent 超限回傳 `{ status: "forbidden", reason: "max_concurrent" }`
- [ ] 子 agent timeout → 父收到 `{ status: "timeout" }` 不 crash
- [ ] TypeScript 編譯無錯誤

---

### S-V3-2：管理工具 + /subagents Skill

**目標**：使用者與 LLM 都能管理子 agent。

**包含**：

#### `src/tools/builtin/subagents.ts`（新建）
```typescript
// LLM 呼叫的管理 tool
{
  name: "subagents",
  input_schema: {
    action: "list" | "kill",
    runId?: string,          // kill 指定 runId，或省略 kill all
    recentMinutes?: number   // list 的回溯視窗（預設 30）
  }
}
// list 回傳：runId, label, status, depth, task 前 80 字, 執行秒數
// kill 回傳：killed count
```

#### `src/skills/builtin/subagents.ts`（新建）
```typescript
// 使用者 slash command：/subagents [kill <runId>]
// 無參數 → 列出目前所有子 agent（同 LLM list）
// kill <runId> → 終止指定子 agent
```

#### `catclaw.json` 新增 `subagents` 區塊
```jsonc
"subagents": {
  "maxDepth": 3,
  "maxConcurrent": 3,
  "defaultTimeoutMs": 120000,
  "inheritProvider": true     // 子 agent 預設繼承父的 provider
}
```

**通過條件**
- [ ] `/subagents` 在 Discord 回覆目前子 agent 狀態表
- [ ] `/subagents kill <runId>` 成功終止，回報已 killed
- [ ] kill 後子 loop 的 AbortSignal 觸發，不留懸空 session
- [ ] LLM 呼叫 `subagents(action:"list")` 能看到 running 子 agent

---

### S-V3-3：多 Provider 子 agent + Workspace 繼承

**目標**：子 agent 可指定不同 provider；共享父的工作目錄。

**包含**：

#### `spawn_subagent` 加強
```typescript
{
  provider?: string    // 如 "codex"（從 ProviderRegistry 解析）
  workspaceDir?: string // 預設繼承父的 workspaceDir
}
```

#### `AgentLoopOpts` 加入 `workspaceDir`
- 傳給工具（read-file / write-file 用此路徑為根目錄）
- 子 agent 繼承時路徑不變，共享父的檔案空間

#### 使用場景驗證
```
使用者：「幫我分析 log 並修好錯誤」
→ 父 agent（claude-api）：拆解任務
  → 子 agent A（claude-api）：分析 log
  → 子 agent B（codex）：產生修正程式碼
→ 父 agent：彙整結果回報使用者
```

**通過條件**
- [ ] `spawn_subagent(task, provider:"codex")` 確實使用 CodexOAuthProvider
- [ ] 子 agent 能讀寫父設定的 workspaceDir
- [ ] 兩個子 agent 並行執行（Promise.all），時間小於串行總和

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
src/core/agent-loop.ts       加 spawnDepth / workspaceDir
src/core/config.ts           加 SubagentsConfig
src/core/platform.ts         初始化 SubagentRegistry 全域單例
src/tools/registry.ts        註冊 spawn-subagent / subagents tools
src/skills/registry.ts       註冊 /subagents skill
~/.catclaw-test/catclaw.json 加 subagents 設定區塊
```

---

## 依賴關係

```
S-V3-1（核心 spawn）
    ↓
S-V3-2（管理工具）   ← 可與 S-V3-1 部分平行（registry 完成後）
    ↓
S-V3-3（multi-provider + workspace）
```

---

## V3 後的可能方向（V3.x）

| 功能 | 說明 |
|------|------|
| Cron + subagent | 排程任務自動 spawn 子 agent 執行 |
| Subagent 結果持久化 | 完成的子 agent 結果寫入記憶系統 |
| Streaming 回傳 | 子 agent 執行中即時推送進度到 Discord |
| `steer` 控制 | 父在子執行中注入指令（OpenClaw steer 機制） |
| Vector search 啟用 | 開啟 memory recall 的 vectorSearch:true（Ollama 必須在線）|

---

## 與 V2 差異總覽

| 層次 | V2 | V3 |
|------|----|----|
| 執行模式 | 單一 agent loop | 父 + 子 agent 多層 |
| Provider | 多 provider 路由 | 每個子 agent 可獨立指定 provider |
| Session | 單一 session per channel | parent session + child session（隔離） |
| 使用者操控 | /stop /rollback /queue | + /subagents list/kill |
| Context | CE 壓縮 | 子 agent 獨立 context，父不受污染 |
