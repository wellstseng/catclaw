/**
 * BM25 integration test — 用真實 catclaw MEMORY.md 跑查詢
 *
 * 用法：node tests/bm25-integration.mjs
 */

import { loadIndex } from "../dist/memory/index-manager.js";
import { buildBM25Index, bm25Search } from "../dist/memory/bm25.js";

const indexPath = "/Users/wellstseng/.catclaw/memory/MEMORY.md";
const entries = loadIndex(indexPath);

console.log(`Loaded ${entries.length} entries from ${indexPath}`);

if (entries.length === 0) {
  console.log("(空 index — 略過 integration 測試)");
  process.exit(0);
}

const bm25Index = buildBM25Index(entries);
console.log(`BM25 index: N=${bm25Index.N}, avgdl=${bm25Index.avgdl.toFixed(2)}, unique terms=${bm25Index.df.size}`);

const queries = ["記憶系統", "git 工作流", "原子記憶", "agent 配置"];
for (const q of queries) {
  const t0 = Date.now();
  const hits = bm25Search(bm25Index, q, { topK: 3, minScore: 0.5 });
  const dt = Date.now() - t0;
  console.log(`\nquery: "${q}" (${dt}ms)`);
  if (hits.length === 0) {
    console.log("  (no hits)");
    continue;
  }
  for (const h of hits) {
    console.log(`   ${h.name.padEnd(40)} raw=${h.score.toFixed(3)} norm=${h.normalizedScore.toFixed(3)}`);
  }
}
