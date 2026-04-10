---
name: catclaw-systemprompt-structure
description: CatClaw（溫蒂）送給 LLM 的 system prompt 完整組裝結構與各區塊順序
type: project
---

CatClaw system prompt 由 3 階段 13 個動態區塊依序拼接，最終送給 LLM 的 systemPrompt 字串結構如下：

**Why:** Sprint 8 Trace 審計時釐清的完整組裝流程，方便日後 debug prompt 問題。

**How to apply:** 新增/修改 prompt 區塊時，確認它在哪個階段、哪個 priority，以及 trace 是否有記錄。

## 階段 1: discord.ts 組裝（傳入 agent-loop 前）

| 順序 | 區塊 | 來源 | 說明 |
|------|------|------|------|
| 1 | Memory Recall | `memoryEngine.recall()` → `buildContext()` | atom 內容，注入在最前面 |
| 2 | Channel Override | `getChannelSystemOverride()` | 頻道特定 system prompt |
| 3 | Mode Extras | `workspace/prompts/*.md` | mode preset 額外 prompt |
| 4 | Assembler 模組 | `assembleSystemPrompt()` | 按 priority 排序的模組群 |

### Assembler 模組（prompt-assembler.ts）

| Priority | Name | 說明 | Intent 過濾 |
|----------|------|------|-------------|
| 5 | date-time | 當前時間 | 全模式 |
| 10 | identity | 身份 + 多人頻道說話者 | 全模式 |
| 15 | catclaw-md | CATCLAW.md 層級繼承 | 全模式 |
| 20 | tools-usage | 工具使用規則 | coding + research |
| 30 | coding-rules | 行為約束 | coding only |
| 40 | git-rules | Git 安全協定 | coding only |
| 50 | output-format | 輸出規則 | 全模式 |
| 55 | discord-reply | Discord 回覆規則 | coding + research |
| 60 | memory-rules | 記憶系統操作說明 | 全模式 |

## 階段 2: agent-loop.ts 追加

| 順序 | 區塊 | 條件 |
|------|------|------|
| 5 | memory-context | `memoryRecall.enabled`（子 agent 場景） |
| 6 | group-isolation | `isGroupChannel` |
| 7 | plan-mode | Plan Mode 啟用時 |
| 8 | deferred-tools | 有 deferred tool 定義時 |
| 9 | token-nudge | context 使用率 ≥ 60% |
| 10 | session-note | `sessionMemory.enabled` 且有筆記 |

## 階段 3: messages 層（非 systemPrompt）

| 區塊 | 說明 |
|------|------|
| Inbound History | 頻道歷史訊息（Bucket A/B + Decay II） |
| Messages | 對話紀錄（CE 壓縮前/後） |

## Trace 追蹤

- `TracePromptAssembly`: intent / modulesActive / modulesSkipped / extraBlocks / agentLoopBlocks
- `TracePromptBreakdown` (context snapshot): memoryContext / channelOverride / modeExtras / assemblerModules / agentLoopBlocks
- `TraceProviderSelection`: providerId / providerType / model
