# skill-improvement-store

> 對應原始碼：`src/memory/skill-improvement-store.ts` + `src/skills/registry.ts runSkill`
> 建立日期：2026-05-04（CatClaw 整合 Hermes 計畫項目 10 Week 1）

## 用途

skill 執行遇真錯誤 / 例外時，自動產生「改進提案」寫入 `_staging/skill-improvements/`。
**不直接修改 skill 本體**（人格保護：Wendy 由 Wells 手工調教的資產）。
提案待 `/memory-review`（Week 2 落地）審核：Accept / Modify / Discard。

## 設計核心原則

```
Skill 執行完
  → 觸發條件命中（error / exception）
  → 產生「改進提案」（atom-style frontmatter + 4 section）
  → 寫進 _staging（待審核 queue）
  → 不改 skill 本體 / SKILL.md
```

**保住 CatClaw 的「原子記憶晉升機制」血統。** 改的是 skill context（後續 Week 3 整合
`improvement-atoms/`），不是 skill 本身。

## Exports（store）

```typescript
export interface ProposeSkillOpts {
  skillName: string;
  triggeredBy: "exception" | "isError" | "retry" | "interruption";
  ctx: { args: string; channelId: string; authorId: string };
  durationMs?: number;
  situationText?: string;
  observationText?: string;
  recommendationText?: string;
}

export function proposeSkillImprovement(opts: ProposeSkillOpts): string | null;
```

## Exports（registry wrapper）

```typescript
// src/skills/registry.ts
export async function runSkill(skill: Skill, ctx: SkillContext): Promise<SkillResult>;
```

包裝 `skill.execute(ctx)`：
- 真錯誤（`isError && !validation`）→ 觸發 `_proposeImprovement(triggeredBy="isError")`
- `execute` 拋例外 → 觸發 `_proposeImprovement(triggeredBy="exception")` + re-throw
- transparent re-throw：caller 端 try/catch 行為不變

## 觸發條件

| 情況 | 觸發提案？ | 來源 |
|------|----------|------|
| `result.isError === true && result.validation !== true` | ✅ 真錯誤 | runSkill wrapper |
| `execute` 拋例外 | ✅ exception | runSkill wrapper |
| 成功 result + LLM 判斷需提案 | ✅ self-reflection（commit fc5dccb） | self-reflect.ts |
| `result.isError && validation === true`（語法/usage 提示） | ❌ 不算錯誤 | — |
| 成功 result + LLM 判斷不需提案 | ❌ | — |
| retry / interruption | ❌（catclaw 端無 emit source） | — |

設計理由：避免噪音淹沒 `_staging/`，先聚焦真錯誤。

## 提案格式

`~/.catclaw/workspace/_staging/skill-improvements/<skill>-<trigger>-<ts>.md`

```markdown
---
name: <skill-name>-improvement-<ts>
description: skill 執行 <trigger> 觸發的改進提案
type: skill-improvement
source: skill:<skill-name>
triggered_by: <isError|exception|...>
confidence: draft
created_at: <ISO ts>
channel_id: <channelId>
author_id: <authorId>
---

## 情境
（自動：skill 名 / channel / args / 耗時）

## 觀察
（待 Wells review 補充）

## 建議
（待 Wells review 補充）

## 證據
（args / triggered_by）
```

## 接入點（3 處 caller 改用 runSkill）

| Caller | 路徑 | 觸發場景 |
|--------|------|---------|
| Discord 訊息路徑 | `src/discord.ts` | 使用者在 Discord 下 `/xxx` 觸發 skill |
| Slash command（/help） | `src/slash.ts` | Discord slash command 執行 |
| LLM 呼叫 skill tool | `src/tools/builtin/skill.ts` | LLM 內呼叫 `skill` tool |

3 處原 `await skill.execute(ctx)` 改 `await runSkill(skill, ctx)`（lazy import 避免循環依賴）。

## 不做（Week 2-4）

- `/memory-review` Skill Improvement tab（Accept / Modify / Discard 三動作 UI）
- `improvement-atoms/` 落地：accept 後從 `_staging` 搬到
  `~/.catclaw/workspace/skills/{skillId}/improvement-atoms/`
- skill-loader 載 improvement-atoms 整合進 skill context（改 skill 載入流程，不改本體）
- Dashboard 統計：提案數量 / 採用率 / TTL 衰減 / `[觀]→[固]` 品質晉升閉環
