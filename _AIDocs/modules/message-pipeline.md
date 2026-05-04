# message-pipeline.ts — 統一訊息管線

> 原始碼：`src/core/message-pipeline.ts`
> 更新日期：2026-04-11
> keywords: pipeline, 管線, 統一管線, message-pipeline, recall, assembler, trace, web chat, session 共用

## 概述

所有平台（Discord / Web Chat / Cron）共用的訊息處理管線。
呼叫端只需提供平台參數 + 模組開關，管線自動跑完共用邏輯。

## 管線步驟

| # | 步驟 | 可選 | 說明 |
|---|------|------|------|
| 1 | Trace 建立 | 否 | 沿用呼叫端傳入的 trace 或建立新的 |
| 2 | Memory Recall | 是 | `memEngine.recall()` + `buildContext()` → 注入 system prompt |
| 3 | Mode Extras | 是 | 載入 `workspace/prompts/*.md` 模式額外 prompt |
| 4 | Intent Detection | 否 | `detectIntent()` + `getModulesForIntent()` |
| 5 | System Prompt 組裝 | 否 | `assembleSystemPrompt()` 含 extraBlocks + moduleFilter |
| 6 | Prompt Assembly Trace | 否 | 記錄組裝結果到 trace |
| 7 | Provider Selection Trace | 否 | 記錄 provider 選擇到 trace |
| 8 | Inbound History | 是 | `inboundStore.consumeForInjection()` → messages 層注入 |
| 9 | Session Memory opts | 是 | 組裝 sessionMemory 設定 |
| 10 | Context End Trace | 否 | 記錄 context token 數到 trace |

## 公開介面

### `runMessagePipeline(input: PipelineInput): Promise<PipelineResult>`

#### PipelineInput 主要欄位

| 欄位 | 類型 | 預設 | 說明 |
|------|------|------|------|
| `prompt` | `string` | 必填 | 使用者訊息 |
| `platform` | `"discord" \| "api" \| "cron"` | 必填 | 平台識別 |
| `channelId` | `string` | 必填 | 頻道 ID |
| `accountId` | `string` | 必填 | 帳號 ID |
| `provider` | `LLMProvider` | 必填 | 已選定的 provider |
| `trace` | `MessageTrace` | 自動建立 | 沿用已有 trace |
| `memoryRecall` | `boolean` | `true` | 開關 |
| `inboundHistory` | `boolean` | `false` | 開關 |
| `sessionMemory` | `boolean` | `true` | 開關 |
| `modeExtras` | `boolean` | `false` | 開關 |
| `channelOverride` | `string` | - | 平台專屬注入 |
| `role` | `string` | `"guest"` | 使用者角色 |
| `traceCategory` | `TraceCategory` | - | Trace 分類 |
| `projectId` | `string` | - | 專案 ID |
| `isGroupChannel` | `boolean` | - | 是否群組頻道 |
| `speakerDisplay` | `string` | - | 說話者顯示名稱 |
| `modeName` | `string` | - | 模式名稱 |
| `activeMcpServers` | `string[]` | - | 啟用的 MCP server |
| `conversationLabel` | `string` | - | 對話標籤 |
| `additionalExtraBlocks` | `Array` | - | 額外 system prompt 區塊 |
| `modePreset` | `ModePreset` | `{ thinking: null }` | 模式 preset |

#### PipelineResult 主要欄位

| 欄位 | 說明 |
|------|------|
| `systemPrompt` | 組裝完成的 system prompt |
| `trace` | MessageTrace 實例（傳入 agentLoop） |
| `memoryContext` | 記憶注入原始文字（用於 promptBreakdownHints） |
| `channelOverride` | Channel override 原始文字 |
| `modeExtras` | Mode extras 原始文字 |
| `intent` | Intent 偵測結果 |
| `inboundContext` | Inbound History 文字（傳入 agentLoop） |
| `sessionMemoryOpts` | Session Memory 設定（展開到 agentLoopOpts） |
| `promptBreakdownHints` | 傳入 agentLoop 的 breakdown 提示 |
| `assemblerTrace` | Assembler 模組追蹤結果 |

## 呼叫範例

### Discord（discord.ts）

```ts
const pipeline = await runMessagePipeline({
  prompt, platform: "discord", trace,
  channelId, accountId, provider,
  role: accountRole, isGroupChannel: true,
  memoryRecall: true, inboundHistory: true,
  modeExtras: true, sessionMemory: true,
  channelOverride: getChannelSystemOverride(channelId),
  modePreset, modeName, activeMcpServers: ["discord"],
});
```

### Web Chat（dashboard.ts /api/chat）

```ts
const pipeline = await runMessagePipeline({
  prompt: message, platform: "api",
  channelId, accountId, provider,
  role: "platform-owner",
  memoryRecall: true, sessionMemory: true,
  modeExtras: true, inboundHistory: true,
});
```

## Session 共用機制

Web Chat 支援選擇任意現有 session（包含 Discord 的）。
選了 `discord:ch:123456` → 直接用該 session key → 兩邊共用同一段對話歷史。
未選 → 自動建立 `web:ch:dashboard-{timestamp}` 新 session。

## v3 改動（2026-05-04 — CatClaw 整合 Hermes 計畫項目 8/9）

對應 commits：`9bf1e86` / `0f98164`（含 v3-followup `68b84ec`）。

### 改動
- **`sanitizeMemoryText` 後新增 `expandReferences` 階段**（項目 8）：
  - `hasReferences()` 快速 check 避免每訊息都跑展開
  - 命中 → 解析 `@file:` / `@folder:` / `@git:` / `@url:` / `@diff` / `@staged` 並 expand 到訊息末尾
  - 失敗保留原 `@xxx` + `[inline-ref ⚠️ 失敗]` block
- **未命中 @ref 時跑啟發式偵測**（項目 8 補洞，plan §設計決策第 3 條）：
  - regex `/\b(?:src\/[\w./-]+\.\w+|...)\b/g` 偵測使用者訊息含的檔案路徑
  - trace 記錄 `pathHintCandidates`（最多 5 個 unique）— 純 informational，**不修改 prompt 維持 cache**

### 接入
- `trace.recordContextStart()` 後：若 `_refExpansionResults.length > 0` → `trace.recordReferencesExpanded()`；若 `_pathHintCandidates.length > 0` → `trace.recordPathHintCandidates()`
- user message 進入後（即 prompt assembly 前）→ `indexMessage(role="user")` 寫入跨 session 訊息索引（項目 9 Phase 1）

詳見：`~/WellsDB/知識庫/CatClaw 整合 Hermes 實作報告 v3.md`
