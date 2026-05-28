/**
 * BM25 模組 smoke test
 *
 * 測試項目：
 *   1. tokenize: ASCII words + 中文 bigrams + 混合
 *   2. buildBM25Index: docs / df / avgdl / N 正確
 *   3. bm25Search: 命中時依 score 排序，分數 > 0
 *   4. bm25Search: 空 corpus / 空 query → 空結果
 *   5. normalizeBM25Score: [0, +∞) → [0, 1)
 *
 * 用法：node tests/bm25-smoke.mjs
 */

import {
  tokenize,
  buildBM25Index,
  bm25Search,
  normalizeBM25Score,
} from "../dist/memory/bm25.js";

let passed = 0;
let failed = 0;

function assert(condition, name) {
  if (condition) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.error(`  ✗ ${name}`);
    failed++;
  }
}

function assertDeepEq(actual, expected, name) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.error(`  ✗ ${name}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
    failed++;
  }
}

// ── Test 1: tokenize ────────────────────────────────────────────────────────

console.log("\n═══ Test 1: tokenize ═══");

assertDeepEq(tokenize("git commit"), ["git", "commit"], "ASCII 切詞");
assertDeepEq(tokenize("BM25 SEARCH"), ["bm25", "search"], "ASCII 轉小寫");
assertDeepEq(tokenize(""), [], "空字串 → 空");
assertDeepEq(tokenize("原"), ["原"], "單一中文字保留（無 bigram）");
assertDeepEq(tokenize("工具鏈"), ["工具", "具鏈"], "中文 bigram");
assertDeepEq(tokenize("Git 工具鏈"), ["git", "工具", "具鏈"], "ASCII + 中文混合");
assertDeepEq(
  tokenize("git123 abc"),
  ["git123", "abc"],
  "ASCII alphanumeric 視為單一 token",
);

// 中文連續區段切分（標點隔開）
assertDeepEq(
  tokenize("原子，記憶"),
  ["原子", "記憶"],
  "中文標點隔開 → 各自切 bigram",
);

// ── Test 2: buildBM25Index ──────────────────────────────────────────────────

console.log("\n═══ Test 2: buildBM25Index ═══");

const entries = [
  { name: "preferences", path: "preferences.md", triggers: ["偏好", "git"], confidence: "[固]" },
  { name: "decisions",   path: "decisions.md",   triggers: ["決策", "記憶系統"], confidence: "[固]" },
  { name: "toolchain",   path: "toolchain.md",   triggers: ["工具鏈", "bash", "git"], confidence: "[觀]" },
];

const index = buildBM25Index(entries);
assert(index.N === 3, "N === 3");
assert(index.docs.length === 3, "docs.length === 3");
assert(index.avgdl > 0, `avgdl > 0 (${index.avgdl.toFixed(2)})`);

// "git" 在 preferences + toolchain 兩個 doc 出現 → df=2
assert(index.df.get("git") === 2, `df("git") === 2 (got ${index.df.get("git")})`);
// "決策" 只在 decisions 出現 → df=1
assert(index.df.get("決策") === 1, `df("決策") === 1`);

// ── Test 3: bm25Search 基本命中 + 排序 ─────────────────────────────────────

console.log("\n═══ Test 3: bm25Search 基本命中 + 排序 ═══");

{
  // query "git" → preferences 和 toolchain 都命中
  const hits = bm25Search(index, "git", { topK: 5, minScore: 0 });
  console.log(`    hits: ${hits.map(h => `${h.name}@${h.score.toFixed(3)}`).join(", ")}`);
  assert(hits.length >= 2, `git 查詢 ≥ 2 命中（${hits.length}）`);
  // toolchain 文檔更短（"toolchain 工具鏈 bash git"），git 在裡面比例高 → 排第一
  // 但 BM25 也考慮 doc length penalty，短文 advantage 抵消可能不大
  assert(hits[0].score > 0, "第一名 score > 0");
  for (let i = 1; i < hits.length; i++) {
    assert(hits[i].score <= hits[i - 1].score, `排序 ${i}: ${hits[i].score} <= ${hits[i - 1].score}`);
  }
}

// ── Test 4: 中文 query ─────────────────────────────────────────────────────

console.log("\n═══ Test 4: bm25Search 中文 query ═══");

{
  // "記憶系統" → bigrams = ["記憶", "憶系", "系統"]
  // decisions 的 triggers 包含 "記憶系統" 也會切成相同 bigrams → 高命中
  const hits = bm25Search(index, "記憶系統", { topK: 3, minScore: 0 });
  console.log(`    hits: ${hits.map(h => `${h.name}@${h.score.toFixed(3)}`).join(", ")}`);
  assert(hits.length >= 1, `記憶系統 ≥ 1 命中`);
  assert(hits[0].name === "decisions", `第一名為 decisions（實際 ${hits[0].name}）`);
}

// ── Test 5: 邊界 case ──────────────────────────────────────────────────────

console.log("\n═══ Test 5: bm25Search 邊界 ═══");

{
  // 空 corpus
  const emptyIndex = buildBM25Index([]);
  assert(bm25Search(emptyIndex, "anything", {}).length === 0, "空 index → []");

  // 空 query
  assert(bm25Search(index, "", {}).length === 0, "空 query → []");

  // 全無命中
  const noHits = bm25Search(index, "xyz123 不存在的字", { topK: 5, minScore: 0 });
  assert(noHits.length === 0, "完全不相關的 query → []");

  // minScore 過濾
  const minOne = bm25Search(index, "git", { topK: 5, minScore: 100 });
  assert(minOne.length === 0, "minScore=100 過濾掉所有（real BM25 score 通常 < 5）");
}

// ── Test 6: topK 截斷 ──────────────────────────────────────────────────────

console.log("\n═══ Test 6: topK 截斷 ═══");

{
  const all = bm25Search(index, "git 工具", { topK: 100, minScore: 0 });
  const limited = bm25Search(index, "git 工具", { topK: 1, minScore: 0 });
  assert(limited.length <= 1, `topK=1 → ≤ 1 結果（${limited.length}）`);
  if (all.length > 0 && limited.length > 0) {
    assert(limited[0].name === all[0].name, "topK=1 拿到的是 score 最高的那個");
  }
}

// ── Test 7: normalizeBM25Score ─────────────────────────────────────────────

console.log("\n═══ Test 7: normalizeBM25Score ═══");

// K_NORM=2 → score=2 對應 0.5
assert(normalizeBM25Score(0) === 0, "score=0 → 0");
assert(normalizeBM25Score(-1) === 0, "score<0 → 0");
assert(normalizeBM25Score(2) === 0.5, `score=2 → 0.5 (got ${normalizeBM25Score(2)})`);
assert(normalizeBM25Score(100) > 0.9, `score=100 → > 0.9 (got ${normalizeBM25Score(100).toFixed(3)})`);
assert(normalizeBM25Score(100) < 1.0, `score=100 → < 1.0`);

// 單調遞增
let prev = -1;
for (const s of [0.5, 1, 2, 4, 8, 16, 32]) {
  const n = normalizeBM25Score(s);
  assert(n > prev, `score=${s} → ${n.toFixed(3)} > ${prev.toFixed(3)} (monotonic)`);
  prev = n;
}

// ── Test 8: BM25 hit 結構 ──────────────────────────────────────────────────

console.log("\n═══ Test 8: BM25Hit 結構 ═══");

{
  const hits = bm25Search(index, "git", { topK: 1, minScore: 0 });
  if (hits.length > 0) {
    const h = hits[0];
    assert(typeof h.name === "string", "hit.name 是 string");
    assert(typeof h.score === "number" && h.score > 0, `hit.score > 0 (${h.score})`);
    assert(
      typeof h.normalizedScore === "number" && h.normalizedScore >= 0 && h.normalizedScore < 1,
      `hit.normalizedScore in [0, 1) (${h.normalizedScore})`,
    );
    const expected = h.score / (h.score + 2);
    assert(
      Math.abs(h.normalizedScore - expected) < 1e-6,
      `normalizedScore === score/(score+2)`,
    );
  } else {
    console.log("  (no hits to inspect)");
  }
}

console.log(`\n═══ 結果：${passed} passed, ${failed} failed ═══`);
process.exit(failed > 0 ? 1 : 0);
