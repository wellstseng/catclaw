/**
 * @file memory/skill-candidate-store.ts
 * @description Skill Candidate 提案（hermes 自動學習 a 部分）— 與 skill-improvement-store 平行。
 *
 * 差異：
 *   skill-improvement = 既有 skill 跑完出 issue → 提案改進該 skill（accept 搬到 improvement-atoms/）
 *   skill-candidate   = LLM 判官從對話脈絡發現「應該存在但還沒有的 skill」→ 提案新 skill
 *                       （accept 由 dashboard 觸發 spawn_subagent 給 agent 自己 write_file 寫 SKILL.md）
 *
 * Cooldown ledger：同 slug 24h 內只提案一次，避免噪音 — 即使 LLM 判斷再次需要也跳過。
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { log } from "../logger.js";

export type SkillCandidateTrigger = "turn-base" | "idle";

export type SkillPriority = "low" | "med" | "high";

export interface ProposeSkillCandidateOpts {
  slug: string;
  description: string;
  whenToUse: string;
  sampleWorkflow: string;
  reason: string;
  triggeredBy: SkillCandidateTrigger;
  channelId: string;
  agentId: string;
  sessionKey: string;
  /** 預設 24h；caller 可從 config 傳 */
  cooldownHours?: number;
  /** 推薦執行程度（LLM judge 評分） */
  priority?: SkillPriority;
  /** 緊急性數值 1-10（LLM judge 評分） */
  urgencyScore?: number;
}

export interface SkillCandidateEntry {
  fileName: string;
  filePath: string;
  slug: string;
  description: string;
  whenToUse?: string;
  sampleWorkflow?: string;
  triggeredBy?: string;
  channelId?: string;
  agentId?: string;
  createdAt?: string;
  authoredAt?: string;
  authoredPath?: string;
  /** 推薦執行程度 */
  priority?: SkillPriority;
  /** 緊急性 1-10 */
  urgencyScore?: number;
  rawText: string;
  size: number;
  mtimeMs: number;
}

function getCatclawHome(): string {
  return process.env["CATCLAW_HOME"] ?? join(homedir(), ".catclaw");
}

function getStagingDir(): string {
  return join(getCatclawHome(), "workspace", "_staging", "skill-candidates");
}

function getAcceptedDir(): string {
  return join(getStagingDir(), "_accepted");
}

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
    writeFileSync(p, JSON.stringify(ledger, null, 2), "utf-8");
  } catch (err) {
    log.warn(`[skill-candidate] cooldown 寫入失敗：${err instanceof Error ? err.message : String(err)}`);
  }
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

function sanitizeSlug(slug: string): string {
  return slug.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
}

/** 提案前檢查：同 slug 在 cooldownHours 內已提案過 → return true（跳過） */
export function isInCooldown(slug: string, cooldownHours = 24): boolean {
  const ledger = readCooldown();
  const last = ledger[sanitizeSlug(slug)];
  if (!last) return false;
  return Date.now() - last < cooldownHours * 3_600_000;
}

