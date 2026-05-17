/**
 * @file workflow/memory-cleanup.ts
 * @description ext_*.md atom 階段性 cleanup（議題 #記憶萃取品質 Sprint 3 = 方向 B）
 *
 * 流程：
 *   1. 掃指定目錄列表的 ext_*.md
 *   2. 對每個 atom.content embedOne
 *   3. 兩兩 cosine 比對，相似度 ≥ threshold 視為同 cluster
 *   4. cluster 內排序 (confirmations DESC, lastUsed DESC, createdAt ASC) 保留首位
 *   5. 其他成員 deleteAtom（同時清向量 DB）
 *
 * 入口：catclaw runtime 內呼叫 runMemoryCleanup(opts)，
 *        或 scripts/memory-cleanup.mjs CLI wrapper（dynamic import dist 後跑）
 */

import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { log } from "../logger.js";
import { readAtom } from "../memory/atom.js";
import { deleteAtom } from "../memory/memory-api.js";
import { embedOne } from "../vector/embedding.js";

export interface CleanupOpts {
  /** 要掃描的目錄列表（通常一個 namespace 對應一個 dir） */
  dirs: string[];
  /** atom 對應的向量 namespace（給 deleteAtom 清向量 DB 用） */
  namespace: string;
  /** cosine 相似度閾值，≥ 視為同 cluster；預設 0.85 */
  threshold?: number;
  /** dry-run 模式：只回報、不真的刪；預設 false */
  dryRun?: boolean;
}

export interface CleanupResult {
  scanned: number;
  clusters: number;
  /** 重複待刪 / 已刪數量 */
  duplicates: number;
  embedFailed: number;
  errors: number;
  details: Array<{
    keptAtom: string;
    keptConfirmations: number;
    removed: Array<{ name: string; confirmations: number; cosine: number }>;
  }>;
}

interface AtomEmbedding {
  name: string;
  path: string;
  confirmations: number;
  lastUsed: string;
  createdAt: number;
  vec: number[];
}

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

/** 掃 dirs 列出所有 ext_*.md 完整路徑 */
function scanExtAtoms(dirs: string[]): string[] {
  const paths: string[] = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    walkDir(dir, paths);
  }
  return paths;
}

function walkDir(dir: string, acc: string[]): void {
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        // 跳過 .git / node_modules / _vectordb 等
        if (e.name.startsWith(".") || e.name.startsWith("_")) continue;
        walkDir(full, acc);
      } else if (e.isFile() && e.name.startsWith("ext_") && e.name.endsWith(".md")) {
        acc.push(full);
      }
    }
  } catch (err) {
    log.debug(`[memory-cleanup] walkDir 失敗 ${dir}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function runMemoryCleanup(opts: CleanupOpts): Promise<CleanupResult> {
  const threshold = opts.threshold ?? 0.85;
  const dryRun = opts.dryRun ?? false;
  const result: CleanupResult = {
    scanned: 0,
    clusters: 0,
    duplicates: 0,
    embedFailed: 0,
    errors: 0,
    details: [],
  };

  // Step 1: scan
  const paths = scanExtAtoms(opts.dirs);
  result.scanned = paths.length;
  log.info(`[memory-cleanup] 掃描 ${paths.length} 個 ext_*.md atom（dirs=${opts.dirs.length}）`);
  if (paths.length < 2) return result;

  // Step 2: read + embed
  const items: AtomEmbedding[] = [];
  for (const path of paths) {
    try {
      const atom = readAtom(path);
      if (!atom) continue;
      const vec = await embedOne(atom.content);
      if (!vec.length) { result.embedFailed++; continue; }
      items.push({
        name: atom.name,
        path,
        confirmations: atom.confirmations,
        lastUsed: atom.lastUsed ?? "",
        createdAt: atom.createdAt ?? 0,
        vec,
      });
    } catch (err) {
      result.errors++;
      log.debug(`[memory-cleanup] 讀/embed 失敗 ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Step 3: cluster（greedy union-find / N^2 配對）
  // parent[i] = i 自己 → root；同 root 視為同 cluster
  const parent = items.map((_, i) => i);
  const find = (x: number): number => parent[x] === x ? x : (parent[x] = find(parent[x]!));
  const union = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };

  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const sim = cosineSim(items[i]!.vec, items[j]!.vec);
      if (sim >= threshold) union(i, j);
    }
  }

  // Step 4: 收 cluster
  const clusters = new Map<number, number[]>();
  for (let i = 0; i < items.length; i++) {
    const r = find(i);
    if (!clusters.has(r)) clusters.set(r, []);
    clusters.get(r)!.push(i);
  }

  // Step 5: 每 cluster 排序 + 保留首位、刪其他
  for (const memberIdx of clusters.values()) {
    if (memberIdx.length < 2) continue;  // 單獨 atom 不算重複
    result.clusters++;

    memberIdx.sort((a, b) => {
      const A = items[a]!, B = items[b]!;
      if (A.confirmations !== B.confirmations) return B.confirmations - A.confirmations;
      if (A.lastUsed !== B.lastUsed) return A.lastUsed < B.lastUsed ? 1 : -1;
      return A.createdAt - B.createdAt;
    });
    const kept = items[memberIdx[0]!]!;
    const removed: CleanupResult["details"][number]["removed"] = [];

    for (let i = 1; i < memberIdx.length; i++) {
      const victim = items[memberIdx[i]!]!;
      const cos = cosineSim(kept.vec, victim.vec);
      removed.push({ name: victim.name, confirmations: victim.confirmations, cosine: Number(cos.toFixed(3)) });
      result.duplicates++;

      if (!dryRun) {
        try {
          deleteAtom(opts.dirs, victim.name, opts.namespace);
        } catch (err) {
          result.errors++;
          log.warn(`[memory-cleanup] 刪除失敗 ${victim.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    result.details.push({
      keptAtom: kept.name,
      keptConfirmations: kept.confirmations,
      removed,
    });
  }

  log.info(`[memory-cleanup] 完成 — scanned=${result.scanned} clusters=${result.clusters} ${dryRun ? "would-delete" : "deleted"}=${result.duplicates} embedFail=${result.embedFailed} errors=${result.errors}`);
  return result;
}
