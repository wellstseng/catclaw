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

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
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

// ── Cooldown：避免同 skill+triggeredBy 短時間內反覆累積提案 ──────────────────

function getCooldownPath(): string {
  return join(getStagingDir(), ".cooldown.json");
}

function readCooldown(): Record<string, number> {
  const p = getCooldownPath();
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as Record<string, number>;
  } catch {
    return {};
  }
}

function writeCooldown(ledger: Record<string, number>): void {
  const p = getCooldownPath();
  try {
    const dir = join(p, "..");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(p, JSON.stringify(ledger, null, 2), "utf-8");
  } catch (err) {
    log.warn(`[skill-improvement] cooldown 寫入失敗：${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 同 skill+triggeredBy 在 cooldownHours 內已提案過 → return true（跳過） */
export function isInCooldown(skillName: string, triggeredBy: string, cooldownHours = 24): boolean {
  const ledger = readCooldown();
  const key = `${skillName}::${triggeredBy}`;
  const last = ledger[key];
  if (!last) return false;
  return Date.now() - last < cooldownHours * 3_600_000;
}

// ── TTL Sweep：自動清理過期提案 ────────────────────────────────────────────

const DEFAULT_TTL_DAYS = 14;

/**
 * 清理過期 staging 提案。
 * @param ttlDays 提案保留天數（預設 14）
 * @returns 已刪除的檔案數
 */
export function sweepExpiredImprovements(ttlDays = DEFAULT_TTL_DAYS): number {
  const dir = getStagingDir();
  if (!existsSync(dir)) return 0;
  const cutoffMs = Date.now() - ttlDays * 86_400_000;
  let removed = 0;
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".md")) continue; // 不掃 .cooldown.json
      const filePath = join(dir, f);
      try {
        const st = statSync(filePath);
        if (st.mtimeMs < cutoffMs) {
          unlinkSync(filePath);
          removed++;
        }
      } catch { /* skip */ }
    }
    if (removed > 0) log.info(`[skill-improvement] TTL sweep: 移除 ${removed} 份過期提案 (>${ttlDays}d)`);
  } catch (err) {
    log.warn(`[skill-improvement] sweep 失敗：${err instanceof Error ? err.message : String(err)}`);
  }
  return removed;
}

function getCatclawHome(): string {
  return process.env["CATCLAW_HOME"] ?? join(homedir(), ".catclaw");
}

function getImprovementAtomsDir(skillName: string): string {
  return join(getCatclawHome(), "workspace", "skills", skillName, "improvement-atoms");
}

// ── Week 2 review API：list / accept / discard（項目 10 Week 2）────────────

export interface SkillImprovementEntry {
  fileName: string;
  filePath: string;
  skillName?: string;
  triggeredBy?: string;
  createdAt?: string;
  channelId?: string;
  authorId?: string;
  /** body 全文（含 frontmatter）— UI 渲染用 */
  rawText: string;
  /** 檔案大小 bytes */
  size: number;
  /** 檔案 mtime（unix ms） */
  mtimeMs: number;
}

function parseFrontmatter(text: string): Record<string, string> {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const fm: Record<string, string> = {};
  for (const line of m[1]!.split("\n")) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) fm[kv[1]!] = kv[2]!.trim();
  }
  return fm;
}

/** 列 _staging 內所有提案（newest first） */
export function listSkillImprovements(): SkillImprovementEntry[] {
  const dir = getStagingDir();
  if (!existsSync(dir)) return [];
  const entries: SkillImprovementEntry[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".md")) continue;
    const filePath = join(dir, f);
    try {
      const stat = statSync(filePath);
      const rawText = readFileSync(filePath, "utf-8");
      const fm = parseFrontmatter(rawText);
      entries.push({
        fileName: f,
        filePath,
        skillName: fm["source"]?.replace(/^skill:/, "") ?? undefined,
        triggeredBy: fm["triggered_by"],
        createdAt: fm["created_at"],
        channelId: fm["channel_id"],
        authorId: fm["author_id"],
        rawText,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      });
    } catch (err) {
      log.warn(`[skill-improvement] 列舉跳過 ${f}：${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * Accept：搬提案到 ~/.catclaw/workspace/skills/{skillName}/improvement-atoms/{fileName}
 * 從 frontmatter `source: skill:<name>` 推 skillName，找不到時用 caller 傳入的 skillName。
 * 回傳目標路徑或 null。
 */
export function acceptSkillImprovement(fileName: string, fallbackSkillName?: string): string | null {
  const stagingDir = getStagingDir();
  const src = join(stagingDir, fileName);
  if (!existsSync(src)) {
    log.warn(`[skill-improvement] accept 失敗：${src} 不存在`);
    return null;
  }
  let skillName: string | undefined = fallbackSkillName;
  try {
    const fm = parseFrontmatter(readFileSync(src, "utf-8"));
    if (fm["source"]) skillName = fm["source"].replace(/^skill:/, "");
  } catch {
    /* 用 fallback */
  }
  if (!skillName) {
    log.warn(`[skill-improvement] accept 失敗：無法推 skillName ${fileName}`);
    return null;
  }
  const targetDir = getImprovementAtomsDir(skillName);
  if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });
  const target = join(targetDir, fileName);
  try {
    renameSync(src, target);
    log.info(`[skill-improvement] accept ${fileName} → ${target}`);
    return target;
  } catch (err) {
    log.warn(`[skill-improvement] accept 失敗 ${fileName}：${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** Discard：unlink _staging 內檔 */
export function discardSkillImprovement(fileName: string): boolean {
  const src = join(getStagingDir(), fileName);
  if (!existsSync(src)) return false;
  try {
    unlinkSync(src);
    log.info(`[skill-improvement] discard ${fileName}`);
    return true;
  } catch (err) {
    log.warn(`[skill-improvement] discard 失敗 ${fileName}：${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/**
 * Week 4 補洞 — TTL 衰減：超過 ttlDays 仍在 _staging 的提案 auto-discard。
 * 預設 30 天。回傳清掉的數量。
 */
export function purgeStaleSkillImprovements(ttlDays = 30): number {
  const dir = getStagingDir();
  if (!existsSync(dir)) return 0;
  const cutoff = Date.now() - ttlDays * 86_400_000;
  let cleaned = 0;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".md")) continue;
    const filePath = join(dir, f);
    try {
      const stat = statSync(filePath);
      if (stat.mtimeMs < cutoff) {
        unlinkSync(filePath);
        cleaned++;
      }
    } catch { /* 靜默 */ }
  }
  if (cleaned > 0) {
    log.info(`[skill-improvement] purge: ${cleaned} 個過期提案清掉（TTL ${ttlDays} 天）`);
  }
  return cleaned;
}

/** Week 3：列 skill 已 promoted 的 improvement-atoms（讓 skill-loader 整合） */
export function listImprovementAtoms(skillName: string): Array<{ fileName: string; filePath: string; rawText: string }> {
  const dir = getImprovementAtomsDir(skillName);
  if (!existsSync(dir)) return [];
  const out: Array<{ fileName: string; filePath: string; rawText: string }> = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".md")) continue;
    const filePath = join(dir, f);
    try {
      out.push({ fileName: f, filePath, rawText: readFileSync(filePath, "utf-8") });
    } catch { /* skip */ }
  }
  return out;
}

/** 產生 skill 改進提案，寫入 _staging。失敗只 warn，不拋出。回傳 path 或 null（cooldown 命中時 null）。 */
export function proposeSkillImprovement(opts: ProposeSkillOpts & { cooldownHours?: number }): string | null {
  const cooldownHours = opts.cooldownHours ?? 24;
  if (isInCooldown(opts.skillName, opts.triggeredBy, cooldownHours)) {
    log.debug(`[skill-improvement] ${opts.skillName}::${opts.triggeredBy} 冷卻中（${cooldownHours}h），跳過提案`);
    return null;
  }

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
    // 更新 cooldown ledger
    const ledger = readCooldown();
    ledger[`${opts.skillName}::${opts.triggeredBy}`] = Date.now();
    writeCooldown(ledger);
    log.info(`[skill-improvement] 提案已寫入 ${filePath}`);
    return filePath;
  } catch (err) {
    log.warn(`[skill-improvement] 提案寫入失敗：${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
