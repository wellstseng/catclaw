/**
 * @file memory/recall.ts
 * @description 記憶檢索（global + project + account + agent）— Vector-First
 *
 * 管線（5 步）：
 *   1. Cache 檢查
 *   2. Keyword 快篩（MEMORY.md trigger match）→ 微調加分用
 *   3. Embed prompt
 *   4. Vector search（各層並行）
 *   5. Merge + dedup + keyword 微調 + touchAtom + cache + return
 *
 * 降級：Ollama / Vector 離線 → keyword fallback + degraded=true
 * 快取：同頻道 60s 內 Jaccard ≥ 0.7 直接回傳
 * Blind-Spot：所有層結果為空 → blindSpot=true
 */

import { join } from "node:path";
import { existsSync } from "node:fs";
import { log } from "../logger.js";
import { readAtom, touchAtom } from "./atom.js";
import { loadIndex, matchTriggers } from "./index-manager.js";
import { buildBM25Index, bm25Search } from "./bm25.js";
import { embedOne } from "../vector/embedding.js";

// ── 型別定義 ─────────────────────────────────────────────────────────────────

export type MemoryLayer = "global" | "project" | "account" | "agent";

export interface AtomFragment {
  id: string;
  layer: MemoryLayer;
  atom: import("./atom.js").Atom;
  /** cosine 相似度 (0–1)；matchedBy="bm25" 時為 normalized BM25 score */
  score: number;
  /** 記憶來源（主要）：用最終 dedup 後分數最高的那筆 */
  matchedBy: "vector" | "bm25" | "keyword";
  /**
   * 所有來源（trace 觀測用）— 同 atom 被多種召回方式命中時，這裡保留全部標記。
   * 例：vector 0.72 + bm25 0.65 同 atom → matchedBy="vector", matchedBySources=["vector","bm25"]
   */
  matchedBySources?: Array<"vector" | "bm25" | "keyword">;
}

export interface RecallContext {
  accountId: string;
  projectId?: string;
  /** Agent ID（有值時 recall 範圍加入 agent 層） */
  agentId?: string;
  sessionIntent?: "build" | "debug" | "design" | "recall" | "general";
  /** 用於 recall cache（同頻道相似 prompt 復用） */
  channelId?: string;
  /** 強制跳過 cache */
  skipCache?: boolean;
}

export interface RecallPaths {
  globalDir: string;
  projectDir?: string;
  accountDir?: string;
  /** Agent 專屬記憶目錄（~/.catclaw/workspace/agents/{agentId}/memory/） */
  agentDir?: string;
}

export interface RecallResult {
  fragments: AtomFragment[];
  /** true = 所有層均無命中 → Blind-Spot 警告 */
  blindSpot: boolean;
  /** Ollama / Vector 離線 */
  degraded: boolean;
}

// ── Recall Cache ─────────────────────────────────────────────────────────────

interface CacheEntry {
  prompt: string;
  result: RecallResult;
  ts: number;
}
const _cache = new Map<string, CacheEntry>();
const RECALL_CACHE_TTL_MS = 60_000;
const JACCARD_THRESHOLD   = 0.7;

function jaccard(a: string, b: string): number {
  const sa = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const sb = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
  if (!sa.size || !sb.size) return 0;
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter++;
  return inter / (sa.size + sb.size - inter);
}

function getCache(channelId: string | undefined, prompt: string): RecallResult | null {
  if (!channelId) return null;
  const entry = _cache.get(channelId);
  if (!entry) return null;
  if (Date.now() - entry.ts > RECALL_CACHE_TTL_MS) { _cache.delete(channelId); return null; }
  if (jaccard(prompt, entry.prompt) >= JACCARD_THRESHOLD) {
    log.debug("[recall] cache 命中");
    return entry.result;
  }
  return null;
}
function setCache(channelId: string | undefined, prompt: string, result: RecallResult) {
  if (channelId) _cache.set(channelId, { prompt, result, ts: Date.now() });
}

// ── 工具 ─────────────────────────────────────────────────────────────────────

/** 根據 layer + context 推算 namespace（LanceDB 向量搜尋用） */
function layerToNs(layer: MemoryLayer, ctx: RecallContext): string {
  if (layer === "global")  return "global";
  if (layer === "project") return `project/${ctx.projectId ?? "default"}`;
  if (layer === "agent")   return `agent/${ctx.agentId!}`;
  return `account/${ctx.accountId}`;
}

// ── 預設參數 ─────────────────────────────────────────────────────────────────

