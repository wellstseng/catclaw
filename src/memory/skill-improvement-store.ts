/**
 * @file memory/skill-improvement-store.ts
 * @description Skill Self-Improve 提案產生器（項目 10 Week 1）
 *
 * skill 執行遇到 error / exception 時，自動產生「改進提案」寫入 _staging/skill-improvements/。
 * 不直接修改 skill 本體（人格保護：Wendy 由 Wells 手工調教）。
 * 提案待 Wells 透過 /memory-review（Week 2 落地）審核：Accept / Modify / Discard。
 *
 * 觸發條件保守（避免噪音）：
 *   - 真錯誤（result.isError && !result.validation）
 *   - 拋例外（execute 內 throw）
 *   不觸發：validation 提示、successful results
 *
 * 不做（Week 2-4）：
 *   - /memory-review Skill Improvement tab（審核 UI）
 *   - skill-loader 載 improvement-atoms 整合進 skill context
 *   - dashboard 統計 / TTL 衰減 / 品質晉升
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { log } from "../logger.js";

export interface ProposeSkillOpts {
  skillName: string;
  triggeredBy: "exception" | "isError" | "retry" | "interruption" | "self-reflection";
  /** 簡化的 ctx（避免依賴 SkillContext type，store 不依賴 skill module） */
  ctx: { args: string; channelId: string; authorId: string };
  durationMs?: number;
  situationText?: string;
  observationText?: string;
  recommendationText?: string;
}

function getStagingDir(): string {
  return join(
    process.env["CATCLAW_HOME"] ?? join(homedir(), ".catclaw"),
    "workspace",
    "_staging",
    "skill-improvements",
  );
}

/** 產生 skill 改進提案，寫入 _staging。失敗只 warn，不拋出。回傳 path 或 null。 */
export function proposeSkillImprovement(opts: ProposeSkillOpts): string | null {
  try {
    const dir = getStagingDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const fileName = `${opts.skillName}-${opts.triggeredBy}-${ts}.md`;
    const filePath = join(dir, fileName);

    const content = `---
name: ${opts.skillName}-improvement-${ts}
description: skill 執行 ${opts.triggeredBy} 觸發的改進提案
type: skill-improvement
source: skill:${opts.skillName}
triggered_by: ${opts.triggeredBy}
confidence: draft
created_at: ${new Date().toISOString()}
channel_id: ${opts.ctx.channelId}
author_id: ${opts.ctx.authorId}
---

## 情境

${opts.situationText ?? `skill \`${opts.skillName}\` 在 channel=${opts.ctx.channelId} 執行時觸發 ${opts.triggeredBy}。`}

- args：\`${opts.ctx.args.slice(0, 200) || "(空)"}\`
${opts.durationMs != null ? `- 耗時：${opts.durationMs}ms\n` : ""}

## 觀察

${opts.observationText ?? "（待 Wells review 補充：本次失敗的 pattern / 缺口 / 例外狀況）"}

## 建議

${opts.recommendationText ?? "（待 Wells review 補充：可能的改進方向，例如修 description / 加參數驗證 / 補錯誤訊息）"}

## 證據

- triggered_by: ${opts.triggeredBy}
- raw args: \`${opts.ctx.args}\`

---

> 自動產生於 ${new Date().toISOString()}（項目 10 Week 1）。
> 待 Week 2 落地的 \`/memory-review\` 審核：Accept → \`improvement-atoms/\` / Modify / Discard。
> 不採用即手動刪除此檔。
`;

    writeFileSync(filePath, content, "utf-8");
    log.info(`[skill-improvement] 提案已寫入 ${filePath}`);
    return filePath;
  } catch (err) {
    log.warn(`[skill-improvement] 提案寫入失敗：${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
