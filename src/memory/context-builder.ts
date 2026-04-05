/**
 * @file memory/context-builder.ts
 * @description Context 組裝 — ACT-R 排序 + Budget 分配 + Token Diet
 *
 * R6: ACT-R Activation 排序（B_i ≈ ln(confirmations * t^{-0.5})）
 * R7: Context Budget ≤3000 tokens，三層比例 30/40/30
 * R8: Token Diet：strip metadata fields + ## 行動 / ## 演化日誌 section
 * R13: Section-Level 注入（atom >300 tokens 時分區，保留 top-3 chunks）
 * R14: Staleness — 掃描 atom 內容中的檔案路徑引用，不存在 → 標記過時
 */

import { existsSync } from "node:fs";
import { log } from "../logger.js";
import type { AtomFragment, MemoryLayer } from "./recall.js";
import { computeActivation } from "./atom.js";

// ── Token 估算 ────────────────────────────────────────────────────────────────

/** 粗估 token 數：CJK≈1/char，ASCII≈0.75/char */
export function estimateTokens(text: string): number {
  let count = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    count += (cp > 0x2E7F) ? 1 : 0.75;
  }
  return Math.ceil(count);
}

// ── ACT-R ─────────────────────────────────────────────────────────────────────

/** ACT-R activation（0.3）+ 相似度（0.7）加權組合分數 */
function actRScore(frag: AtomFragment): number {
  return computeActivation(frag.atom) * 0.3 + frag.score * 0.7;
}

// ── Token Diet ────────────────────────────────────────────────────────────────

const METADATA_PATTERNS = [
  /^-\s+(Scope|Confidence|Trigger|Triggers|Last-used|Confirmations|Related|Description):.*$/gim,
  /^##\s+行動\s*\n[\s\S]*?(?=\n##|\n$|$)/gm,
  /^##\s+演化日誌\s*\n[\s\S]*?(?=\n##|\n$|$)/gm,
];

function tokenDiet(text: string): string {
  let result = text;
  for (const pat of METADATA_PATTERNS) {
    result = result.replace(pat, "");
  }
  // 清理多餘空行
  result = result.replace(/\n{3,}/g, "\n\n").trim();
  return result;
}

// ── Section-Level 注入（R13） ────────────────────────────────────────────────

/**
 * 拆分 atom content 為 sections（以 ## 為分界）
 * 若 atom < 300 tokens → 全量回傳
 */
