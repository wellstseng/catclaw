# CatClaw WIKI

> Codex 版 Claude Code CLI + 多人 AI 開發平台
> 最近更新：2026-06-08

---

## 目錄

1. [快速入門](#1-快速入門)
2. [架構總覽](#2-架構總覽)
3. [設定指南](#3-設定指南)
4. [功能指南](#4-功能指南)
5. [部署與維運](#5-部署與維運)
6. [常見陷阱](#6-常見陷阱)
7. [模組索引](#7-模組索引)

---

## 1. 快速入門

### CatClaw 是什麼

CatClaw 是一套以 Discord 為前端的多人 AI 開發平台，提供等同 Claude Code 的完整開發能力：
multi-turn agent loop、30 builtin tools、46 builtin skills、36-event hook 系統、多 provider failover、
四層記憶引擎、Context Engineering、subagent 編排、帳號/角色/權限系統、Web Dashboard。

### 一鍵安裝

```bash
git clone git@github.com:wellstseng/catclaw.git
cd catclaw
bash setup.sh
```

`setup.sh` 自動完成：前置檢查（Node.js >= 18、pnpm、PM2）→ 安裝依賴 → 建立 `.env` → 初始化目錄 → Admin 帳號設定（Discord User ID → platform-owner）→ 互動設定 Discord Token + 頻道 + API Key → 功能開關 → 編譯 + PM2 啟動。

### 手動安裝

```bash
git clone git@github.com:wellstseng/catclaw.git && cd catclaw
pnpm install
cp .env.example .env
./catclaw init    # 自動複製 catclaw.example.json → ~/.catclaw/catclaw.json
# 編輯 ~/.catclaw/catclaw.json：填入 discord.token
pnpm build
./catclaw start
```

### 最小設定

`catclaw.json` 最少只需填：

```jsonc
{
  "discord": {
    "token": "your_discord_bot_token_here",
    "guilds": {}  // 空物件 = 全部頻道允許，需 @mention 觸發
  }
}
```

### 驗證上線

```bash
./catclaw status   # PM2 狀態
./catclaw logs     # 即時 log
```

Bot 上線後 log 顯示 `[bridge] 已上線：BotName#0000`。
在 Discord 頻道發送 `@BotName ping` 確認回應。

---

## 2. 架構總覽

### 資料流圖

```
Discord Gateway
      |  messageCreate
      v
[discord.ts] 訊息過濾 + debounce(500ms) + 附件下載
      |
      +-- Skill 攔截？ --> 是 --> skill.execute() --> 回覆 --> 結束
      |
      v  否
[message-pipeline.ts] 統一訊息管線
      |  Memory Recall --> Intent Detection --> System Prompt 組裝
      v
[agent-loop.ts] 核心 Agent Loop
      |  LLM 呼叫 --> tool_use --> 執行 tool --> 結果回填 --> 迴圈至 end_turn
      |  Output Token Recovery（截斷自動續接 x3）
      |  Auto-compact（Context Engineering 壓縮）
      v
[reply-handler.ts] Streaming 回覆
      |  live-edit 模式 / chunk fallback / fileMode 上傳
      v
Discord 訊息
```

### 核心子系統

| 子系統 | 說明 |
|--------|------|
| **Agent Loop** | 一軌制：CatClaw 控制所有 tool，LLM 只負責思考 |
| **Provider** | Claude API / Ollama / OpenAI-compat / ACP CLI，failover + circuit-breaker |
| **Memory** | 四層記憶引擎（Global / Project / Account / Agent）+ LanceDB 向量搜尋 |
| **Context Engine** | 3 策略：decay（漸進衰減+外部化）→ compaction（結構化摘要+意圖錨點）→ overflow-hard-stop |
| **Session** | Per-channel 串行佇列 + 磁碟持久化 + TTL |
| **Accounts** | 5 級角色（guest → platform-owner）+ Tool Tier 物理移除 |
| **Tools** | 30 builtin tools + MCP tool 自動整合 |
| **Skills** | 46 builtin skills（37 command-type + 9 prompt） |
| **Dashboard** | Web 監控面板 + REST API + Web Chat |
| **Cron** | 排程服務（cron/every/at）+ 4 種動作型別 |
| **Hooks** | 36 events（10 類）+ folder-convention 掛載 + fs.watch 熱重載 + TS/JS/sh/ps1 多 runtime + defineHook SDK + FileWatcher |
| **Safety** | 安全攔截 + 協作衝突偵測 |

### 目錄結構

```
catclaw/                          <- 程式碼
├── src/
│   ├── core/                     核心模組（agent-loop, session, dashboard...）
│   ├── providers/                LLM Provider 抽象層
│   ├── tools/                    30 builtin tools
│   ├── skills/                   46 builtin skills
│   ├── memory/                   四層記憶引擎
│   ├── accounts/                 帳號/角色/權限
│   ├── hooks/                    Hook 系統
│   ├── mcp/                      MCP 整合
│   ├── vector/                   向量搜尋（LanceDB）
│   ├── workflow/                 工作流自動化
│   └── safety/                   安全守衛
├── catclaw.js                    跨平台管理腳本
└── ecosystem.config.cjs          PM2 設定

~/.catclaw/                       <- 執行期資料
├── catclaw.json                  設定檔
├── memory/                       全域 + account + project atom
│   └── _vectordb/                LanceDB 全域向量
└── workspace/
    ├── CATCLAW.md                全域行為規則（from templates/CATCLAW.md）
    ├── AGENTS.md                 Agent 註冊表
    ├── agents/{id}/              Agent 完整工作目錄（2026-04-14 起合併）
    │   ├── CATCLAW.md            agent 專屬行為規則（靈魂）
    │   ├── BOOTSTRAP.md          首次啟動儀式（可選）
    │   ├── BOOT.md               每次啟動執行（可選）
    │   ├── config.json           agent 設定
    │   ├── memory/               agent 專屬 atom
    │   ├── sessions/             agent 獨立 session
    │   ├── _vectordb/            agent 專屬向量
    │   └── skills/               agent 自建 skill
    └── data/
        ├── sessions/             per-channel session 持久化（default agent）
        ├── cron-jobs.json        排程定義 + 狀態
        └── active-turns/         crash recovery
```

---

## 3. 設定指南

設定檔位於 `$CATCLAW_CONFIG_DIR/catclaw.json`（預設 `~/.catclaw/catclaw.json`）。
格式為 JSONC（支援 `//` 註解，但不支援 trailing comma）。

### 主要設定區塊

| 區塊 | 用途 |
|------|------|
| `discord` | Bot token + per-guild/channel 權限控制 |
| `session` | TTL、最大 turn 數、壓縮閾值、持久化路徑 |
| `memory` | 記憶開關、context budget、vector search、自動萃取 |
| `safety` | 自我保護、協作衝突偵測、可逆性門檻 |
| `workflow` | Guardian、fix-escalation、wisdom engine |
| `accounts` | 註冊模式、預設角色、配對 |
| `dashboard` | Web Dashboard 開關、port、token |
| `agents` | 多 Agent 入口設定 |
| `modes` | 模式定義（normal / precise / custom） |
| `mcpServers` | MCP Server 定義 |
| `hooks` | Hook 定義陣列 |
| `ollama` | Ollama 雙 Backend |
| `rateLimit` | Per-role 速率限制 |
| `contextEngineering` | CE 開關 + 策略設定 |
| `cron` | 排程開關 + 並行上限 |

### 重要全域欄位

| 欄位 | 預設 | 說明 |
|------|------|------|
| `turnTimeoutMs` | 300000 | 回應超時（5 分鐘） |
| `showToolCalls` | `"all"` | 工具呼叫顯示：all / summary / none |
| `streamingReply` | `true` | 串流 live-edit 回覆模式 |
| `fileUploadThreshold` | 4000 | 超過此字數上傳為 .md |
| `debounceMs` | 500 | 訊息合併等待毫秒 |
| `logLevel` | `"info"` | Log 層級 |

### Hot-Reload

`catclaw.json` 和 `cron-jobs.json` 編輯存檔後自動生效，無需重啟。
唯一例外：`discord.token` 需重啟才能生效（Gateway 連線在啟動時建立）。

> 完整欄位說明：[02-CONFIG-REFERENCE.md](02-CONFIG-REFERENCE.md)

---

## 4. 功能指南

### 4.1 Agent Loop（對話迴圈）

核心推理迴圈，採一軌制：CatClaw 控制所有 tool，LLM 只負責思考。

**流程**：Session 載入 → Context 壓縮 → Memory Recall → System Prompt 組裝 → LLM 呼叫迴圈 → 後處理

**關鍵常數**：
- ~~`MAX_LOOPS`~~：已移除（b70785b），靠 LLM stop_reason + 多層安全網自然收尾
- `MAX_CONTINUATIONS = 3`：Output Token Recovery 自動續接次數
- Turn timeout：無 tool call 時 `turnTimeoutMs`（預設 5 分鐘）；出現 tool call 後 `turnTimeoutToolCallMs`（預設 0=無上限，對齊 Claude Code）

**事件型別**（AsyncGenerator）：`text_delta` / `thinking` / `tool_start` / `tool_blocked` / `done` / `error`

> 詳見：[modules/agent-loop.md](modules/agent-loop.md)

### 4.2 Tool 系統（30 builtin tools）

自動掃描載入 + register/execute + hot-reload + MCP tool 整合。

**Tool Tier 權限**：每個 tool 有 tier（public / standard / elevated / admin / owner），
PermissionGate 依角色物理移除不可用的 tool（LLM 完全看不到）。

**Deferred Tools**：`deferred: true` 的 tool 只注入名稱到 system prompt，
LLM 需先呼叫 `tool_search` 載入完整 schema 才能使用（節省 context）。

> 詳見：[modules/tool-registry.md](modules/tool-registry.md)

### 4.3 Skill 系統（46 builtin skills）



Skill = Discord 指令層，在 agent loop 之前攔截。31 個檔案（含多重 export 共 37 command-type skills）+ 9 個 prompt 型。
LLM 也可透過 `skill` tool 主動執行 builtin skill（不需引導使用者手動輸入）。

**觸發**：前綴匹配（如 `/think`、`/mode`、`/use`、`/stop`、`/plan`、`/status`）

**Skill Tier**：與 Tool 相同的 5 級權限控制。

**Prompt Skill**：以 `SKILL.md` 格式定義，將 prompt 注入對話而非直接執行程式碼。

> 詳見：[modules/skills.md](modules/skills.md)

### 4.4 記憶引擎（recall + extract + consolidate）

四層記憶：Global + Project + Account + Agent，以 atom（markdown 檔案）為單位。

**Recall**（5 步管線）：cache check → embed query → LanceDB vector search → merge/dedup/sort → touchAtom + cache + budget 截斷 → 注入 prompt

**Extract**：每輪對話後自動萃取知識（KnowledgeItem），經 write-gate dedup 後寫入 atom。

**Consolidate**：promotion / archive / decay — atom 的生命週期管理。

**目錄結構**：
```
{memoryRoot}/
  ├── *.md               全域 atom
  ├── MEMORY.md          索引
  ├── projects/{id}/     專案層
  ├── accounts/{id}/     個人層
  └── _vectordb/         LanceDB 向量資料庫
```

**Blind-Spot 警告**：所有層均無命中時，recall 回傳 `blindSpot: true`，提醒 LLM 可能缺乏背景知識。

> 詳見：[modules/memory-engine.md](modules/memory-engine.md)

### 4.5 Context Engineering（壓縮策略）

Strategy Pattern 架構，3 策略依序執行：

| 策略 | 觸發條件 | 行為 |
|------|---------|------|
| `decay` | 每次 build | 依 turn age 漸進衰減 L1→L4；長訊息（≥300 tokens）外部化存檔，context 只留路徑指標 |
| `compaction` | tokens > 20000 | LLM 六段結構化摘要（使用者意圖 / 已決策 / 待辦 / 未解決 / 工具重點 / 重要事實） + 附加使用者最近一則原文作意圖錨點 |
| `overflow-hard-stop` | tokens > window x 0.95 | 緊急截斷至 4 條 |

> 詳見：[modules/context-engine.md](modules/context-engine.md) / [wiki/Context-Engine.md](../wiki/Context-Engine.md)

### 4.6 Provider 系統（多 LLM 支援 + failover）

支援 Provider：
- **Claude API** — Anthropic Messages API（主力，OAuth + API Key 自動偵測）
- **Ollama** — 本地 LLM（OpenAI-compat API）
- **OpenAI-compat** — 第三方 OpenAI 相容 API
- **Codex OAuth** — pi-ai OAuth 流程
- **ACP CLI** — 透過 AI Agent CLI spawn 推理

**Failover**：FailoverProvider + CircuitBreaker，primary 失敗自動切換 fallback。

**AuthProfileStore**：多憑證管理 + cooldown，避免單一 key 被 rate limit。

**model 設定**：`models-config.json` 為唯一真相來源（primary / fallbacks / aliases / routing）。

> 詳見：[modules/providers.md](modules/providers.md)

### 4.7 Subagent 編排

`spawn_subagent` tool 讓 agent 啟動另一個 agent 執行獨立任務。

**模式**：
- `run`：一次性任務，完成後回傳結果
- `session`：持久 thread，綁定 Discord Thread 長期對話

**特性**：
- Async 模式：子 agent 背景執行，完成後通知 Discord 頻道
- Spawn 深度限制：`spawnDepth >= 2` 時禁止再 spawn（防遞迴）
- Runtime 類型：`default` / `coding` / `acp` / `explore` / `plan` / `build` / `review`

> 詳見：[modules/subagent-system.md](modules/subagent-system.md)

### 4.8 帳號/權限系統

**5 級角色**：`guest` → `member` → `developer` → `admin` → `platform-owner`

每級角色對應不同的 Tool Tier 權限，低權限角色的 tool 被物理移除（LLM 看不到）。

**Identity Linking**：一個帳號可綁定多個平台身份（Discord、Web Chat 等）。

**註冊模式**：open / invite / closed，由 `accounts.registrationMode` 控制。

> 詳見：[modules/accounts.md](modules/accounts.md)、[modules/permission-gate.md](modules/permission-gate.md)

### 4.9 Web Dashboard

內建 Web 監控面板（單檔 HTML/CSS/JS），預設 port 8088。

**分頁**：概覽 / Sessions / Traces / Subagents / Tasks / Cron / Config（含 FileWatcher 目錄監聽設定） / Logs

**Web Chat**：跨平台 session 共用，可從瀏覽器直接與 bot 對話。

**認證**：Bearer token（`config.dashboard.token`），未設定則無認證。

啟用：`catclaw.json` 設定 `dashboard.enabled: true`。

> 詳見：[modules/dashboard.md](modules/dashboard.md)

### 4.10 Cron 排程

定時排程執行任務，三種排程模式：

| Kind | 說明 | 範例 |
|------|------|------|
| `cron` | 標準 cron 表達式 | `"0 9 * * *"`（每天 9 點） |
| `every` | 固定間隔（ms） | `3600000`（每小時） |
| `at` | 一次性 ISO 時間 | `"2026-04-01T09:00:00+08:00"` |

**動作型別**：`message`（純文字）/ `claude-acp`（CLI spawn）/ `exec`（shell）/ `subagent`（agentLoop）

Job 定義存在 `data/cron-jobs.json`，支援 hot-reload。
每個 job 帶 `agentId` 做 agent 隔離（`config.cron.defaultAgentId` 設定預設值）。
失敗時指數退避重試（30s / 1min / 5min）。

**`/cron` skill**（Discord 動態管理）：
```
/cron add at <時間> <動作> <內容>       一次性排程
/cron add every <間隔> <動作> <內容>    重複排程
/cron add expr <cron五段> <動作> <內容> Cron 表達式
/cron <時間> <內容>                     快捷（= at + msg）
/cron list | delete <id> | enable <id> | disable <id>
```
動作：`msg`（訊息）/ `exec`（指令）/ `claude`（ACP）/ `agent`（subagent）

> 詳見：[modules/cron.md](modules/cron.md)

### 4.11 MCP 整合

連接外部 MCP server（stdio JSON-RPC 2.0），自動取得 tool 清單並註冊到 ToolRegistry。

**設定**：
```jsonc
"mcpServers": {
  "my-server": {
    "command": "npx",
    "args": ["-y", "my-mcp-server"],
    "env": { "API_KEY": "..." },
    "tier": "elevated"
  }
}
```

MCP tool 註冊名稱格式：`mcp_{serverName}_{toolName}`。預設 deferred（需 tool_search 載入 schema）。

> 詳見：[modules/mcp-client.md](modules/mcp-client.md)

### 4.12 Hook 系統

Hook = TS/JS 腳本或 shell 命令，在 agent-loop 的 36 個關鍵時機點執行。支援 global（所有 agent）+ per-agent（單一 agent）兩層掛載。

**36 個事件點（10 類）**：

| 類別 | Events |
|------|--------|
| Lifecycle (4) | `PreToolUse` `PostToolUse` `SessionStart` `SessionEnd` |
| Turn / Message (8) | `UserMessageReceived` `UserPromptSubmit` `PreTurn` `PostTurn` `PreLlmCall` `PostLlmCall` `AgentResponseReady` `ToolTimeout` |
| Memory / Atom (6) | `PreAtomWrite` `PostAtomWrite` `PreAtomDelete` `PostAtomDelete` `AtomReplace` `MemoryRecall` |
| Subagent (3) | `PreSubagentSpawn` `PostSubagentComplete` `SubagentError` |
| Context (3) | `PreCompaction` `PostCompaction` `ContextOverflow` |
| CLI Bridge (3) | `CliBridgeSpawn` `CliBridgeSuspend` `CliBridgeTurn` |
| File / Command (3) | `PreFileWrite` `PreFileEdit` `PreCommandExec` |
| File Watcher (2) | `FileChanged` `FileDeleted` |
| Error / Safety (2) | `SafetyViolation` `AgentError` |
| Platform (2) | `ConfigReload` `ProviderSwitch` |

**HookAction**：`allow` / `block`（中止後續）/ `modify`（改 params/data）/ `passthrough`

**檔案掛載慣例**：
- 全域：`~/.catclaw/workspace/hooks/{event}.{name}.{ext}`
- Agent 專屬：`~/.catclaw/workspace/agents/{id}/hooks/{event}.{name}.{ext}`
- 支援副檔名：`.ts` `.js` `.mjs` `.sh` `.bat` `.ps1`
- `*.disabled.*` 會自動跳過
- fs.watch 於檔案新增/修改/刪除時自動 reload registry

**TypeScript SDK**（推薦）：
```typescript
import { defineHook } from "catclaw/hooks";

export default defineHook(
  { event: "PreCommandExec", name: "block-dangerous", timeoutMs: 1000 },
  async (input) => {
    if (/rm\s+-rf\s+\//.test(input.command)) {
      return { action: "block", reason: "禁止 rm -rf /" };
    }
    return { action: "allow" };
  },
);
```

**Shell 腳本 metadata**（用 `// @hook` 或 `# @hook`）：
```sh
#!/usr/bin/env bash
# @hook event=PostToolUse timeoutMs=2000
echo "$STDIN_JSON" >> /tmp/tool-audit.log
```

**管理工具**：
- `hook_register` — 寫入新腳本
- `hook_list` — 列出已註冊 hooks
- `hook_remove` — 刪除或 disable

**管理 skill**：`/hook list [event]`、`/hook events`、`/hook remove <event> <name>`

**安全模型**：`CATCLAW_HOOK_DEPTH` 防遞迴、timeout/error fail-open、scope 分層、toolFilter 限制。

> 範例：`templates/hooks/` 內有 audit-log / block-dangerous / inject-context 三個範本
> 詳見：[modules/hooks.md](modules/hooks.md)

### 4.13 CLI Bridge

持久 process 模式，在指定工作目錄啟動 Claude CLI 並綁定 Discord 頻道。

**特性**：
- 每個 Bridge = 一個持久 Claude CLI process，綁定特定 `channelId` + `cwd`
- 設定存於 `cli-bridges.json`，支援 hot-reload
- Auto-restart on crash，keepAlive 機制
- 中間推理文字格式化 + 可選 `showIntermediateText`
- `/clear-session` 同步清空 `stdout.jsonl` + `compactTurns(60)` 合併 turns（保留統計、TTL 60 天）
- 跨頻道 mention 回應：獨立 bot 被 mention 時可在任意頻道/thread/guild 回覆，stdin tag 自動標記來源頻道（`chat_id` + `home_channel`）

**新增 Bridge**：在 Discord 使用 `/add-bridge label=<name> channel=<id> cwd=<path>`

> 詳見：[modules/cli-bridge.md](modules/cli-bridge.md)

---

## 5. 部署與維運

### PM2 管理

```bash
./catclaw start     # tsc 編譯 + PM2 啟動（首次）
./catclaw restart   # tsc 編譯 + signal file + PM2 重啟
./catclaw stop      # 停止
./catclaw status    # PM2 狀態
./catclaw logs      # 即時 log
```

### Signal File 重啟機制

`signal/RESTART` 檔案攜帶 `{channelId, time}`，PM2 偵測 `signal/` 目錄變更觸發重啟。
重啟完成後自動向觸發頻道發送通知，然後刪除 signal file。

### Hot-Reload

- `catclaw.json`：所有欄位即時生效（`discord.token` 除外）
- `cron-jobs.json`：新增/修改/刪除 job 即時生效
- 監聽機制：`fs.watch` + 500ms debounce

### 健康檢查

1. `./catclaw status` — PM2 狀態（status = online）
2. `./catclaw logs` — 即時 log 確認
3. Discord 測試 — `@BotName ping`
4. Debug 模式 — `catclaw.json` 設定 `logLevel: "debug"`（hot-reload 生效）
5. ACP trace — 停 PM2 後 `ACP_TRACE=1 node dist/index.js` 前景執行

> 完整部署指南：[04-DEPLOY.md](04-DEPLOY.md)

---

## 6. 常見陷阱

以下為最常遇到的 5 個問題，完整 25 項陷阱速查見 [09-PITFALLS.md](09-PITFALLS.md)。

### 1. Bot 上線但不回應訊息

- 確認 `guilds` 中對應 guildId 的 `allow: true`
- 確認是頻道 ID 而非伺服器 ID（右鍵頻道 → 複製頻道 ID）
- 確認有 @mention bot（若 `requireMention: true`）
- `logLevel: "debug"` 查看過濾原因

### 2. Discord 訊息 2000 字上限

長回覆會被 Discord API reject。CatClaw 內建處理：
streaming 模式自動拆段（1900 字切割），超過 `fileUploadThreshold` 上傳為 .md。

### 3. catclaw.json trailing comma 導致 hot-reload 失敗

JSONC 只支援 `//` 註解，不支援 trailing comma。
strip 註解後仍需合法 JSON，否則 hot-reload 持續失敗。

### 4. Session TTL 過期後行為異常

`session.ttlHours` 預設 168h（7 天），超過後自動開新 session。
如果 bot 突然「忘記」之前的對話，檢查 session 是否過期。

### 5. cron job 沒有執行

- `catclaw.json` 的 `cron.enabled` 需為 `true`
- job 的 `enabled` 未設為 `false`
- `schedule` 格式正確（cron 表達式用 [crontab.guru](https://crontab.guru) 驗證）

---

## 7. 模組索引

| 模組文件 | 原始碼 | 主題 |
|---------|--------|------|
| [agent-loop.md](modules/agent-loop.md) | `src/core/agent-loop.ts` | 核心對話迴圈 |
| [platform.md](modules/platform.md) | `src/core/platform.ts` | 子系統初始化工廠 |
| [message-pipeline.md](modules/message-pipeline.md) | `src/core/message-pipeline.ts` | 統一訊息管線 |
| [prompt-assembler.md](modules/prompt-assembler.md) | `src/core/prompt-assembler.ts` | System prompt 組裝 |
| [context-engine.md](modules/context-engine.md) | `src/core/context-engine.ts` | Context 壓縮策略 |
| [session.md](modules/session.md) | `src/core/session.ts` | SessionManager |
| [dashboard.md](modules/dashboard.md) | `src/core/dashboard.ts` | Web Dashboard + REST API |
| [reply.md](modules/reply.md) | `src/core/reply-handler.ts` | Streaming 回覆 |
| [message-trace.md](modules/message-trace.md) | `src/core/message-trace.ts` | 7 階段訊息追蹤 |
| [event-bus.md](modules/event-bus.md) | `src/core/event-bus.ts` | 事件匯流排 |
| [mode.md](modules/mode.md) | `src/core/mode.ts` | 模式管理 |
| [rate-limiter.md](modules/rate-limiter.md) | `src/core/rate-limiter.ts` | 速率限制 |
| [exec-approval.md](modules/exec-approval.md) | `src/core/exec-approval.ts` | 執行指令 DM 確認 |
| [session-snapshot.md](modules/session-snapshot.md) | `src/core/session-snapshot.ts` | Session 快照 |
| [task-store.md](modules/task-store.md) | `src/core/task-store.ts` | 任務 CRUD |
| [task-ui.md](modules/task-ui.md) | `src/core/task-ui.ts` | Discord 任務 UI |
| [tool-log-store.md](modules/tool-log-store.md) | `src/core/tool-log-store.ts` | Tool log 持久化 |
| [memory-engine.md](modules/memory-engine.md) | `src/memory/` | 四層記憶引擎 |
| [vector-service.md](modules/vector-service.md) | `src/vector/lancedb.ts` | LanceDB 向量服務 |
| [providers.md](modules/providers.md) | `src/providers/` | LLM Provider 系統 |
| [ollama-provider.md](modules/ollama-provider.md) | `src/providers/ollama.ts` | Ollama Provider |
| [tool-registry.md](modules/tool-registry.md) | `src/tools/` | Tool 註冊 + builtin tools |
| [skills.md](modules/skills.md) | `src/skills/` | Skill 系統 |
| [accounts.md](modules/accounts.md) | `src/accounts/` | 帳號 + 權限 |
| [permission-gate.md](modules/permission-gate.md) | `src/accounts/permission-gate.ts` | 權限閘門 |
| [agent-system.md](modules/agent-system.md) | `src/core/agent-loader.ts` | Multi-Agent 設定 |
| [subagent-system.md](modules/subagent-system.md) | `src/core/subagent-registry.ts` | Subagent 編排 |
| [hooks.md](modules/hooks.md) | `src/hooks/` | Hook 系統 |
| [safety.md](modules/safety.md) | `src/safety/` | 安全攔截 |
| [workflow.md](modules/workflow.md) | `src/workflow/` | 工作流引擎 |
| [mcp-client.md](modules/mcp-client.md) | `src/mcp/client.ts` | MCP 整合 |
| [discord.md](modules/discord.md) | `src/discord.ts` | Discord 入口 |
| [inbound-history.md](modules/inbound-history.md) | `src/discord/inbound-history.ts` | 未處理訊息記錄 |
| [cli-bridge.md](modules/cli-bridge.md) | `src/cli-bridge/` | CLI Bridge 持久 process |
| [cron.md](modules/cron.md) | `src/cron.ts` | 排程服務 |
| [acp.md](modules/acp.md) | `src/acp.ts` | Legacy CLI spawn（僅 cron 使用） |
| [config.md](modules/config.md) | `src/core/config.ts` | JSON 設定載入 |
| [logger.md](modules/logger.md) | `src/logger.ts` | Log 系統 |
| [pm2.md](modules/pm2.md) | `catclaw.js` | PM2 進程管理 |
| [index.md](modules/index.md) | `src/index.ts` | 進入點 |
| [tool-output-store.md](modules/tool-output-store.md) | `src/core/tool-output-store.ts` | Tool result 外部化（項目 6） |
| [context-references.md](modules/context-references.md) | `src/core/context-references.ts` | Inline `@file/@folder/@git/@url/@diff/@staged`（項目 8） |
| [message-index-store.md](modules/message-index-store.md) | `src/memory/message-index-store.ts` | 跨 session 訊息 NDJSON 索引（項目 9 Phase 1） |
| [fts-query.md](modules/fts-query.md) | `src/memory/fts-query.ts` | NDJSON 訊息查詢 + 統計聚合（項目 9 Phase 2/3） |
| [skill-improvement-store.md](modules/skill-improvement-store.md) | `src/memory/skill-improvement-store.ts` + `runSkill` | Skill 自動提案 + 4 觸發（項目 10） |
| [trajectory-fingerprint.md](modules/trajectory-fingerprint.md) | `src/workflow/trajectory-fingerprint.ts` | 失敗 pattern 壓縮 + match（項目 12 階段 2） |

---

## 8. 2026-05-04 v3 重大更新（Hermes 整合）

13 項計畫共 24 commits 落地（10/11 = 91%，項目 11/13 暫緩）：

**新增模組**（6 個 module）：
- 項目 6 Tool Result Externalization：`tool-output-store.ts`
- 項目 8 Inline Context References：`context-references.ts`（6 種 @-kind 自動展開）
- 項目 9 訊息索引：`message-index-store.ts`（NDJSON）+ `fts-query.ts`（query / aggregate）
- 項目 10 Skill Self-Improve：`skill-improvement-store.ts` + `self-reflect.ts` + `recent-skill-tracker.ts`
- 項目 12 Trajectory：`trajectory-fingerprint.ts` + `pending-rut-detector.ts`

**新增 skills / tools**：
- Skills：`/file` `/recall` `/insights` `/guardian-export` `/reload`
- LLM tools：`memory_search_fulltext`

**Dashboard 新 tabs**：
- 「Guardian」— 列 guardianHits + 標 正確/誤報 + 點 trace
- 「洞察」— `/insights` 等價 UI（days select）
- 「提案」— Skill Improvements 審核（Accept/Modify/Discard）

**新增 API endpoints**：
- `GET /api/insights?days=N`
- `GET /api/guardian-hits?limit=N` + `POST /api/guardian-hits/label`
- `GET /api/skill-improvements` + `POST /api/skill-improvements/{accept,discard}`

**核心改動**：
- 項目 5 Frozen Snapshot：Anthropic prompt cache 命中保證（system prompt session-start 凍結）
- 項目 6：truncateToolResult 簽名改 `{ text, externalized? }`，3 caller 簿冊；CE Decay 識別 stub 跳過
- 項目 7：CompactionStrategy 改 4 section + first-time/iterative + Pending 拖延 rut 偵測
- 項目 10 4 觸發：error / exception / retry / interruption / self-reflection（LLM judge）
- 項目 12：trace.guardianHits schema + falsePositive 標註 → trajectory-fingerprint plumbing

詳見 `_AIDocs/_CHANGELOG.md` 4 條 v3-followup entries + `~/WellsDB/知識庫/CatClaw 整合 Hermes 實作報告 v3.md`。


---

## 9. 2026-05-26 ~ 2026-06-08 v4 系列（V5 atom 重構 + 可靠性強化）

13 天內 20 個 commits，三大主題：**原子記憶 V5 對齊 upstream**、**timeout / leak 防禦深化**、**cron + dashboard 治本修補**。

### 9.1 原子記憶 V5 對齊（atom 系列）

對拍 `~/.claude` V5 GA。Phase 1-6 + follow-up refactor：

- **Phase 1 BM25 in-memory ranking**（commit `1cba29d`）— recall pipeline 加 BM25 ranking 層
- **Phase 2 `_atom_index.json` SoT**（`c13b0ea`）— markdown table → JSON 機器源 + MEMORY.md 自動鏡像
- **Phase 3-6 一次 port**（`a65de40`）— 4 個新檔 ~2300 行：
  - `atom-access.ts`：遙測抽到 `<atom>.access.json`（read_hits / confirmations / last_used / first_seen 分離）
  - `atom-io.ts`：統一 funnel + audit log `_meta/atom_io_audit.jsonl`
  - `atom-spec.ts`：規則單一來源（slugify / buildAtomContent / validate / shouldSkip）
  - `bm25-service.ts`：disk-persisted 全 atom 內容 BM25 索引
- **scope→dir 4-branch 抽 `atom-locations.ts`**（`12c7f85`）— atom-write/atom-delete 重複邏輯收斂
- Migration scripts：`migrate-to-json-index.mjs` / `migrate-to-access-json.mjs`
- 13 個 smoke tests / 290+ assertions

### 9.2 Timeout / Stream / Anti-leak 防禦

- **Tool soft-watchdog**（`6800854`）— per-tool softTimeoutMs（run_command 120s / glob 30s 等），觸發回 actionable error 給 LLM 自行決策（縮 scope / 換工具 / spawn_subagent / end_turn）
- **codex-oauth stream progress watchdog**（`6800854`）— 既有 idle 之外加 progress watchdog（300s 無實質進展 abort），解 OpenAI Responses API reasoning 階段 keepalive 灌爆 idle watchdog 的盲點
- **subagent anti-echo**（`23864a1`）— system prompt 加 Output Discipline，禁止 subagent 在 result 開頭 echo task 字串
- **agent-loop platform reminder 全包 `<system-reminder>` tag**（`7605598` + `2278b24`）— 6 處內部注入訊息（長任務評估 / grace period / stuck-loop / subagent-poll nudge）防 LLM 引用 leak 到 Discord
- **Windows CP950 fallback decode**（`b5f44ee`）— `run_command` 加 iconv-lite 雙門檻 fallback，解 cmd.exe 中文錯誤訊息亂碼

### 9.3 Cron + Dashboard 治本修補

- **codex-acp action**（`c6a2356`）— 新 Codex CLI app-server JSON-RPC ACP runtime；cron skill 加 `codex` keyword
- **acp keyword 別名**（`8d7a9ff`）— `/cron add at 30m acp ...` = 走 codex-acp
- **`silent` / `--verbose` flag**（`8903190` + `16e758f`）— exec action 預設不推「(no output)」雜訊；想看通知加 `--verbose`
- **Dashboard race fix**（`a12c205`）— 5 個 cron POST endpoint 改走 cron 模組 export API（in-memory + disk 同步），解「dashboard 刪除被 cron timer stale in-memory 覆寫」
- **Trace abort button**（`b3ff7f3`）— Dashboard 列加「⏹ 強制中止」按鈕（in_progress 才顯），對應 `POST /api/traces/:traceId/abort`

### 9.4 Skill 提案系統強化

- **Skill candidate priority + urgency_score**（`6dab12b`）— LLM judge 加評分標準（high/med/low + 1-10），dashboard 按 urgency desc 排序 + 彩色 badge
- **Skill improvement cooldown + TTL**（`6dab12b`）— 仿 candidate-store pattern，避免同 skill 反覆累積；improvements 14 天 / candidates 30 天 TTL sweep
- **skill-creator meta-skill**（`0a7d5cf`）— 從上游引入，教 agent 寫/改/審 skill 的標準作業（3 Python scripts + 5 pattern refs + audit-skill）

### 9.5 Background Job 通知補洞

- **bg-job stale ack fix**（`7200f96`）— catclaw 重啟後 `running → stale` 化的 record 補 `acked=false` + persist disk，讓 startup recovery 撿起來 emit onComplete 給 parent agent
- **Startup recovery retry 防連續重啟**（user follow-up）— `STARTUP_RECOVERY_RETRY_MS` 10 分鐘節流 + `recoveryDispatchedAt` 欄位，防 catclaw 連續重啟重放同一筆通知

詳見 `_AIDocs/_CHANGELOG.md` + 各 commit message。

