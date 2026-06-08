# CatClaw

[English](README.en.md) | **繁體中文**

以 Discord 為介面的 AI Agent 運行平台 — multi-turn agent loop、30 builtin tools、46 builtin skills、36-event hook 系統、多 provider failover、四層記憶引擎、Web Dashboard。

## 功能總覽

| 類別 | 能力 |
|------|------|
| **Agent Loop** | Multi-turn 推理迴圈、tool 執行、output token recovery、auto-compact |
| **Tools** | 30 builtin tools — 檔案讀寫編輯、glob、grep、bash 執行、web 抓取/搜尋、記憶、subagent、任務管理、skill 執行、hook 管理、filewatch |
| **Skills** | 46 builtin skills（37 command-type + 9 prompt-type）— config、session、account、status、restart、plan、remind、hook 等 |
| **Hook 系統** | 36 events（10 類，Lifecycle/Turn/Memory/Subagent/Context/CLIBridge/FileCmd/FileWatcher/Error/Platform）+ folder-convention 掛載 + fs.watch 熱重載 + TS/JS/sh/ps1 多 runtime + defineHook SDK |
| **Multi-Provider** | claude-api / ollama / openai-compat / codex-oauth / acp-cli / cli-* + circuit-breaker failover |
| **記憶引擎** | 四層記憶（Global / Project / Account / Agent）— 向量 recall + 關鍵字搜尋 + 自動萃取 + 晉升/衰減 + **embedding 模型漂移偵測 + 自動 dim mismatch 重建** |
| **Context Engine** | Decay（漸進衰減+外部化）/ Compaction（LLM 結構化摘要）/ Overflow Hard Stop 三策略 + anti-hallucination stub 誠實化 + turn cap warning + **Tool LRU eviction**（治本 tool_search 活化的 cache 累計成本） |
| **帳號權限** | 註冊、identity linking、5 級角色（guest/member/developer/admin/platform-owner）、per-channel 權限閘門 |
| **Subagent** | 子任務分派 + **Discord thread / 分段 reply bridge** + 追蹤（>1980 字自動分頁帶 `_(i/total)_` 標記） |
| **Health Monitor** | Component-level fail-loud + 啟動健康總覽（紅綠燈）+ degraded/critical 連續失敗偵測 + Discord 通報 |
| **排程** | cron / every / at — message、subagent、exec、claude-acp、cli-bridge 動作 + `/cron` skill 動態管理 + agent 隔離 |
| **Discord** | 串流回覆、debounce、thread 繼承、附件處理、crash recovery、bot circuit breaker |
| **Dashboard** | Web UI（port 8088）— REST API、訊息追蹤視覺化、token 用量、session 管理 |

## 架構

```
Discord 訊息
    |
    v
discord.ts ─── 訊息過濾 + Debounce
    |
    v
message-pipeline.ts ─── 身份解析 → 權限閘門 → Memory Recall → Intent Detection → Prompt 組裝
    |
    v
agent-loop.ts ─── Multi-turn 推理迴圈（LLM <-> Tool 執行）
    |                         |
    v                         v
providers/ ───────── tools/ + skills/
LLM 抽象層            25 Tools + 34 Skills + 36 Hook Events
+ Failover
    |
    v
reply-handler.ts ─── Streaming 分段回覆 → Discord
```

**核心子系統**（由 `platform.ts` 初始化）：

| 子系統 | 說明 |
|--------|------|
| SessionManager | Per-channel 串行佇列 + 磁碟持久化 + TTL |
| MemoryEngine | 四層記憶：recall + extract + consolidate |
| ContextEngine | Context 壓縮策略 |
| AccountRegistry | 帳號 + 角色 + 權限 |
| ProviderRegistry | LLM Provider 抽象 + failover + circuit breaker |
| ToolRegistry | 自動載入 dist/ 下的 builtin tools |
| SafetyGuard | 指令攔截 + 協作衝突偵測 |
| Dashboard | Web UI + REST API + trace 視覺化 |
| WorkflowEngine | Rut/oscillation/fix-escalation/sync 偵測 |
| SubagentRegistry | Subagent 生命週期管理 |

## 快速開始

### 一鍵安裝

**macOS / Linux：**
```bash
git clone git@github.com:wellstseng/catclaw.git
cd catclaw
bash setup.sh
```

**Windows (PowerShell)：**
```powershell
git clone git@github.com:wellstseng/catclaw.git
cd catclaw
powershell -ExecutionPolicy Bypass -File setup.ps1
```

