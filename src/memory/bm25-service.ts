/**
 * @file memory/bm25-service.ts
 * @description V5 P5a — 全域 disk-persisted BM25 service
 *
 * 對拍 upstream V5 全域 BM25（Wave 3 P5a，無對應單檔 — catclaw 統合進此服務）。
 *
 * 與 Phase 1 的 `bm25.ts` 差異：
 *   - bm25.ts：in-memory + ad-hoc + 只索引 `name + triggers`
 *   - bm25-service.ts：disk-persisted + 全 atom 內容（`name + triggers + content`）
 *
 * 索引位置：`<memDir>/_meta/bm25-index.json`
 * Schema：序列化 BM25Index（含 Map<string,number>，存為 array entries）
 *
 * Invalidation 策略：
 *   - mtime check：load 時取 atoms max mtime，與 index ts 比；stale 則 rebuild
 *   - 主動 invalidate：atom-io.writeAtom/deleteAtom/updateAtomConfidence 後呼叫
 *     `invalidate(memDir, atomName)` 標 dirty，下次 search 觸發 rebuild
 */

import { existsSync, readFileSync, writeFileSync, renameSync, statSync, mkdirSync, readdirSync } from "node:fs";
import { join, dirname, basename, extname } from "node:path";
import { log } from "../logger.js";
import { tokenize, normalizeBM25Score, type BM25Hit } from "./bm25.js";
import { readAtom, type Atom } from "./atom.js";
import { shouldSkip } from "./atom-spec.js";

// ── 常數 ─────────────────────────────────────────────────────────────────────

export const INDEX_RELATIVE_PATH = "_meta/bm25-index.json";
export const INDEX_SCHEMA = "bm25-index-v1-catclaw";

const K1 = 1.2;
const B = 0.75;

// ── 型別 ─────────────────────────────────────────────────────────────────────

interface SerializedDoc {
  name: string;
  path: string;
  dl: number;
  tf: Array<[string, number]>;
  mtime: number;
}

export interface BM25GlobalIndex {
  schema: typeof INDEX_SCHEMA;
  builtAt: number;
  memDir: string;
  N: number;
  avgdl: number;
  df: Map<string, number>;
  docs: BM25Doc[];
}

export interface BM25Doc {
  name: string;
  path: string;
  dl: number;
  tf: Map<string, number>;
  mtime: number;
}

interface PersistedIndex {
  schema: string;
  builtAt: number;
  memDir: string;
  N: number;
  avgdl: number;
  df: Array<[string, number]>;
  docs: SerializedDoc[];
}

// ── path helpers ─────────────────────────────────────────────────────────────

function indexPathOf(memDir: string): string {
  return join(memDir, INDEX_RELATIVE_PATH);
}

// ── tokenize for atom（全內容）─────────────────────────────────────────────

function atomDocText(atom: Atom): string {
  const nameTokens = atom.name.replace(/-/g, " ");
  const triggerText = atom.triggers.join(" ");
  // content 已是純內容（去除 metadata header）
  return [nameTokens, triggerText, atom.content].filter(Boolean).join("\n");
}

// ── atom 掃描 ─────────────────────────────────────────────────────────────────

function findAtomFiles(root: string, acc: string[] = []): string[] {
  if (!existsSync(root)) return acc;
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return acc;
  }
  for (const name of entries) {
    if (shouldSkip(name)) continue;
    if (name.startsWith(".")) continue;
    const full = join(root, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      findAtomFiles(full, acc);
    } else if (name.endsWith(".md") && !name.endsWith(".access.json")) {
      acc.push(full);
    }
  }
  return acc;
}

// ── build / load / save ─────────────────────────────────────────────────────

/**
 * 從 memDir 重建全域 BM25 index（掃所有 atom .md，tokenize 全內容）。
 */
export function buildGlobalIndex(memDir: string): BM25GlobalIndex {
  const atomPaths = findAtomFiles(memDir);
  const docs: BM25Doc[] = [];
  const df = new Map<string, number>();

  for (const p of atomPaths) {
    const atom = readAtom(p);
    if (!atom) continue;
    const docText = atomDocText(atom);
    const tokens = tokenize(docText);
    if (tokens.length === 0) continue;
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const t of new Set(tokens)) df.set(t, (df.get(t) ?? 0) + 1);
    let mtime = 0;
    try { mtime = statSync(p).mtimeMs; } catch { /* leave 0 */ }
    docs.push({ name: atom.name, path: p, dl: tokens.length, tf, mtime });
  }

  const totalLen = docs.reduce((s, d) => s + d.dl, 0);
  const avgdl = docs.length > 0 ? totalLen / docs.length : 0;

  return {
    schema: INDEX_SCHEMA,
    builtAt: Date.now(),
    memDir,
    N: docs.length,
    avgdl,
    df,
    docs,
  };
}

