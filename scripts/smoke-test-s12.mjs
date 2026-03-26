/**
 * @file scripts/smoke-test-s12.mjs
 * @description Smoke test — S12 Migration tools
 * 執行：node scripts/smoke-test-s12.mjs
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let passed = 0, failed = 0;
const _queue = [];

function test(name, fn) { _queue.push({ name, fn }); }
async function runAll() {
  for (const { name, fn } of _queue) {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (err) { console.error(`  ✗ ${name}: ${err.message}`); failed++; }
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg ?? "assertion failed"); }
function assertEqual(a, b, msg) { if (a !== b) throw new Error(msg ?? `${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }

// ── 1. importFromClaude ─────────────────────────────────────────────────────

test("importFromClaude: 複製 atom 檔案", async () => {
  const { importFromClaude } = await import("../dist/migration/import-claude.js");
  const tmp = mkdtempSync(join(tmpdir(), "s12-import-"));
  const src = join(tmp, "src");
  const dst = join(tmp, "dst");
  mkdirSync(join(src, "memory"), { recursive: true });

  writeFileSync(join(src, "memory", "pref.md"), [
    "# preferences",
    "- Scope: global",
    "- Confidence: [固]",
    "- Trigger: 偏好",
    "- Last-used: 2026-01-01",
    "- Confirmations: 3",
    "## 知識",
    "- [固] 繁體中文",
  ].join("\n"));

  writeFileSync(join(src, "MEMORY.md"), [
    "# Atom Index",
    "| Atom | Path | Trigger | Confidence |",
    "|------|------|---------|------------|",
    "| preferences | memory/pref.md | 偏好 | [固] |",
  ].join("\n"));

  const result = await importFromClaude({ sourcePath: src, destPath: dst });
  assert(result.copied.length > 0, "should have copied files");
  assertEqual(result.errors.length, 0);
  assert(result.mergedIndexEntries > 0, "should have merged index entries");

  rmSync(tmp, { recursive: true });
});

test("importFromClaude: 不重複複製（已存在則 skip）", async () => {
  const { importFromClaude } = await import("../dist/migration/import-claude.js");
  const tmp = mkdtempSync(join(tmpdir(), "s12-skip-"));
  const src = join(tmp, "src");
  const dst = join(tmp, "dst");
  mkdirSync(join(src, "memory"), { recursive: true });
  mkdirSync(join(dst, "memory"), { recursive: true });

  writeFileSync(join(src, "memory", "a.md"), "# a\n- Trigger: a");
  writeFileSync(join(dst, "memory", "a.md"), "# a existing");

  const result = await importFromClaude({ sourcePath: src, destPath: dst, force: false });
  assertEqual(result.copied.length, 0);
  assert(result.skipped.length > 0, "should skip existing");

  rmSync(tmp, { recursive: true });
});

test("importFromClaude: --force 覆寫已存在", async () => {
  const { importFromClaude } = await import("../dist/migration/import-claude.js");
  const tmp = mkdtempSync(join(tmpdir(), "s12-force-"));
  const src = join(tmp, "src");
  const dst = join(tmp, "dst");
  mkdirSync(join(src, "memory"), { recursive: true });
  mkdirSync(join(dst, "memory"), { recursive: true });

  writeFileSync(join(src, "memory", "b.md"), "# b new");
  writeFileSync(join(dst, "memory", "b.md"), "# b old");

  const result = await importFromClaude({ sourcePath: src, destPath: dst, force: true });
  assertEqual(result.copied.length, 1);
  assertEqual(result.skipped.length, 0);

  rmSync(tmp, { recursive: true });
});

test("importFromClaude: dryRun 不寫入磁碟", async () => {
  const { importFromClaude } = await import("../dist/migration/import-claude.js");
  const { existsSync } = await import("node:fs");
  const tmp = mkdtempSync(join(tmpdir(), "s12-dry-"));
  const src = join(tmp, "src");
  const dst = join(tmp, "dst");
  mkdirSync(join(src, "memory"), { recursive: true });
  writeFileSync(join(src, "memory", "c.md"), "# c");

  const result = await importFromClaude({ sourcePath: src, destPath: dst, dryRun: true });
  assert(result.copied.length > 0, "dryRun: should report copied");
  assert(!existsSync(dst), "dryRun: should NOT create dest dir");

  rmSync(tmp, { recursive: true });
});

test("importFromClaude: 不遷移 _vectordb 和 episodic", async () => {
  const { importFromClaude } = await import("../dist/migration/import-claude.js");
  const { existsSync } = await import("node:fs");
  const tmp = mkdtempSync(join(tmpdir(), "s12-skip-dirs-"));
  const src = join(tmp, "src");
  const dst = join(tmp, "dst");
  mkdirSync(join(src, "_vectordb"), { recursive: true });
  mkdirSync(join(src, "episodic"), { recursive: true });
  mkdirSync(join(src, "memory"), { recursive: true });
  writeFileSync(join(src, "_vectordb", "data.md"), "# vector");
  writeFileSync(join(src, "episodic", "ep.md"), "# episodic");
  writeFileSync(join(src, "memory", "valid.md"), "# valid");

  const result = await importFromClaude({ sourcePath: src, destPath: dst });
  assert(result.copied.every(p => !p.includes("_vectordb") && !p.includes("episodic")),
    "should not copy _vectordb or episodic");
  assert(result.copied.some(p => p.includes("valid.md")));

  rmSync(tmp, { recursive: true });
});

// ── 2. rebuildIndex ──────────────────────────────────────────────────────────

test("rebuildIndex: 掃描並重建 MEMORY.md", async () => {
  const { rebuildIndex } = await import("../dist/migration/rebuild-index.js");
  const tmp = mkdtempSync(join(tmpdir(), "s12-rebuild-"));
  mkdirSync(join(tmp, "memory"), { recursive: true });

  writeFileSync(join(tmp, "memory", "alpha.md"), [
    "# alpha",
    "- Confidence: [固]",
    "- Trigger: alpha, test",
  ].join("\n"));
  writeFileSync(join(tmp, "memory", "beta.md"), [
    "# beta",
    "- Confidence: [觀]",
    "- Trigger: beta",
  ].join("\n"));

  const result = rebuildIndex({ memoryDir: tmp });
  assertEqual(result.atomCount, 2);
  assert(result.content.includes("alpha"), "content should include alpha");
  assert(result.content.includes("beta"), "content should include beta");
  assert(result.content.includes("| Atom | Path |"), "content should have header");

  rmSync(tmp, { recursive: true });
});

test("rebuildIndex: dryRun 不寫入", async () => {
  const { rebuildIndex } = await import("../dist/migration/rebuild-index.js");
  const { existsSync } = await import("node:fs");
  const tmp = mkdtempSync(join(tmpdir(), "s12-rebuild-dry-"));
  mkdirSync(join(tmp, "memory"), { recursive: true });
  writeFileSync(join(tmp, "memory", "g.md"), "# g\n- Trigger: g");

  const indexPath = join(tmp, "MEMORY.md");
  rebuildIndex({ memoryDir: tmp, dryRun: true });
  assert(!existsSync(indexPath), "dryRun: should NOT write MEMORY.md");

  rmSync(tmp, { recursive: true });
});

test("rebuildIndex: 跳過 _ 前綴目錄", async () => {
  const { rebuildIndex } = await import("../dist/migration/rebuild-index.js");
  const tmp = mkdtempSync(join(tmpdir(), "s12-skip-"));
  mkdirSync(join(tmp, "_staging"), { recursive: true });
  mkdirSync(join(tmp, "public"), { recursive: true });
  writeFileSync(join(tmp, "_staging", "draft.md"), "# draft\n- Trigger: draft");
  writeFileSync(join(tmp, "public", "real.md"), "# real\n- Trigger: real");

  const result = rebuildIndex({ memoryDir: tmp, dryRun: true });
  assert(result.content.includes("real"), "should include public atom");
  assert(!result.content.includes("draft"), "should skip _staging");

  rmSync(tmp, { recursive: true });
});

// ── 執行 ──────────────────────────────────────────────────────────────────────

console.log("\nSmoke Test — S12 Migration tools\n");
await runAll();
console.log(`\n結果：${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