安裝腳本自動完成：
1. 前置檢查（Node.js >= 18、pnpm、PM2）
2. 安裝依賴
3. 建立 `.env`（預設路徑）
4. 初始化目錄結構（`~/.catclaw/`）
5. Admin 帳號設定（輸入 Discord User ID，建立 platform-owner 帳號）
6. 互動設定 Discord Bot Token（寫入 `catclaw.json`）
7. 互動設定預設 Discord 頻道
8. 互動設定 Anthropic API Key（建立 `auth-profile.json`）
9. 功能開關（Dashboard / 排程）
10. 編譯 TypeScript + PM2 啟動

### 手動安裝

```bash
git clone git@github.com:wellstseng/catclaw.git
cd catclaw
pnpm install
cp .env.example .env        # Windows: copy .env.example .env
pnpm build
./catclaw init
```

編輯 `~/.catclaw/catclaw.json` 填入 Discord Bot Token，然後：

```bash
./catclaw start
```

## 前置需求

- **Node.js** >= 18
- **pnpm**（setup.sh 會自動安裝）
- **PM2**（setup.sh 會自動安裝）
- **Discord Bot Token** — 從 [Discord Developer Portal](https://discord.com/developers/applications) 取得
- **LLM Provider**（至少一個）：
  - Anthropic API Key（`sk-ant-...`）— 推薦
  - Ollama（本地）
  - OpenAI 相容端點

### Discord Bot 設定

1. 前往 [Discord Developer Portal](https://discord.com/developers/applications)
2. 建立 Application -> Bot -> Reset Token -> 複製
3. 開啟 **Privileged Gateway Intents**：
   - MESSAGE CONTENT INTENT（必要）
   - SERVER MEMBERS INTENT（可選）
4. OAuth2 -> URL Generator -> `bot` scope -> 權限：
   - Send Messages、Read Message History、Add Reactions
   - Manage Messages（可選，用於編輯串流回覆）
5. 使用產生的 URL 邀請 Bot 到你的伺服器

## 設定

### 目錄配置

```
~/.catclaw/                         設定根目錄（CATCLAW_CONFIG_DIR）
  catclaw.json                      主設定檔（JSONC 格式）
  workspace/                        Agent 工作目錄（CATCLAW_WORKSPACE）
    CATCLAW.md                      Bot 行為規則（system prompt）
    agents/
      default/
        auth-profile.json           LLM API 憑證
        models.json                 Provider/Model 定義
        CATCLAW.md                  Agent 專屬行為規則（可選）
      {agentId}/
        BOOTSTRAP.md                首次啟動儀式（可選）
        BOOT.md                     每次啟動執行（可選）
        config.json                 Agent 設定（provider/model/admin）
        memory/                     Agent 專屬 atom 記憶
        sessions/                   Agent 獨立 session
        _vectordb/                  Agent 專屬 LanceDB
        skills/                     Agent 自建 skill
    data/
      sessions/                     Session 持久化
      cron-jobs.json                排程定義
```

### catclaw.json

主設定檔，JSONC 格式（支援 `//` 註解）。**不再包含對話 LLM 設定**（V2：對話 LLM 真相源是 `models-config.json`）。重要欄位：

```jsonc
{
  "discord": {
    "token": "你的 Discord Bot Token",
    "dm": { "enabled": true },
    "guilds": {
      "<伺服器 ID>": {
        "allow": true,
        "requireMention": true
      }
    }
  },
  "admin": {
    "allowedUserIds": ["<你的 Discord User ID>"]
  },
  "ollama": {
    // Memory pipeline 用的本地 Ollama（embedding/extraction），跟對話 LLM 解耦
    "enabled": true,
    "primary": { "host": "http://localhost:11434", "model": "qwen3:14b", "embeddingModel": "qwen3-embedding:8b" },
    "failover": false,
    "thinkMode": false,
    "numPredict": 512,
    "timeout": 600000
  }
}
```

> ⚠ V1 欄位 `provider` / `providers` / `providerRouting` 與 V2-deprecated `agentDefaults` 區塊已廢棄。  
> 升級時 platform 啟動會自動跑 `migrate-v2` 把這些搬到 `models-config.json`（備份 `.bak.{timestamp}`）。  
> 也可手動跑 `./catclaw migrate-v2 [--dry-run]`。

完整範例參考 `catclaw.example.json`。

### models-config.json（對話 LLM 真相源）

位於 `~/.catclaw/models-config.json`。**對話 LLM 主設定的唯一真相源**：

```jsonc
{
  "mode": "merge",                  // 與內建 provider catalog 合併
  "primary": "sonnet",              // 當前模型（alias 或 "provider/model"）
  "fallbacks": [],
  "aliases": {
    "sonnet": "anthropic/claude-sonnet-4-6",
    "haiku":  "anthropic/claude-haiku-4-5-20251001",
    "heretic": "ollama-remote/juilpark/gemma-4-31B-it-uncensored-heretic:q4_k_m"
  },
  "providers": {
    "ollama-remote": {              // 自訂 provider（如遠端 Ollama）
      "baseUrl": "http://192.168.88.22:11434",
      "api": "ollama",
      "models": [
        { "id": "juilpark/gemma-4-31B-it-uncensored-heretic:q4_k_m", "contextWindow": 32768, ... }
      ]
    }
  }
}
```

**編輯方式**（任選一種）：
- **Dashboard**：Auth 分頁「模型設定」面板（圖形化切換 / 加 provider）
- **`/configure` skill**：Discord 指令切模型
- **手動編輯**：直接改 JSON，**之後 `./catclaw restart`**（provider registry 不熱重載）

### auth-profile.json

LLM Provider 憑證，位於 `~/.catclaw/workspace/agents/default/auth-profile.json`：

```json
{
  "version": 2,
  "profiles": {
    "anthropic:default": {
      "type": "api_key",
      "provider": "anthropic",
      "key": "sk-ant-..."
    }
  },
  "order": {
    "anthropic": ["anthropic:default"]
  }
}
```

> Ollama 系列不需 auth-profile（本地連線無憑證）。Dashboard 模型設定面板會自動列出。

### 環境變數

| 變數 | 預設值 | 說明 |
|------|--------|------|
| `CATCLAW_CONFIG_DIR` | `~/.catclaw` | catclaw.json + models-config.json 所在目錄 |
| `CATCLAW_WORKSPACE` | `~/.catclaw/workspace` | Agent 工作目錄（auth-profile / sessions / data） |

## CLI 指令

```bash
./catclaw start                      # 編譯 + PM2 啟動
./catclaw stop                       # 停止
./catclaw restart                    # 重新編譯 + 重啟
./catclaw build                      # 僅編譯（不啟動）
./catclaw logs                       # 即時 log
./catclaw status                     # 狀態
./catclaw reset-session              # 清除所有 session
./catclaw reset-session <channel>    # 清除指定 channel
./catclaw migrate-v2 [--dry-run]     # V1 設定（provider/providers/agentDefaults）遷移到 models-config.json
```

## 從 V1 升級

舊版 `catclaw.json` 內若有 `provider` / `providers` / `providerRouting` / `agentDefaults` 區塊，啟動時會自動偵測並搬到 `models-config.json` + 備份原檔。手動執行：

```bash
./catclaw migrate-v2 --dry-run       # 預覽變動（不寫檔）
./catclaw migrate-v2                  # 實跑（自動產 catclaw.json.bak.{ts} + models-config.json.bak.{ts}）
./catclaw restart
```

migration 冪等（重跑回 `already_v2`）。涉及 token/password 的 V1 provider 會列入 `requiresManualReview`，需手動移到 auth-profile.json。

> Windows 使用 `catclaw` 取代 `./catclaw`（自動找到 `catclaw.cmd`）

## Discord 使用方式

- 在允許的頻道 **@mention** Bot 開始對話
- 直接 **私訊** Bot（需 `dm.enabled: true`）
- 使用 `/` 前綴觸發 skill 指令（如 `/help`、`/status`、`/configure`）

## Per-channel Project Binding

把單一 Discord 頻道綁定特定專案，讓 agent 在該頻道內以該專案的 CWD / 記憶 / CLAUDE.md 工作：

```jsonc
"discord": {
  "guilds": {
    "<guildId>": {
      "channels": {
        "<channelId>": { "boundProject": "<projectId>" }
      }
    }
  }
}
```

啟用後三個維度自動切到 project scope：

| 維度 | 切到哪 |
|------|--------|
| CWD（run_command / read_file / write_file / edit_file 相對路徑 base） | `project.toolsDir` 或 `~/.catclaw/workspace/data/projects/{id}/` |
| 記憶 | `~/.catclaw/memory/projects/{id}/`（recall 自動加 project 層，atom_write 預設 scope=project） |
| System prompt | 注入 project CWD 下的 `CLAUDE.md`（若存在） |

**驗證方法**：在綁定頻道問 agent「你的目錄是哪裡」→ 答 project cwd 而非 catclaw 啟動目錄。

**Fail-soft**：projectId 指向不存在的 project → log.warn 後仍跑（回全域）。

優先序：`channel.boundProject` > `account.projects[0]`（fallback）。

### 常用 Skills

| Skill | 權限 | 說明 |
|-------|------|------|
| `/help` | public | 顯示可用指令 |
| `/status` | standard | 系統狀態 |
| `/session list` | standard | 列出 session |
| `/session clear` | standard | 清除目前 session |
| `/configure show` | admin | 顯示 provider/model 設定 |
| `/configure model <id>` | admin | 更換模型 |
| `/cron` | standard | 排程管理（add/list/delete/enable/disable） |
| `/hook` | standard | Hook 系統管理（list/events/remove） |
| `/restart` | admin | 重啟 Bot |
| `/add-bridge` | admin | 新增 CLI Bridge |
| `/clear-session` | admin | CLI Bridge 清空 sessionId + stdout.jsonl，turns 合併保留統計（TTL 60 天） |

## Dashboard

Web 監控面板，預設位於 `http://localhost:8088`。

功能：
- Session 列表與訊息歷史
- 訊息追蹤視覺化（7 階段管線）+ **Trace 批次選取 / 批次匯出 .zip / 批次刪除** + 單筆 Markdown 匯出（含 CE 前後 messages，可審計 compaction 摘要品質）
- Token 用量統計
- 記憶管理（embedding 模型漂移時警示 banner 提示重建索引）
- 🩺 **Component Health** 面板（紅綠燈總覽 + 連續失敗計數 + startup details）
- 線上 Config 編輯（含 FileWatcher 目錄監聽設定）
- CLI Bridge 狀態
- Web Chat（跨平台 session 共用）

## 專案結構

```
src/
  core/           Agent Loop、Platform、Session、Dashboard、Context Engine、
                  Prompt Assembler、Reply Handler、Event Bus、Message Pipeline
  memory/         四層記憶引擎（engine、recall、extract、consolidate）
  providers/      LLM Provider 抽象（claude-api、ollama、openai-compat、cli-*）
  tools/          Tool Registry + 30 builtin tools
  skills/         Skill Registry + 46 builtin skills（37 command-type + 9 prompt）
  hooks/          Hook 系統 — 36 events + folder-convention + fs.watch + defineHook SDK + FileWatcher
  safety/         安全攔截（guard、collab-conflict）
  workflow/       工作流引擎（rut、oscillation、fix-escalation、sync）
  accounts/       帳號 + 角色 + 權限 + identity linking
  mcp/            MCP client + Discord MCP server
  vector/         Embedding providers + LanceDB 向量搜尋
  cli-bridge/     CLI Bridge 持久 process 模組
  discord/        Discord 附加模組
catclaw           CLI wrapper（Unix）
catclaw.cmd       CLI wrapper（Windows）
catclaw.js        CLI 核心邏輯
ecosystem.config.cjs  PM2 設定
setup.sh          一鍵安裝（macOS/Linux）
setup.ps1         一鍵安裝（Windows PowerShell）
templates/
  CATCLAW.md      全域行為規則 template（初始化時複製到 workspace）
```

## 文件

- **[_AIDocs/WIKI.md](_AIDocs/WIKI.md)** — 完整系統手冊
- **[_AIDocs/02-CONFIG-REFERENCE.md](_AIDocs/02-CONFIG-REFERENCE.md)** — 完整設定參考
- **[_AIDocs/01-ARCHITECTURE.md](_AIDocs/01-ARCHITECTURE.md)** — 架構深入說明
- **[_AIDocs/_INDEX.md](_AIDocs/_INDEX.md)** — 知識庫索引

## 2026-05-04 v3 重大更新（Hermes 整合計畫）

整合 Nous Research Hermes 平台值得參考的功能，落地 10/11 項（91%，項目 11/13 暫緩除外）。

**新功能**（5 個 builtin skill / 1 個 LLM tool）：
- `/file <path>[:lines]` — Inline file reference 助手
- `/recall <query> [--days N]` — 跨 session 訊息全文搜尋
- `/insights [--days N]` — 使用統計報告（token / cost / tool top / Compaction / 熱門 channel）
- `/guardian-export` — Guardian Hits 匯出 jsonl（trajectory-fingerprint 訓練資料）
- `/reload` — 強制重建 frozen prompt snapshot
- `memory_search_fulltext` — LLM 跨 session 訊息搜尋 tool

**Inline Context References** — 訊息中 `@file:"src/foo.ts:10-20"` / `@folder:` / `@git:HEAD~3` / `@url:` / `@diff` / `@staged` 自動展開到訊息末尾，免額外 tool round-trip。

**Tool Result Externalization** — ≥ 閾值的 tool result 自動寫到 `~/.catclaw/workspace/data/tool-outputs/` 並在 prompt 中以 stub 取代（含絕對路徑），LLM 想看完整可 `read_file`。

**Frozen Prompt Snapshot** — system prompt session-start 凍結，保 Anthropic prompt cache 命中（v2 落地）。

**Compaction 結構化摘要** — 4 個固定 section（Active Task / Resolved Questions / Pending Questions / Remaining Work）+ first-time / iterative 雙 prompt 模式 + Pending 拖延型 rut 偵測。

**Skill Self-Improving** — `runSkill` wrapper 4 種觸發（error / exception / retry / interruption / self-reflection LLM judge）→ 提案寫入 `_staging/skill-improvements/` → Dashboard 「提案」tab 審核（Accept / Modify / Discard）→ Accept 後 promoted atoms 自動整合進 skill context。**不修改 skill 本體**（人格保護）。

**Workflow Guardian 結構化標註** — `guardianHits` schema + Dashboard「Guardian」tab 標 ✅ 正確 / ❌ 誤報 + Trajectory Fingerprint plumbing（hash + match failure DB，等樣本累積後啟用 agent-loop 比對）。

**Cross-Session 訊息索引** — NDJSON append-only 寫入（fire-and-forget + setImmediate + size rotation），支援 `/recall` 與未來升級 SQLite FTS5。

**Dashboard 新增 3 tabs**：「Guardian」「洞察」「提案」+ 7 個新 API endpoints。

詳見 `~/WellsDB/知識庫/CatClaw 整合 Hermes 實作報告 v3.md` + `_AIDocs/_CHANGELOG.md`。

## 2026-05-26 ~ 2026-06-08 v4 系列更新

13 天累積 20 個 commits，三大主題：

### 原子記憶 V5 對齊（atom 重構）

對拍 `~/.claude` V5 GA。Phase 1-6 + follow-up refactor：

- **BM25 in-memory ranking** → recall pipeline 加排序層
- **`_atom_index.json` SoT** → markdown table 降級為自動鏡像
- **新增 4 個核心模組**（~2300 行 + 13 smoke tests / 290+ assertions）：
  - `atom-access.ts`：遙測抽到 `<atom>.access.json`
  - `atom-io.ts`：統一 funnel + audit log
  - `atom-spec.ts`：規則單一來源
  - `bm25-service.ts`：disk-persisted 全內容 BM25
- 對應 migration scripts；hooks 經 `atom-locations.ts` 收斂重複的 scope→dir 邏輯

### Timeout / Stream / Anti-leak 防禦深化

- **Tool soft-watchdog**：per-tool softTimeoutMs，觸發回 actionable error 讓 LLM 自決策（縮 scope / 換工具 / spawn_subagent / end_turn）
- **codex-oauth stream progress watchdog**：既有 idle 之外加 progress watchdog（300s 無實質進展 abort），解 OpenAI Responses API reasoning 階段 keepalive 灌爆 idle 的盲點
- **subagent anti-echo**：禁止 result 開頭 echo task 字串
- **`<system-reminder>` tag 包**：6 處 agent-loop 平台注入訊息防 LLM 引用 leak 到 Discord
- **Windows CP950 fallback**：`run_command` 加 iconv-lite 雙門檻 fallback，解 cmd.exe 中文錯誤訊息亂碼

### Cron / Dashboard / Skill / BG-Job 治本修補

- **codex-acp action**：Codex CLI app-server JSON-RPC ACP runtime（對稱 claude-acp）+ `acp` keyword 別名走 codex
- **exec silent 預設**：避免「(no output)」雜訊，`--verbose` 反向 flag 顯示
- **Cron dashboard race fix**：5 個 POST endpoint 改走 cron 模組 export API，解「刪除被 cron timer stale in-memory 覆寫」
- **Dashboard `⏹ 強制中止`**：trace 列加按鈕，POST `/api/traces/:traceId/abort` 走既有 `abortRunningTurn(sessionKey)`
- **Skill candidate priority + urgency_score**：LLM judge 評分 high/med/low + 1-10，dashboard 排序 + 彩色 badge
- **Skill proposal cooldown + TTL**：improvements 14 天 / candidates 30 天 sweep
- **skill-creator meta-skill**：上游引入，教 agent 寫/改/審 skill 標準作業
- **bg-job restart passive recovery**：catclaw 重啟後 stale/final record 只被動標記，不 emit / wake，避免重啟觸發新 agent turn

### 新增頂層文件

- [`_AIDocs/03-CONTEXT-ENGINE.md`](_AIDocs/03-CONTEXT-ENGINE.md)：Context Engineering 全策略解（Decay / Compaction / OverflowHardStop + 外部化 + Rollback）

詳見 [`_AIDocs/WIKI.md` § 9](_AIDocs/WIKI.md) + 各 commit message。

## License

MIT
