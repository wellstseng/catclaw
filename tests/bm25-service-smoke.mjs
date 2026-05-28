/**
 * bm25-service smoke test — V5 P6
 *
 * 測試項目：
 *   1. buildGlobalIndex 掃 atoms + tokenize 全內容 + 構造 BM25Index
 *   2. saveGlobalIndex → loadGlobalIndex round-trip（Map 序列化 / 反序列化）
 *   3. searchGlobal 命中 .md 內容（不只 trigger）
 *   4. invalidate 後下次 search 自動 rebuild
 *   5. stale detection：atom mtime > index builtAt → rebuild
 *   6. integration with atom-io：writeAtom 後 invalidate；後續 searchGlobal 反映新 atom
 *
 * 用法：node tests/bm25-service-smoke.mjs
 */

import { mkdirSync, rmSync, existsSync, utimesSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  INDEX_RELATIVE_PATH,
  buildGlobalIndex,
  saveGlobalIndex,
  loadGlobalIndex,
  searchGlobal,
  invalidate,
} from "../dist/memory/bm25-service.js";

import { writeAtom as ioWriteAtom, deleteAtom as ioDeleteAtom } from "../dist/memory/atom-io.js";

let passed = 0, failed = 0;
function assert(c, n) { if (c) { console.log(`  ✓ ${n}`); passed++; } else { console.error(`  ✗ ${n}`); failed++; } }
function assertEq(a, b, n) { assert(a === b, `${n} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`); }

const cleanupDirs = [];
function freshDir(label) {
  const d = join(tmpdir(), `catclaw-bm25svc-${label}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2,8)}`);
  mkdirSync(d, { recursive: true });
  cleanupDirs.push(d);
  return d;
}
process.on("exit", () => { for (const d of cleanupDirs) { try { rmSync(d, { recursive: true, force: true }); } catch {} } });

function seed(dir, name, content, triggers = []) {
  ioWriteAtom({ dir, name, content, confidence: "[固]", triggers, source: "test" });
}

// ── Test 1: buildGlobalIndex ────────────────────────────────────────────

console.log("\n═══ Test 1: buildGlobalIndex 全內容 tokenize ═══");
{
  const dir = freshDir("t1");
  seed(dir, "alpha", "git 工具鏈設定", ["git"]);
  seed(dir, "beta", "BM25 ranking 演算法", ["bm25", "ranking"]);
  const idx = buildGlobalIndex(dir);
  assertEq(idx.N, 2, "N=2 atoms");
  assert(idx.avgdl > 0, `avgdl > 0 (${idx.avgdl.toFixed(2)})`);
  assert(idx.df.size > 0, `df size > 0 (${idx.df.size}）`);

  // 內容（非 trigger）應被索引：alpha content 含「工具鏈」→ 切出 「工具」「具鏈」
  assert(idx.df.has("工具"), "全內容 token『工具』在 df");
  assert(idx.df.has("具鏈"), "全內容 token『具鏈』在 df");
  // trigger 也應被索引
  assert(idx.df.has("git"), "trigger『git』在 df");
}

// ── Test 2: save / load round-trip ─────────────────────────────────────

console.log("\n═══ Test 2: save/load round-trip ═══");
{
  const dir = freshDir("t2");
  seed(dir, "x", "content x", ["xtrig"]);
  seed(dir, "y", "content y", ["ytrig"]);
  const built = buildGlobalIndex(dir);
  saveGlobalIndex(dir, built);
  assert(existsSync(join(dir, INDEX_RELATIVE_PATH)), "index 持久化");

  const loaded = loadGlobalIndex(dir);
  assertEq(loaded.N, built.N, "N round-trip");
  assertEq(loaded.docs.length, built.docs.length, "docs length round-trip");
  assert(loaded.df.size === built.df.size, `df size round-trip (${loaded.df.size} vs ${built.df.size})`);
  assert(loaded.docs[0].tf.size > 0, "doc tf 反序列化為 Map");
}

// ── Test 3: searchGlobal 命中內容 ──────────────────────────────────────