function splitSections(content: string): string[] {
  const sections = content.split(/(?=^##\s)/gm).filter(s => s.trim());
  return sections;
}

/**
 * 對每個 section 計算與 query 的 keyword overlap（快速粗估，不需 embedding）
 */
function sectionScore(section: string, query: string): number {
  const qWords = new Set(query.toLowerCase().split(/\s+/).filter(w => w.length > 1));
  const sWords = section.toLowerCase().split(/\s+/);
  let hits = 0;
  for (const w of sWords) if (qWords.has(w)) hits++;
  return qWords.size > 0 ? hits / qWords.size : 0;
}

function selectSections(content: string, query: string, budget: number): string {
  const tokens = estimateTokens(content);
  if (tokens <= 300) return content;

  const sections = splitSections(content);
  if (sections.length <= 1) return content;

  // 排分 → 取 top-3
  const scored = sections.map(s => ({ s, score: sectionScore(s, query) }));
  scored.sort((a, b) => b.score - a.score);

  const top3 = scored.slice(0, 3).map(x => x.s);
  const extracted = top3.join("\n").trim();

  // R13 fallback：0 section 命中 OR 提取 ≥70% 原文 → 全量
  const totalExtracted = estimateTokens(extracted);
  if (top3.every(s => sectionScore(s, query) === 0) || totalExtracted >= tokens * 0.7) {
    return content;
  }
  return extracted;
}

// ── R14: Staleness Check ─────────────────────────────────────────────────────

/**
 * 掃描 atom content 中的檔案路徑引用，回傳不存在的路徑清單。
 * 快速 existsSync() 驗證，目標 < 10ms overhead。
 *
 * 匹配模式：
 * - 反引號包裹的絕對路徑：`/path/to/file` 或 `~/path/to/file`
 * - src/ 開頭的相對路徑：`src/core/agent-loop.ts`
 * - 明確的檔案路徑模式：path/to/file.ext（含副檔名的）
 */
const FILE_PATH_RE = /`([~/][^\s`]+\.\w+)`|`(src\/[^\s`]+)`|\b(src\/[\w/.-]+\.\w+)\b/g;

function checkStaleness(content: string): string[] {
  const missing: string[] = [];
  const checked = new Set<string>();

  let match: RegExpExecArray | null;
  FILE_PATH_RE.lastIndex = 0;

  while ((match = FILE_PATH_RE.exec(content)) !== null) {
    const path = match[1] ?? match[2] ?? match[3];
    if (!path || checked.has(path)) continue;
    checked.add(path);

    // Expand ~ to home dir
    const resolved = path.startsWith("~")
      ? path.replace(/^~/, process.env.HOME ?? "/tmp")
      : path;

    if (!existsSync(resolved)) {
      missing.push(path);
    }
  }

  return missing;
}

// ── 公開 API ─────────────────────────────────────────────────────────────────

export interface ContextPayload {
  /** 格式化後注入 system prompt 的文字 */
  text: string;
  /** 實際使用 token 數 */
  tokenCount: number;
  /** 三層各自 fragment 數量 */
  layerCounts: Record<MemoryLayer, number>;
  /** BlindSpot 警告字串（若有） */
  blindSpotWarning?: string;
}

/**
 * 從 AtomFragment[] 建立 context payload
 *
 * @param fragments  recall 回傳的 atom 片段
 * @param prompt     原始 prompt（用於 section ranking）
 * @param budget     token 上限（預設 3000）
 * @param ratios     三層比例（預設 30/40/30）
 * @param blindSpot  若 true → 注入 BlindSpot 警告
 */
export function buildContext(
  fragments: AtomFragment[],
  prompt: string,
  budget = 3000,
  ratios: { global: number; project: number; account: number } = { global: 0.3, project: 0.4, account: 0.3 },
  blindSpot = false
): ContextPayload {

  // ── R6: ACT-R 排序 ──
  const sorted = [...fragments].sort((a, b) => actRScore(b) - actRScore(a));

  // ── 按層分組 ──
  const byLayer: Record<MemoryLayer, AtomFragment[]> = { global: [], project: [], account: [] };
  for (const f of sorted) byLayer[f.layer].push(f);

  const layerCounts: Record<MemoryLayer, number> = {
    global:  byLayer.global.length,
    project: byLayer.project.length,
    account: byLayer.account.length,
  };

  const layerBudgets: Record<MemoryLayer, number> = {
    global:  Math.floor(budget * ratios.global),
    project: Math.floor(budget * ratios.project),
    account: Math.floor(budget * ratios.account),
  };

  // ── R8 + R13: Diet + Section-Level 注入，按層填充 ──
  const parts: string[] = [];
  let totalTokens = 0;
  let unusedBudget = 0;             // 各層未用完的預算，累積後再分配
  const includedIds = new Set<string>();

  for (const layer of ["global", "project", "account"] as MemoryLayer[]) {
    const layerFrags = byLayer[layer];
    if (!layerFrags.length) {
      unusedBudget += layerBudgets[layer];  // 空層：整層預算流入 overflow
      continue;
    }

    const layerBudget = layerBudgets[layer];
    let layerTokens = 0;
    const layerParts: string[] = [];

    for (const frag of layerFrags) {
      if (layerTokens >= layerBudget) break;

      // R8: Token Diet
      const dieted = tokenDiet(frag.atom.content);
      // R13: Section selection
      const remaining = layerBudget - layerTokens;
      const selected = selectSections(dieted, prompt, remaining);

      // R14: Staleness check
      const missingPaths = checkStaleness(frag.atom.content);
      const staleTag = missingPaths.length > 0
        ? ` [⚠️ stale: ${missingPaths.slice(0, 3).join(", ")}]`
        : "";
      const header = `[${frag.id}]${staleTag}`;
      const block = `${header}\n${selected}`;
      const blockTokens = estimateTokens(block);

      if (layerTokens + blockTokens > layerBudget) {
        // 截斷到剩餘預算
        const chars = Math.floor(remaining * 1.2); // 反推字元
        const truncated = selected.slice(0, chars) + "…";
        layerParts.push(`${header}\n${truncated}`);
        layerTokens = layerBudget;
      } else {
        layerParts.push(block);
        layerTokens += blockTokens;
      }
      includedIds.add(frag.id);
    }

    unusedBudget += layerBudgets[layer] - layerTokens;  // 未用完的 → overflow

    if (layerParts.length > 0) {
      parts.push(`### ${layer.charAt(0).toUpperCase() + layer.slice(1)} Memory\n${layerParts.join("\n\n")}`);
      totalTokens += layerTokens;
    }
  }

  // ── Overflow 填充：空層 / 未填滿的剩餘預算 → 全局最高分未包含 fragment ──
  if (unusedBudget >= 100) {
    const overflowParts: string[] = [];
    let overflowTokens = 0;

    for (const frag of sorted) {
      if (includedIds.has(frag.id)) continue;
      if (overflowTokens >= unusedBudget) break;

      const dieted = tokenDiet(frag.atom.content);
      const remaining = unusedBudget - overflowTokens;
      const selected = selectSections(dieted, prompt, remaining);
      const header = `[${frag.id}]`;
      const block = `${header}\n${selected}`;
      const blockTokens = estimateTokens(block);

      if (overflowTokens + blockTokens > unusedBudget) break;
      overflowParts.push(block);
      overflowTokens += blockTokens;
      includedIds.add(frag.id);
    }

    if (overflowParts.length > 0) {
      parts.push(`### Extended Memory\n${overflowParts.join("\n\n")}`);
      totalTokens += overflowTokens;
      log.debug(`[context-builder] overflow: ${overflowParts.length} frags, ${overflowTokens} tokens`);
    }
  }

  let text = parts.join("\n\n---\n\n");

  const blindSpotWarning = blindSpot
    ? "[Guardian:BlindSpot] 記憶中無相關 atom，可能是新領域或 trigger 未覆蓋。"
    : undefined;

  if (blindSpotWarning) {
    text = text ? `${text}\n\n${blindSpotWarning}` : blindSpotWarning;
  }

  log.debug(`[context-builder] ${fragments.length} fragments → ${totalTokens} tokens（budget=${budget}）`);
  return { text, tokenCount: totalTokens, layerCounts, blindSpotWarning };
}