const DEFAULT_TOP_K = 8;
const DEFAULT_MIN_SCORE = 0.55;
const DEFAULT_MAX_RESULTS = 5;

// ── Keyword 快篩微調（加分但不主導排序）────────────────────────────────────
const KEYWORD_BONUS = 0.05;

// ── BM25 層預設參數 ───────────────────────────────────────────────────────
// BM25 raw score 經驗值通常在 0~5 之間；
// minRawScore=0.5 過濾掉幾乎無命中的雜訊
const DEFAULT_BM25_MIN_RAW_SCORE = 0.5;
const DEFAULT_BM25_TOP_K = 5;

// ── Degraded Fallback（向量不可用時的兜底路徑） ─────────────────────────────
//
// 優先順序：BM25 ranking 結果（含 normalized score）→ keyword trigger（固定 0.5）
// BM25 已預先在 Step 2 算好，這裡只需 merge / dedup / 排序。

function degradedFallback(
  bm25Fragments: AtomFragment[],
  keywordHits: Set<string>,
  layerDefs: Array<{ layer: MemoryLayer; dir: string }>,
  maxResults: number,
  channelId: string | undefined,
  prompt: string,
): RecallResult {
  // 先把 BM25 命中放進來（同 atom 多層命中 → 取分數高的）
  const byId = new Map<string, AtomFragment>();
  for (const f of bm25Fragments) {
    const prev = byId.get(f.id);
    if (!prev) {
      byId.set(f.id, { ...f, matchedBySources: ["bm25"] });
    } else if (f.score > prev.score) {
      byId.set(f.id, { ...f, matchedBySources: ["bm25"] });
    }
  }

  // 再補 keyword fallback（同 atom 若已是 BM25 命中 → 多記一個 source，不覆寫 primary）
  for (const name of keywordHits) {
    const existing = byId.get(name);
    if (existing) {
      const sources = new Set(existing.matchedBySources ?? [existing.matchedBy]);
      sources.add("keyword");
      existing.matchedBySources = Array.from(sources);
      continue;
    }
    for (const { layer, dir } of layerDefs) {
      const atomPath = join(dir, `${name}.md`);
      if (!existsSync(atomPath)) continue;
      const atom = readAtom(atomPath);
      if (!atom) continue;
      byId.set(name, {
        id: atom.name,
        layer,
        atom,
        score: 0.5,
        matchedBy: "keyword",
        matchedBySources: ["keyword"],
      });
      break;
    }
  }

  const fragments = Array.from(byId.values()).sort((a, b) => b.score - a.score);
  const topFragments = fragments.slice(0, maxResults);

  for (const f of topFragments) {
    try { touchAtom(f.atom.path); } catch { /* 靜默 */ }
  }

  const blindSpot = topFragments.length === 0;
  log.debug(
    `[recall] ⚠ 向量服務不可用，降級到 BM25+keyword fallback（bm25=${bm25Fragments.length}, kw=${keywordHits.size}, return=${topFragments.length}）`,
  );

  const result: RecallResult = { fragments: topFragments, blindSpot, degraded: true };
  setCache(channelId, prompt, result);
  return result;
}

// ── 公開 API ─────────────────────────────────────────────────────────────────

/**
 * 記憶檢索主入口（Vector + keyword fallback）
 */
