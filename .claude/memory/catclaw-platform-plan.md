---
name: catclaw-platform-plan
description: CatClaw 全系統升級計畫 — 從 Discord bot 升級為獨立 AI 平台，整合原子記憶 V2.17，一軌制 HTTP API + Agent Loop + Tool Tier + 多人協作
type: project
---

# CatClaw 平台升級計畫

## 統一架構文件

`~/.catclaw/workspace/_planning/catclaw-platform-architecture.md`（V1.5, 2026-03-25）

## 設計約束（C1-C5）

- C1: 流程控制程式碼優先
- C2: 原子記憶 V2.18 完整繼承（Node.js 改寫）
- C3: ~/.claude 97+ 檔案、26,450+ 行完整移植
- C4: 開發規範（中文註解、@file 檔頭、// ── 區段 ──、17 pitfalls）
- C5: 未來原子記憶升級（V2.18+）同步規範

## 核心決策（2026-03-22/23/24 討論確定）

- [固] 從 Discord bot 升級為多人 AI 平台
- [固] ~/.claude 完整移植：記憶、安全、工作流、skill、tool
- [固] 一軌制：全走 HTTP API（setup-token / API Key），CatClaw 完全控制所有 tool
- [固] Agent Loop + Tool Hook（仿 OpenClaw before/after_tool_call wrapper）
- [固] CLI 不是 Provider，透過 ACPX skill（admin tier）與 Claude CLI 溝通
- [固] 同一 session 同一 provider（群組不按角色切換），DM 可按帳號偏好
- [固] 頻道可綁定專案（boundProject），該頻道只載入綁定專案的記憶/tool policy
- [固] Extract 目標 per-request：按當前說話者的 project 或頻道 boundProject
- [固] Tool Tier 分級：tool/skill 聲明 tier（public/standard/elevated/admin/owner），角色決定可存取的 tier 範圍
- [固] Tool/Skill 全 TypeScript：每個一個 .ts 檔，export 固定結構，目錄自動掃描註冊，新增只加檔案不改 registry
- [固] Tool Policy：按 tier + 帳號覆寫(allow/deny) + 專案 policy 物理移除 tool（仿 OpenClaw pipeline）
- [固] /help 按帳號角色顯示可用 tool + skill 清單（permissionGate.listAvailable）
- [固] Provider 自己寫（~100-200 行/個），不依賴 pi-ai 或 @anthropic-ai/sdk
- [固] 未來可換底層為第三方套件，介面不變
- [固] 原子記憶格式沿用，儲存獨立在 ~/.catclaw/memory/
- [固] 萃取固定用 Ollama
- [固] 多人：5 級角色 + 帳號 + identity tuple + 跨平台綁定
- [固] 三層記憶：全域（平台）+ 專案 + 個人
- [固] HomeClaudeCode 共用：初期內建，穩定後抽包

## TOS 合規（2026-03-24 查證）

- [固] OAuth token（訂閱）用在第三方工具：Anthropic 2026-02-19 明確禁止
- [固] 個人實驗用途：Anthropic 表示「鼓勵實驗」「使用方式沒有改變」
- [固] 商業/對外：必須用 API Key
- [固] CatClaw 預設 HTTP API + setup-token（訂閱額度），可選 API Key（按量）

## OpenClaw 查證結果（2026-03-23/24 原始碼驗證）

### Agent Loop
- `src/agents/pi-embedded-runner/run/attempt.ts`（2737 行），用 pi-agent-core

### Tool Hook 三層
- **before_tool_call**：`pi-tools.before-tool-call.ts`，wrapToolWithBeforeToolCallHook()，可阻擋 + 修改參數
- **after_tool_call**：fire-and-forget 並行觀察（params, result, error, durationMs）
- **tool_result_persist**：結果寫入 session 前同步修改

### Tool Policy Pipeline
- `tool-policy-pipeline.ts`：7 層 filter，物理移除 tool（Array.filter）
- LLM 完全看不到被移除的 tool
- 支援 glob pattern allow/deny

### Provider
- HTTP streaming 走 `@mariozechner/pi-ai` 的 streamSimple
- 也支援 CLI subprocess（spawn claude -p）作為 fallback
- OAuth setup-token 走訂閱額度（但 TOS 限制第三方使用）

### Internal Hook
- `src/hooks/internal-hooks.ts`，globalThis singleton + Map
- EventEmitter 模式，依序觸發

### 多人模式
- Identity tuple（platform:platformId → accountId），不用 auth table
- 7-tier session key 編碼身份
- DM/Group policy + allowlist
- per-account auth profile 選擇

## 規劃文件清單

| 文件 | 路徑 | 說明 |
|------|------|------|
| 統一架構 | `_planning/catclaw-platform-architecture.md` | V1.4（四面向審閱修正後） |
| Issues Tracker | `_planning/catclaw-issues-tracker.md` | 63 項待處理（含裁決欄） |
| 初版藍圖 | `_planning/catclaw-full-blueprint-v2.17.md` | 舊版（已被統一架構取代） |
| 多人設計 | `_planning/catclaw-multiuser-design.md` | 多人提案（已整合進統一架構） |
| Plugin 比較 | `_planning/discord-plugin-vs-catclaw.md` | Discord Plugin vs CatClaw |
| Plugin 安裝 | `_planning/discord-plugin-setup-guide.md` | Discord Plugin 安裝指南 |