/** 寫提案到 _staging/skill-candidates/。失敗 / 冷卻中 → return null。 */
export function proposeSkillCandidate(opts: ProposeSkillCandidateOpts): string | null {
  const slug = sanitizeSlug(opts.slug);
  if (!slug) {
    log.warn(`[skill-candidate] slug 清洗後為空：${opts.slug}`);
    return null;
  }
  const cooldownHours = opts.cooldownHours ?? 24;
  if (isInCooldown(slug, cooldownHours)) {
    log.debug(`[skill-candidate] ${slug} 冷卻中（${cooldownHours}h），跳過提案`);
    return null;
  }

  try {
    const dir = getStagingDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const fileName = `${slug}-${ts}.md`;
    const filePath = join(dir, fileName);

    const priority = opts.priority ?? "med";
    const urgencyScore = Math.max(1, Math.min(10, opts.urgencyScore ?? 5));
    const content = `---
name: skill-candidate-${slug}-${ts}
description: LLM 判官提案的新 skill 候選
type: skill-candidate
slug: ${slug}
proposed_description: ${escapeYamlValue(opts.description)}
triggered_by: ${opts.triggeredBy}
created_at: ${new Date().toISOString()}
channel_id: ${opts.channelId}
agent_id: ${opts.agentId}
session_key: ${opts.sessionKey}
priority: ${priority}
urgency_score: ${urgencyScore}
---

## 提案 Skill

- **slug**：\`${slug}\`
- **description**：${opts.description}
- **推薦執行**：${priority} (urgency=${urgencyScore}/10)

## 何時使用 (whenToUse)

${opts.whenToUse}

## 範例 workflow (sampleWorkflow)

${opts.sampleWorkflow}

## 判官理由

${opts.reason}

---

> 自動產生於 ${new Date().toISOString()}（hermes 自動學習 a / trigger=${opts.triggeredBy}）。
> Dashboard「技能提案」分頁 Accept 後會啟動 agent 自動寫 SKILL.md；Discard 即手動丟掉。
> 同 slug ${cooldownHours}h 冷卻中，重複建議會被擋。
`;

    writeFileSync(filePath, content, "utf-8");
    const ledger = readCooldown();
    ledger[slug] = Date.now();
    writeCooldown(ledger);
    log.info(`[skill-candidate] 提案已寫入 ${fileName}（trigger=${opts.triggeredBy}）`);
    return filePath;
  } catch (err) {
    log.warn(`[skill-candidate] 提案寫入失敗：${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// ── TTL Sweep ────────────────────────────────────────────────────────────────

const DEFAULT_TTL_DAYS = 30;

/**
 * 清理過期 candidate 提案。
 * @param ttlDays 提案保留天數（預設 30）
 * @returns 已刪除的檔案數
 */
export function sweepExpiredCandidates(ttlDays = DEFAULT_TTL_DAYS): number {
  const dir = getStagingDir();
  if (!existsSync(dir)) return 0;
  const cutoffMs = Date.now() - ttlDays * 86_400_000;
  let removed = 0;
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".md")) continue;
      const filePath = join(dir, f);
      try {
        const st = statSync(filePath);
        if (st.mtimeMs < cutoffMs) {
          unlinkSync(filePath);
          removed++;
        }
      } catch { /* skip */ }
    }
    if (removed > 0) log.info(`[skill-candidate] TTL sweep: 移除 ${removed} 份過期提案 (>${ttlDays}d)`);
  } catch (err) {
    log.warn(`[skill-candidate] sweep 失敗：${err instanceof Error ? err.message : String(err)}`);
  }
  return removed;
}

/** 列 _staging 內所有提案（newest first），不含 _accepted/ 子目錄。 */
export function listSkillCandidates(): SkillCandidateEntry[] {
  const dir = getStagingDir();
  if (!existsSync(dir)) return [];
  const entries: SkillCandidateEntry[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".md")) continue;
    const filePath = join(dir, f);
    try {
      const stat = statSync(filePath);
      const rawText = readFileSync(filePath, "utf-8");
      const fm = parseFrontmatter(rawText);
      const priorityRaw = fm["priority"];
      const priority = (priorityRaw === "low" || priorityRaw === "med" || priorityRaw === "high")
        ? priorityRaw
        : undefined;
      const urgencyScoreRaw = fm["urgency_score"] ? parseInt(fm["urgency_score"], 10) : undefined;
      const urgencyScore = (typeof urgencyScoreRaw === "number" && !isNaN(urgencyScoreRaw))
        ? Math.max(1, Math.min(10, urgencyScoreRaw))
        : undefined;
      entries.push({
        fileName: f,
        filePath,
        slug: fm["slug"] ?? f.replace(/\.md$/, ""),
        description: fm["proposed_description"] ?? "",
        triggeredBy: fm["triggered_by"],
        channelId: fm["channel_id"],
        agentId: fm["agent_id"],
        createdAt: fm["created_at"],
        authoredAt: fm["authored_at"],
        authoredPath: fm["authored_path"],
        priority,
        urgencyScore,
        rawText,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      });
    } catch (err) {
      log.warn(`[skill-candidate] 列舉跳過 ${f}：${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** 讀單一提案。找不到回 null。 */
export function readSkillCandidate(fileName: string): SkillCandidateEntry | null {
  const list = listSkillCandidates();
  return list.find(e => e.fileName === fileName) ?? null;
}

/**
 * Accept：標記提案已交給 agent author（不直接搬，等 author 完成後再搬到 _accepted/）。
 * 回傳 candidate 內容讓 caller 拿來組 spawn_subagent prompt。
 */
export function markCandidateAccepted(fileName: string, targetAgentId: string): SkillCandidateEntry | null {
  const cand = readSkillCandidate(fileName);
  if (!cand) {
    log.warn(`[skill-candidate] markAccepted 失敗：${fileName} 不存在`);
    return null;
  }
  try {
    const stamped = cand.rawText.replace(
      /^---\n([\s\S]*?)\n---/,
      (_match, fm: string) => `---\n${fm}\naccept_target_agent: ${targetAgentId}\naccept_at: ${new Date().toISOString()}\n---`,
    );
    writeFileSync(cand.filePath, stamped, "utf-8");
    log.info(`[skill-candidate] accept ${fileName} → agent=${targetAgentId}（等 author spawn 完工）`);
    return cand;
  } catch (err) {
    log.warn(`[skill-candidate] markAccepted 失敗 ${fileName}：${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** Author 寫完後搬提案到 _accepted/，frontmatter 補 authored_at / authored_path。 */
export function recordCandidateAuthored(fileName: string, authoredPath: string): string | null {
  const stagingDir = getStagingDir();
  const acceptedDir = getAcceptedDir();
  const src = join(stagingDir, fileName);
  if (!existsSync(src)) {
    log.warn(`[skill-candidate] recordAuthored 失敗：${src} 不存在`);
    return null;
  }
  try {
    if (!existsSync(acceptedDir)) mkdirSync(acceptedDir, { recursive: true });
    const raw = readFileSync(src, "utf-8");
    const stamped = raw.replace(
      /^---\n([\s\S]*?)\n---/,
      (_match, fm: string) => `---\n${fm}\nauthored_at: ${new Date().toISOString()}\nauthored_path: ${authoredPath}\n---`,
    );
    const target = join(acceptedDir, fileName);
    writeFileSync(target, stamped, "utf-8");
    unlinkSync(src);
    log.info(`[skill-candidate] authored ${fileName} → ${authoredPath}`);
    return target;
  } catch (err) {
    log.warn(`[skill-candidate] recordAuthored 失敗 ${fileName}：${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** Discard：unlink _staging 內檔（不動 _accepted/）。 */
export function discardSkillCandidate(fileName: string): boolean {
  const src = join(getStagingDir(), fileName);
  if (!existsSync(src)) return false;
  try {
    unlinkSync(src);
    log.info(`[skill-candidate] discard ${fileName}`);
    return true;
  } catch (err) {
    log.warn(`[skill-candidate] discard 失敗 ${fileName}：${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/** TTL 衰減：超過 ttlDays 仍在 _staging 的提案 auto-discard（_accepted/ 保留）。預設 14 天。 */
export function purgeStaleSkillCandidates(ttlDays = 14): number {
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
    log.info(`[skill-candidate] purge: ${cleaned} 個過期提案清掉（TTL ${ttlDays} 天）`);
  }
  return cleaned;
}

function escapeYamlValue(s: string): string {
  // 簡單版：把換行壓掉、引號跳脫
  return s.replace(/\n/g, " ").replace(/"/g, '\\"').slice(0, 300);
}