export async function recall(
  prompt: string,
  ctx: RecallContext,
  paths: RecallPaths,
  opts: {
    topK?: number;
    minScore?: number;
    maxResults?: number;
    /** BM25 層啟用旗標，預設 true。設 false 可退回舊行為（純 keyword + vector）*/
    bm25Enabled?: boolean;
    /** BM25 raw score 下限（過濾雜訊命中），預設 0.5 */
    bm25MinScore?: number;
    /** BM25 每層回傳前 K 個，預設 5 */
    bm25TopK?: number;
    // 保留舊欄位相容（engine.ts 傳入），但不再使用
    triggerMatch?: boolean;
    vectorSearch?: boolean;
    relatedEdgeSpreading?: boolean;
    vectorMinScore?: number;
    vectorTopK?: number;
    llmSelect?: boolean;
    llmSelectMax?: number;
  }
): Promise<RecallResult> {
  // ── Step 1: Cache 檢查 ──
  if (!ctx.skipCache) {
    const cached = getCache(ctx.channelId, prompt);
    if (cached) return cached;
  }

  log.debug(`[recall] prompt="${prompt.slice(0, 50)}…" intent=${ctx.sessionIntent ?? "general"}`);

  // 相容舊 config 欄位
  const topK = opts.topK ?? opts.vectorTopK ?? DEFAULT_TOP_K;
  const minScore = opts.minScore ?? opts.vectorMinScore ?? DEFAULT_MIN_SCORE;
  const maxResults = opts.maxResults ?? opts.llmSelectMax ?? DEFAULT_MAX_RESULTS;
  const bm25Enabled = opts.bm25Enabled ?? true;
  const bm25MinScore = opts.bm25MinScore ?? DEFAULT_BM25_MIN_RAW_SCORE;
  const bm25TopK = opts.bm25TopK ?? DEFAULT_BM25_TOP_K;

  // ── 各層定義（Step 2~6 共用） ──
  const layerDefs: Array<{ layer: MemoryLayer; dir: string }> = [
    { layer: "global", dir: paths.globalDir },
    ...(paths.projectDir ? [{ layer: "project" as MemoryLayer, dir: paths.projectDir }] : []),
    ...(paths.accountDir ? [{ layer: "account" as MemoryLayer, dir: paths.accountDir }] : []),
    ...(paths.agentDir ? [{ layer: "agent" as MemoryLayer, dir: paths.agentDir }] : []),
  ];

  // ── Step 2: Progressive Retrieval — keyword 快篩 + BM25 in-memory rank ──
  // keyword 用 substring 全詞比對（accuracy 高、recall 低），BM25 用 tokenized ranking
  // （recall 廣、含 IDF 權重）。兩者互補：keyword 命中 = trigger 命中加分；
  // BM25 命中 = 額外候選 fragment（含 normalizedScore）。
  const keywordHits = new Set<string>();
  const bm25Fragments: AtomFragment[] = [];
  for (const { layer, dir } of layerDefs) {
    const indexPath = join(dir, "MEMORY.md");
    const entries = loadIndex(indexPath);
    if (entries.length === 0) continue;

    // keyword 快篩
    const matched = matchTriggers(prompt, entries);
    for (const m of matched) keywordHits.add(m.name);

    // BM25 in-memory ranking
    if (!bm25Enabled) continue;
    const index = buildBM25Index(entries);
    const hits = bm25Search(index, prompt, { topK: bm25TopK, minScore: bm25MinScore });
    for (const hit of hits) {
      const atomPath = join(dir, `${hit.name}.md`);
      if (!existsSync(atomPath)) continue;
      const atom = readAtom(atomPath);
      if (!atom) continue;
      bm25Fragments.push({
        id: atom.name,
        layer,
        atom,
        score: hit.normalizedScore,
        matchedBy: "bm25",
      });
    }
  }
  if (keywordHits.size > 0) {
    log.debug(`[recall] keyword 快篩命中 ${keywordHits.size} 個：${[...keywordHits].join(", ")}`);
  }
  if (bm25Fragments.length > 0) {
    log.debug(`[recall] BM25 排序命中 ${bm25Fragments.length} 個：${bm25Fragments.map(f => `${f.atom.name}@${f.score.toFixed(3)}`).join(", ")}`);
  }

  // ── Step 3: Embed prompt ──
  let queryVec: number[];
  try {
    queryVec = await embedOne(prompt);
    if (!queryVec.length) throw new Error("empty embedding");
  } catch (err) {
    log.debug(`[recall] embedding 失敗：${err instanceof Error ? err.message : String(err)}`);
    return degradedFallback(bm25Fragments, keywordHits, layerDefs, maxResults, ctx.channelId, prompt);
  }

  // ── Step 4: Vector search（各層並行） ──

  let allFragments: AtomFragment[] = [];

  try {
    const { getVectorService } = await import("../vector/lancedb.js");
    const vsvc = getVectorService();
    if (!vsvc.isAvailable()) throw new Error("vector service not available");

    const layerResults = await Promise.all(layerDefs.map(async ({ layer, dir }) => {
      const ns = layerToNs(layer, ctx);
      const hits = await vsvc.search(queryVec, { namespace: ns, topK, minScore });
      const fragments: AtomFragment[] = [];

      for (const hit of hits) {
        let atomPath = hit.path;
        if (!atomPath || !existsSync(atomPath)) {
          atomPath = join(dir, `${hit.id}.md`);
        }
        if (!existsSync(atomPath)) continue;

        const atom = readAtom(atomPath);
        if (!atom) continue;
        fragments.push({ id: atom.name, layer, atom, score: hit.score, matchedBy: "vector" });
      }
      return fragments;
    }));

    for (const frags of layerResults) allFragments.push(...frags);
  } catch (err) {
    log.debug(`[recall] vector search 失敗：${err instanceof Error ? err.message : String(err)}`);
    return degradedFallback(bm25Fragments, keywordHits, layerDefs, maxResults, ctx.channelId, prompt);
  }

  // 把 BM25 候選合進來 — 後續 dedup map 會用 max score 保留高分那筆
  allFragments.push(...bm25Fragments);

  // ── Step 5: Merge + dedup + keyword 微調 + 排序 ──
  // 同 atom 多次命中時：保留分數最高的那筆當 primary（matchedBy + score），
  // 但 matchedBySources 集合所有來源以保留 trace 可觀測性。
  const best = new Map<string, AtomFragment>();
  for (const f of allFragments) {
    const prev = best.get(f.id);
    if (!prev) {
      best.set(f.id, { ...f, matchedBySources: [f.matchedBy] });
    } else {
      const sources = new Set(prev.matchedBySources ?? [prev.matchedBy]);
      sources.add(f.matchedBy);
      if (f.score > prev.score) {
        best.set(f.id, { ...f, matchedBySources: Array.from(sources) });
      } else {
        prev.matchedBySources = Array.from(sources);
      }
    }
  }

  // 純 cosine score + keyword 微調（不使用 ACT-R activation）
  const scored = Array.from(best.values());
  for (const f of scored) {
    if (keywordHits.has(f.id)) f.score += KEYWORD_BONUS;
  }

  scored.sort((a, b) => b.score - a.score);
  const rawTop = scored.slice(0, maxResults);

  // ── Step 5.5：注入時向量去重（議題 #記憶萃取品質 Sprint 2 = 方向 C）─────────
  // 取 atom.content 重新 embed、與已 accept 的 fragment 兩兩比 cosine；
  // ≥ DEDUP_INJECT_THRESHOLD 視為主題重複，跳過低分的那個。
  // embed 失敗 / cosine 失敗 → 直接 push（不擋注入主路徑）。
  const topFragments = await dedupFragmentsByVector(rawTop);

  // ── touchAtom + cache ──
  for (const f of topFragments) {
    try { touchAtom(f.atom.path); } catch { /* 靜默 */ }
  }

  const blindSpot = topFragments.length === 0;
  if (blindSpot) log.debug("[recall] BlindSpot — 所有層均無命中");

  const result: RecallResult = { fragments: topFragments, blindSpot, degraded: false };
  setCache(ctx.channelId, prompt, result);

  log.debug(`[recall] 命中 ${topFragments.length} 個 atom (kw=${keywordHits.size})`);
  return result;
}