export function saveGlobalIndex(memDir: string, idx: BM25GlobalIndex): void {
  const p = indexPathOf(memDir);
  mkdirSync(dirname(p), { recursive: true });
  const persisted: PersistedIndex = {
    schema: idx.schema,
    builtAt: idx.builtAt,
    memDir: idx.memDir,
    N: idx.N,
    avgdl: idx.avgdl,
    df: Array.from(idx.df.entries()),
    docs: idx.docs.map(d => ({
      name: d.name,
      path: d.path,
      dl: d.dl,
      tf: Array.from(d.tf.entries()),
      mtime: d.mtime,
    })),
  };
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(persisted), "utf-8");
  renameSync(tmp, p);
}

function deserialize(data: PersistedIndex): BM25GlobalIndex {
  return {
    schema: INDEX_SCHEMA,
    builtAt: data.builtAt,
    memDir: data.memDir,
    N: data.N,
    avgdl: data.avgdl,
    df: new Map(data.df),
    docs: data.docs.map(d => ({
      name: d.name,
      path: d.path,
      dl: d.dl,
      tf: new Map(d.tf),
      mtime: d.mtime,
    })),
  };
}

function isStale(memDir: string, idx: BM25GlobalIndex): boolean {
  // 比對「目前 atom mtime」vs「build 時記下的 doc.mtime」：
  //   - 數量不符 → stale
  //   - 任一 atom 不在 index docs → stale
  //   - 任一 atom 的 mtime 推進過 → stale
  const atomPaths = findAtomFiles(memDir);
  if (atomPaths.length !== idx.docs.length) return true;
  const docByPath = new Map(idx.docs.map(d => [d.path, d]));
  for (const p of atomPaths) {
    const doc = docByPath.get(p);
    if (!doc) return true;
    try {
      if (statSync(p).mtimeMs > doc.mtime) return true;
    } catch {
      return true;
    }
  }
  return false;
}

/**
 * Load 已持久化的 index；若不存在或 stale → 自動 rebuild + save。
 */
export function loadGlobalIndex(memDir: string): BM25GlobalIndex {
  const p = indexPathOf(memDir);
  if (existsSync(p)) {
    try {
      const raw = readFileSync(p, "utf-8");
      const data = JSON.parse(raw) as PersistedIndex;
      if (data.schema === INDEX_SCHEMA) {
        const idx = deserialize(data);
        if (!isStale(memDir, idx)) return idx;
        log.debug(`[bm25-service] index stale, rebuilding ${memDir}`);
      }
    } catch (err) {
      log.warn(`[bm25-service] load 失敗，rebuild：${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const idx = buildGlobalIndex(memDir);
  try { saveGlobalIndex(memDir, idx); } catch { /* persist 失敗仍 return in-memory index */ }
  return idx;
}

// ── search ──────────────────────────────────────────────────────────────────

export interface SearchOpts {
  topK?: number;
  minScore?: number;
}

export function searchGlobal(memDir: string, query: string, opts: SearchOpts = {}): BM25Hit[] {
  const topK = opts.topK ?? 5;
  const minScore = opts.minScore ?? 0;
  if (!query) return [];

  const idx = loadGlobalIndex(memDir);
  if (idx.N === 0) return [];

  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];
  const uniqueQ = new Set(queryTokens);

  const hits: BM25Hit[] = [];
  for (const doc of idx.docs) {
    if (doc.dl === 0) continue;
    let score = 0;
    for (const q of uniqueQ) {
      const f = doc.tf.get(q);
      if (!f) continue;
      const n = idx.df.get(q) ?? 0;
      const idf = Math.log(1 + (idx.N - n + 0.5) / (n + 0.5));
      const denom = f + K1 * (1 - B + B * doc.dl / idx.avgdl);
      score += idf * (f * (K1 + 1)) / Math.max(denom, 1e-9);
    }
    if (score > minScore) {
      hits.push({ name: doc.name, score, normalizedScore: normalizeBM25Score(score) });
    }
  }

  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, topK);
}

// ── invalidate ──────────────────────────────────────────────────────────────

/**
 * 標記 index dirty（直接刪 index 檔，下次 search 觸發 rebuild）。
 *
 * 對 atom-io.writeAtom/deleteAtom/updateAtomConfidence 後呼叫。
 *
 * 設計選擇：刪檔最簡單。catclaw atom 數量小（<20），rebuild < 10ms，
 * 比起 incremental update（要算 df 差異）省麻煩。
 */
export function invalidate(memDir: string, _atomName?: string): void {
  const p = indexPathOf(memDir);
  if (existsSync(p)) {
    try {
      // 用 unlink 風險為 race（並發 search 同時讀檔）；保險改成寫一個空 schema
      // 讓 isStale 自然觸發 rebuild。
      const stub: PersistedIndex = {
        schema: "__invalid__",
        builtAt: 0,
        memDir,
        N: 0,
        avgdl: 0,
        df: [],
        docs: [],
      };
      writeFileSync(p, JSON.stringify(stub), "utf-8");
    } catch { /* invalidate 失敗下次 search 還是會 mtime check */ }
  }
}

// ── 不導出但供回歸測試 ──────────────────────────────────────────────────
export { isStale as _isStale };
