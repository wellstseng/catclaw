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

function getRejectedPath(): string {
  return join(getStagingDir(), ".rejected.json");
}

interface RejectedEntry {
  ts: number;
  description?: string;
}

/** 讀 rejected ledger；相容舊格式（value 為純 number）。 */
function readRejected(): Record<string, RejectedEntry> {
  const p = getRejectedPath();
  if (!existsSync(p)) return {};
  try {
    const raw = JSON.parse(readFileSync(p, "utf-8")) as Record<string, number | RejectedEntry>;
    const out: Record<string, RejectedEntry> = {};
    for (const [k, v] of Object.entries(raw)) {
      out[k] = typeof v === "number" ? { ts: v } : v;
    }
    return out;
  } catch {
    return {};
  }
}

function writeRejected(ledger: Record<string, RejectedEntry>): void {
  try {
    writeFileSync(getRejectedPath(), JSON.stringify(ledger, null, 2), "utf-8");
  } catch (err) {
    log.warn(`[skill-candidate] rejected ledger 寫入失敗：${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Discard 時記下被否決的 slug（含 description 供語意去重），避免短期內原點子重新提案。 */
export function recordRejected(slug: string, description?: string): void {
  const s = sanitizeSlug(slug);
  if (!s) return;
  const ledger = readRejected();
  ledger[s] = { ts: Date.now(), description };
  writeRejected(ledger);
}

/** slug 在 rejectedDays 內被否決過 → return true（判官應 skip）。預設 30 天。 */
export function isRejected(slug: string, rejectedDays = 30): boolean {
  const e = readRejected()[sanitizeSlug(slug)];
  if (!e) return false;
  return Date.now() - e.ts < rejectedDays * 86_400_000;
}

/** 列出 rejectedDays 內被否決、且有 description 的項目（供語意去重比對）。 */
export function listRejectedDescriptions(rejectedDays = 30): Array<{ slug: string; description: string }> {
  const cutoff = Date.now() - rejectedDays * 86_400_000;
  return Object.entries(readRejected())
    .filter(([, e]) => e.ts >= cutoff && e.description)
    .map(([slug, e]) => ({ slug, description: e.description! }));
}

// ── D：接受率 metric ───────────────────────────────────────────────────────────

export interface CandidateStats {
  accepted: number;
  discarded: number;
  /** accepted / (accepted + discarded)，無資料回 null */
  acceptanceRate: number | null;
}

function getStatsPath(): string {
  return join(getStagingDir(), ".stats.json");
}

function readStatsRaw(): { accepted: number; discarded: number } {
  try {
    const d = JSON.parse(readFileSync(getStatsPath(), "utf-8")) as { accepted?: number; discarded?: number };
    return { accepted: d.accepted ?? 0, discarded: d.discarded ?? 0 };
  } catch {
    return { accepted: 0, discarded: 0 };
  }
}

/** accept/discard 結果累計，供 dashboard 觀測判官提案品質。 */
export function recordOutcome(outcome: "accepted" | "discarded"): void {
  const s = readStatsRaw();
  s[outcome] += 1;
  try {
    const dir = getStagingDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(getStatsPath(), JSON.stringify(s, null, 2), "utf-8");
  } catch (err) {
    log.warn(`[skill-candidate] stats 寫入失敗：${err instanceof Error ? err.message : String(err)}`);
  }
}

export function getCandidateStats(): CandidateStats {
  const s = readStatsRaw();
  const total = s.accepted + s.discarded;
  return { ...s, acceptanceRate: total > 0 ? s.accepted / total : null };
}

// ── C：語意去重（embedding + cosine）──────────────────────────────────────────

function cosine(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** 讀 _accepted/ 內已採納候選的 slug+description（供語意去重比對）。 */
function listAcceptedDescriptions(): Array<{ slug: string; description: string }> {
  const dir = getAcceptedDir();
  if (!existsSync(dir)) return [];
  const out: Array<{ slug: string; description: string }> = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".md")) continue;
    try {
      const fm = parseFrontmatter(readFileSync(join(dir, f), "utf-8"));
      if (fm["slug"] && fm["proposed_description"]) {
        out.push({ slug: fm["slug"], description: fm["proposed_description"] });
      }
    } catch { /* skip */ }
  }
  return out;
}

export interface SemanticDuplicate {
  slug: string;
  score: number;
  source: "pending" | "accepted" | "rejected";
}

/**
 * 對 pending + accepted + rejected 三池做語意去重。
 * embedding 不可用時 graceful 回 null（不擋提案）。
 * @param description 待提案 skill 的 description
 * @param threshold cosine 相似度門檻（>= 視為重複；預設 0.85）
 * @param rejectedDays rejected ledger 比對窗（預設 30）
 */
export async function findSemanticDuplicate(
  description: string,
  threshold = 0.85,
  rejectedDays = 30,
): Promise<SemanticDuplicate | null> {
  const text = (description || "").trim();
  if (!text) return null;

  const corpus: Array<{ slug: string; description: string; source: SemanticDuplicate["source"] }> = [
    ...listSkillCandidates().map(c => ({ slug: c.slug, description: c.description, source: "pending" as const })),
    ...listAcceptedDescriptions().map(c => ({ ...c, source: "accepted" as const })),
    ...listRejectedDescriptions(rejectedDays).map(c => ({ ...c, source: "rejected" as const })),
  ].filter(c => c.description && c.description.trim());

  if (corpus.length === 0) return null;

  try {
    const { embedTexts } = await import("../vector/embedding.js");
    const { vectors } = await embedTexts([text, ...corpus.map(c => c.description)]);
    if (vectors.length !== corpus.length + 1) return null; // embedding 不可用 / 數量不符 → 不擋
    const target = vectors[0]!;
    let best: SemanticDuplicate | null = null;
    for (let i = 0; i < corpus.length; i++) {
      const score = cosine(target, vectors[i + 1]!);
      if (score >= threshold && (!best || score > best.score)) {
        best = { slug: corpus[i]!.slug, score, source: corpus[i]!.source };
      }
    }
    return best;
  } catch (err) {
    log.debug(`[skill-candidate] 語意去重 skip（embedding 失敗）：${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
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
    recordOutcome("accepted");
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

/** Discard：unlink _staging 內檔（不動 _accepted/），並把 slug 記進 rejected ledger。 */
export function discardSkillCandidate(fileName: string): boolean {
  const src = join(getStagingDir(), fileName);
  if (!existsSync(src)) return false;
  try {
    // unlink 前先讀 slug + description 記進 rejected ledger（避免原點子短期回鍋；description 供語意去重）
    try {
      const fm = parseFrontmatter(readFileSync(src, "utf-8"));
      if (fm["slug"]) recordRejected(fm["slug"], fm["proposed_description"]);
    } catch { /* 讀不到 slug 就算了，不擋 discard */ }
    recordOutcome("discarded");
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