console.log("\n═══ Test 3: searchGlobal 命中 .md 內容（非僅 trigger）═══");
{
  const dir = freshDir("t3");
  // a 的 content 含「BM25 ranking」但 trigger 不含
  seed(dir, "atom-a", "BM25 ranking 演算法說明", ["other-trigger"]);
  // b 完全無關
  seed(dir, "atom-b", "Discord bot 通訊", ["discord"]);

  // 查「BM25」應命中 a（即使 a 的 trigger 不含 BM25）
  const hits = searchGlobal(dir, "BM25", { topK: 5 });
  assert(hits.length >= 1, `BM25 query ≥ 1 命中（${hits.length}）`);
  assertEq(hits[0].name, "atom-a", `第一名為 atom-a（命中 content）`);
  assert(hits[0].score > 0, `score > 0 (${hits[0].score.toFixed(3)})`);
  assert(hits[0].normalizedScore >= 0 && hits[0].normalizedScore < 1,
    `normalizedScore in [0,1) (${hits[0].normalizedScore.toFixed(3)})`);
}

// ── Test 4: invalidate + auto rebuild ──────────────────────────────────

console.log("\n═══ Test 4: invalidate 後 search 自動 rebuild ═══");
{
  const dir = freshDir("t4");
  seed(dir, "old", "old content", ["old"]);
  loadGlobalIndex(dir); // 觸發 build + save

  // 加新 atom
  seed(dir, "new", "new content keyword foobar", ["new"]);
  invalidate(dir);

  // search 應觸發 rebuild + 命中新 atom
  const hits = searchGlobal(dir, "foobar", { topK: 5 });
  assert(hits.some(h => h.name === "new"), "rebuild 後命中新 atom『new』");
}

// ── Test 5: stale mtime detection ──────────────────────────────────────

console.log("\n═══ Test 5: stale mtime detection ═══");
{
  const dir = freshDir("t5");
  seed(dir, "first", "content one", ["a"]);
  const idx1 = loadGlobalIndex(dir);
  const builtAt1 = idx1.builtAt;

  // 模擬 atom 被外部 touch（mtime 推到 future，遠超 builtAt）
  const atomPath = join(dir, "first.md");
  const future = (builtAt1 + 60_000) / 1000;
  utimesSync(atomPath, future, future);

  // 用底層 _isStale 直接驗證 stale 偵測（避開 Date.now 同 ms 對 builtAt 比對的脆性）
  const { _isStale } = await import("../dist/memory/bm25-service.js");
  assertEq(_isStale(dir, idx1), true, "isStale 偵測 atom mtime > index builtAt");

  // 再 load 應觸發 rebuild；不論 builtAt 是否同 ms 推進，rebuild 必然發生
  const idx2 = loadGlobalIndex(dir);
  assert(idx2.builtAt >= builtAt1, "rebuild 後 builtAt 不退（>=）");
  // rebuild 後對同 idx 再 isStale 必為 false（剛 build 完，mtime <= builtAt）
  assertEq(_isStale(dir, idx2), false, "rebuild 後不再 stale");
}

// ── Test 6: integration with atom-io ──────────────────────────────────

console.log("\n═══ Test 6: atom-io write → invalidate → search 反映 ═══");
{
  const dir = freshDir("t6");
  seed(dir, "alpha", "alpha content", ["a"]);
  // 第一次 search 觸發 build
  searchGlobal(dir, "alpha", { topK: 1 });
  const indexPath = join(dir, INDEX_RELATIVE_PATH);
  assert(existsSync(indexPath), "index 已建立");

  // 寫新 atom（atom-io 內部會呼叫 invalidate）
  ioWriteAtom({
    dir, name: "beta",
    content: "beta unique-token-xyz",
    confidence: "[固]", triggers: ["b"],
    source: "test",
  });

  // search 新 atom 的 unique token
  const hits = searchGlobal(dir, "unique-token-xyz", { topK: 3 });
  assert(hits.some(h => h.name === "beta"), "atom-io.writeAtom 後新 atom 可被搜到");

  // 刪 atom 後不再被搜到
  ioDeleteAtom(join(dir, "beta.md"), "test");
  const hits2 = searchGlobal(dir, "unique-token-xyz", { topK: 3 });
  assert(!hits2.some(h => h.name === "beta"), "atom-io.deleteAtom 後不再被搜到");
}

console.log(`\n═══ 結果：${passed} passed, ${failed} failed ═══`);
process.exit(failed > 0 ? 1 : 0);