## 時程

14 Sprint / 18-24 sessions / 6 Phase（含 Phase 0）
關鍵路徑：S0(Command-type Skill) → S1(基礎) → S3(記憶) → S5(Tool+AgentLoop) → S6(整合) → S9(帳號) → S12(遷移)

**S0（Phase 0，2026-03-25 完成驗證）**：在現行 CLI 架構上先實作 Skill 系統（兩種模式）。✅
- Command-type：CatClaw 直接執行 TypeScript skill（restart 等）→ 已驗證攔截正常
- Prompt-type：讀取 SKILL.md（OpenClaw 格式相容），注入 system prompt，Claude 執行
- tier 欄位定義但不強制；後接 S5 啟用 Permission Gate，S8 接 LLM tool_use
- OpenClaw 的 52 個 skill（SKILL.md）未來可直接複用
- 注意：Command-type skill Claude 不可見（攔截層在 Claude 之前）；Prompt-type 注入 system prompt 但 Phase 0 無執行路徑
- 坑：tsc 不複製 .md → build script 需加 cp；ch.send() 要 await 才能被 .catch() 捕獲

## 設計定位（2026-03-24 確認）

- [固] CatClaw 是原生多人平台，不是「單人系統加多人補丁」
- [固] 原子記憶 V2.17 是技術基礎（recall/extract/vector/write gate 演算法），不是框架
- [固] 多人功能（帳號/權限/三層記憶/session/tier）是 CatClaw 第一公民，不需要在 V2.17 找對應
- [固] V2.17 對照表用於確保核心記憶演算法沒有遺漏

## 安全設計審閱（2026-03-24）

10 層安全機制：身份→角色→Tool Tier 物理移除→Permission Gate→Safety Guard→Tool Loop Detection→Prompt Injection 防護（4 層：輸入淨化+system 隔離+tool 硬防護+記憶寫入過濾）→記憶分層→Write Gate→Config Validator

- [固] 比現行 CatClaw（`--dangerously-skip-permissions` 全開）和 OpenClaw 都安全
- [固] Prompt injection：不能 100% 防，但多層緩解（淨化+隔離+tool 硬擋+記憶過濾）
- [固] 啟動設定驗證：檢查危險 tier 設定、帳號無 identity、provider 無認證
- [固] 關鍵在正確設定 tier 和角色，架構本身是安全的

## 四面向審閱結果（2026-03-24）

108 項問題（架構 25 + 安全 30 + 功能 24 + 運維 29）→ 已修正 38 項，剩餘 63 項追蹤中

**已修正 CRITICAL（11 項，架構文件直接改）：**
- ✅ stream() → Promise<StreamResult>（含 events + stopReason + toolCalls）
- ✅ Agent Loop 改 EventBus emit（不直接 import workflow）
- ✅ allow tier ceiling（最多突破一級，owner 不可覆寫）
- ✅ PROTECTED_WRITE_PATHS 加 tools/skills + 新增 PROTECTED_READ_PATHS
- ✅ run_command 安全強化（白名單模式 + stdout cap + sanitized env）
- ✅ Indirect injection Layer 3.5（tool result 掃描 + 外部內容標記）
- ✅ Session 持久化（atomic write + TTL 清理 + PM2 恢復）
- ✅ Reply Handler 介面 + 分段策略
- ✅ Extract snapshot binding（防 race condition）
- ✅ 遷移補 CLAUDE.md/IDENTITY.md/settings.json
- ✅ 敏感值強制環境變數

**已修正架構類（16 項）：**
- ✅ guardian.ts → sync-gate.ts
- ✅ Channel 介面 + 新增 Channel 步驟
- ✅ EventBus 補 5 事件（provider:error/rateLimit, turn:queued/started, file:read）
- ✅ Agent Loop tool:error try-catch
- ✅ ToolContext 介面 + Tool.execute 簽名更新
- ✅ AvailableItem type 欄位
- ✅ Session config 擴充 + Rate limit config
- ✅ types/ + test/ + logs/ 目錄

**已修正功能類（11 項）：**
- ✅ Fix Escalation 獨立 timeout + early-exit
- ✅ Extract fire-and-forget
- ✅ Turn queue 規則（FIFO/depth 5/60s/cancel）
- ✅ AbortSignal 4 觸發條件
- ✅ 群組 system prompt 多人聲明
- ✅ OpenClaw Provider 純對話 passthrough
- ✅ Provider 中途切換限制
- ✅ Skill 內部 Tool bypass Permission Gate
- ✅ Cron 執行身份 + ephemeral session

**已決策（3 項，2026-03-24 確認）：**
1. ✅ file:modified → Tool 自標記（ToolResult.fileModified + modifiedPath）
2. ✅ Reply → edit message 逐步更新（3s flush，與現有 CatClaw 行為一致）
3. ✅ 討論串 → 乾淨新 session（recall 補 context，不繼承母頻道 messages）

**剩餘追蹤：** `_planning/catclaw-issues-tracker.md`（63 項：安全 19 + 架構 8 + 功能 8 + 運維 28）

**Why:** Wells 希望 CatClaw 成為獨立 AI 平台，記憶/安全/工具是平台能力不是 LLM 附屬品，能抽換 LLM，支援多人協作。
**How to apply:** 以統一架構文件為主要依據。變更需更新架構文件 + 記憶 atom。Issues tracker 追蹤非 CRITICAL 項目。