/** 清除 recall cache（測試用） */
export function clearRecallCache(): void {
  _cache.clear();
}

// ── 向量去重 helpers（議題 #記憶萃取品質 Sprint 2 = 方向 C）──────────────────

const DEDUP_INJECT_THRESHOLD = 0.85;

/** 兩個向量的 cosine 相似度（0~1）。長度不符或 0 向量回 0 */
function cosineSim(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!, bi = b[i]!;
    dot += ai * bi;
    na += ai * ai;
    nb += bi * bi;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}

/**
 * 對 fragments 做兩兩 cosine 去重（已按 score 排序、保留高分那筆）
 *
 * - 每個 atom.content embed 一次（typical topK ≤ 5，成本可接受）
 * - embed 失敗的 fragment 直接通過（不擋注入）
 */
async function dedupFragmentsByVector(fragments: AtomFragment[]): Promise<AtomFragment[]> {
  if (fragments.length <= 1) return fragments;
  const accepted: AtomFragment[] = [];
  const acceptedVecs: number[][] = [];

  for (const f of fragments) {
    let vec: number[] = [];
    try {
      vec = await embedOne(f.atom.content);
    } catch {
      // embed 失敗 → 不能比對、直接通過
      accepted.push(f);
      acceptedVecs.push([]);
      continue;
    }
    if (!vec.length) {
      accepted.push(f);
      acceptedVecs.push([]);
      continue;
    }
    let isDup = false;
    for (let i = 0; i < acceptedVecs.length; i++) {
      const acceptedVec = acceptedVecs[i]!;
      if (acceptedVec.length === 0) continue;
      const sim = cosineSim(vec, acceptedVec);
      if (sim >= DEDUP_INJECT_THRESHOLD) {
        log.debug(`[recall] dedup skip ${f.atom.name} ≈ ${accepted[i]!.atom.name} (cos=${sim.toFixed(3)})`);
        isDup = true;
        break;
      }
    }
    if (!isDup) {
      accepted.push(f);
      acceptedVecs.push(vec);
    }
  }
  return accepted;
}
