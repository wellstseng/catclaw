/**
 * @file memory/bm25.ts
 * @description In-memory BM25 ranking over atom trigger lists + names
 *
 * 設計（從 ~/.claude V5 hooks/wg_atoms.py 移植）：
 *   - Tokenization: ASCII word ([a-z0-9]+) + 中文 char-bigrams (CJK 連續區段切 2-gram)
 *   - Document = atom.name + triggers.join(" ")（純關鍵字索引，不索引 atom 全文）
 *   - 標準 BM25 公式：k1=1.2, b=0.75（業界經驗值）
 *   - IDF: log(1 + (N - n + 0.5) / (n + 0.5))（避免 zero/negative）
 *
 * 為什麼不索引 atom.content：
 *   trigger list 是策展過的關鍵字，BM25 over triggers 命中率高、雜訊低，
 *   並且每個 atom 文檔很短 → in-memory ~17 atoms 查詢 < 10ms。
 *   若要全文檢索，請走 vector search 那條路。
 *
 * Score normalization：
 *   BM25 raw score 為 [0, +∞)，呼叫端若要跟 cosine score 比較需呼叫
 *   normalizeBM25Score()。
 */

import type { IndexEntry } from "./index-manager.js";

// ── BM25 參數（標準經驗值） ─────────────────────────────────────────────────

const K1 = 1.2;
const B = 0.75;

// 規範化常數：BM25 raw score 經驗範圍 0~5；normalized = score / (score + K_NORM)
//
// 取 K_NORM=2 是讓 BM25 命中跟 vector cosine（0.55~0.85 區間）尺度對等，
// 避免 Step 5 dedup 時 BM25 永遠被同 atom 的 vector 命中壓下去 → 召回率退化。
//   score=1   → 0.33   （弱命中，跟 vector 低分競爭）
//   score=2   → 0.50   （中強命中，落在 vector 中段）
//   score=4   → 0.67   （強命中，超過大部分 vector cosine）
//   score=∞   → 1
const K_NORM = 2;

// ── Tokenization ─────────────────────────────────────────────────────────────

const ASCII_TOKEN_RE = /[a-z0-9]+/g;
const CJK_RUN_RE = /[一-鿿]+/g;

/**
 * 切詞：lowercased ASCII words + 中文 char-bigrams
 *
 * 例：
 *   "Git 工具鏈" → ["git", "工具", "具鏈"]
 *   "BM25 search" → ["bm25", "search"]
 *   "原" → ["原"]（單字直接保留）
 */
export function tokenize(text: string): string[] {
  if (!text) return [];
  const lower = text.toLowerCase();
  const tokens: string[] = lower.match(ASCII_TOKEN_RE) ?? [];

  const cjkRuns = lower.match(CJK_RUN_RE) ?? [];
  for (const run of cjkRuns) {
    if (run.length === 1) {
      tokens.push(run);
    } else {
      for (let i = 0; i < run.length - 1; i++) {
        tokens.push(run.slice(i, i + 2));
      }
    }
  }
  return tokens;
}

// ── BM25 Index ───────────────────────────────────────────────────────────────

export interface BM25Document {
  /** atom 名稱（呼叫端用來查 atom 檔案） */
  name: string;
  /** Tokenized document content */
  tokens: string[];
  /** 文檔長度（tokens.length） */
  dl: number;
  /** Term frequency map */
  tf: Map<string, number>;
}

export interface BM25Index {
  docs: BM25Document[];
  /** Document frequency: term → 出現該 term 的 doc 數量 */
  df: Map<string, number>;
  /** Average document length */
  avgdl: number;
  /** Total number of documents */
  N: number;
}

/**
 * 從 IndexEntry 列表建立 BM25 index
 *
 * Document text = entry.name (- → space) + " " + entry.triggers.join(" ")
 */
export function buildBM25Index(entries: IndexEntry[]): BM25Index {
  const docs: BM25Document[] = [];
  const df = new Map<string, number>();

  for (const entry of entries) {
    const docText = entry.name.replace(/-/g, " ") + " " + entry.triggers.join(" ");
    const tokens = tokenize(docText);
    const tf = new Map<string, number>();
    for (const t of tokens) {
      tf.set(t, (tf.get(t) ?? 0) + 1);
    }
    // unique terms → df
    for (const t of new Set(tokens)) {
      df.set(t, (df.get(t) ?? 0) + 1);
    }
    docs.push({ name: entry.name, tokens, dl: tokens.length, tf });
  }

  const totalLen = docs.reduce((sum, d) => sum + d.dl, 0);
  const avgdl = docs.length > 0 ? totalLen / docs.length : 0;

  return { docs, df, avgdl, N: docs.length };
}

// ── Search ───────────────────────────────────────────────────────────────────

export interface BM25Hit {
  name: string;
  /** Raw BM25 score（[0, +∞)） */
  score: number;
  /** Normalized score [0, 1) — 用於跟 cosine 合併 */
  normalizedScore: number;
}

export interface BM25SearchOpts {
  /** 回傳前 K 個，預設 5 */
  topK?: number;
  /** raw BM25 score 下限，預設 0（保留所有有分的） */
  minScore?: number;
}

/**
 * BM25 query — 回傳依 score 由高到低排序的 hits
 *
 * 若 corpus 空 / query 切詞後為空 → 回傳 []
 */
export function bm25Search(
  index: BM25Index,
  query: string,
  opts: BM25SearchOpts = {},
): BM25Hit[] {
  const topK = opts.topK ?? 5;
  const minScore = opts.minScore ?? 0;

  if (index.N === 0) return [];
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];

  const uniqueQueryTokens = new Set(queryTokens);
  const hits: BM25Hit[] = [];

  for (const doc of index.docs) {
    if (doc.dl === 0) continue;
    let score = 0;
    for (const q of uniqueQueryTokens) {
      const f = doc.tf.get(q);
      if (!f) continue;
      const n = index.df.get(q) ?? 0;
      const idf = Math.log(1 + (index.N - n + 0.5) / (n + 0.5));
      const denom = f + K1 * (1 - B + B * doc.dl / index.avgdl);
      score += idf * (f * (K1 + 1)) / Math.max(denom, 1e-9);
    }
    if (score > minScore) {
      hits.push({
        name: doc.name,
        score,
        normalizedScore: normalizeBM25Score(score),
      });
    }
  }

  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, topK);
}

/**
 * 把 BM25 raw score [0, +∞) 規範化到 [0, 1)
 *
 * 公式：score / (score + K_NORM)
 *   - score=0 → 0
 *   - score=K_NORM (4) → 0.5
 *   - score=∞ → 1
 *
 * 用於與 vector cosine score 合併排序。
 */
export function normalizeBM25Score(score: number): number {
  if (score <= 0) return 0;
  return score / (score + K_NORM);
}
