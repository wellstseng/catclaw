/**
 * atom-index-json smoke test — V5 P3b JSON SoT
 *
 * 測試項目：
 *   1. load 不存在的 dir → empty index
 *   2. upsertAtom 新增 → 變更，return true；重複同內容 → return false（no-op）
 *   3. upsertAtom 修改 triggers → return true；JSON 內容反映新值
 *   4. deleteAtom 移除 → return true；再次刪 → false
 *   5. saveAtomIndexJson + loadAtomIndexJson round-trip
 *   6. regenerateAtomIndexMd 產生 markdown 鏡像，內容含 auto-generated 標記
 *   7. parseLegacyMemoryMd 還原 entries
 *   8. migrateMdToJson idempotent（已存在則跳過；overwrite 則覆寫）
 *   9. validateIndex 偵測：missing file / version mismatch / duplicate name /
 *      duplicate path / triggers not list / trigger too long (>30)
 *  10. 與 index-manager 整合：loadIndex 回傳同步反映 JSON 內容
 *
 * 用法：node tests/atom-index-json-smoke.mjs
 */

import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  SCHEMA_VERSION,
  ATOM_INDEX_JSON,
  loadAtomIndexJson,
  saveAtomIndexJson,
  upsertAtom,
  deleteAtom,
  regenerateAtomIndexMd,
  parseLegacyMemoryMd,
  migrateMdToJson,
  validateIndex,
} from "../dist/memory/atom-index-json.js";

import {
  loadIndex,
  upsertIndex,
  removeIndex,
  matchTriggers,
} from "../dist/memory/index-manager.js";

// ── 測試工具 ────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(cond, name) {
  if (cond) { console.log(`  ✓ ${name}`); passed++; }
  else { console.error(`  ✗ ${name}`); failed++; }
}

function assertEq(a, b, name) {
  assert(a === b, `${name} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`);
}

function freshDir(label) {
  const dir = join(tmpdir(), `catclaw-atom-index-${label}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const cleanupDirs = [];
function withTmpDir(label) {
  const d = freshDir(label);
  cleanupDirs.push(d);
  return d;
}

process.on("exit", () => {
  for (const d of cleanupDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// ── Test 1: load 不存在 dir ─────────────────────────────────────────────────

console.log("\n═══ Test 1: load 空目錄 ═══");
{
  const dir = withTmpDir("t1");
  const data = loadAtomIndexJson(dir);
  assertEq(data.version, SCHEMA_VERSION, "version === 1.0");
  assertEq(data.atoms.length, 0, "atoms 為空");
}

// ── Test 2: upsertAtom 新增 + no-op ─────────────────────────────────────────

console.log("\n═══ Test 2: upsertAtom 新增與 no-op ═══");
{
  const dir = withTmpDir("t2");
  const entry = { name: "preferences", path: "preferences.md", triggers: ["偏好", "風格"], confidence: "[固]" };
  assert(upsertAtom(dir, entry) === true, "新增回傳 true");
  const data = loadAtomIndexJson(dir);
  assertEq(data.atoms.length, 1, "atoms.length === 1");
  assertEq(data.atoms[0].name, "preferences", "name 正確");

  // 同內容再寫一次 → no-op
  assert(upsertAtom(dir, entry) === false, "重複同內容回傳 false（no-op）");
  assertEq(loadAtomIndexJson(dir).atoms.length, 1, "沒有重複新增");
}

// ── Test 3: upsertAtom 修改 ────────────────────────────────────────────────

console.log("\n═══ Test 3: upsertAtom 修改 ═══");
{
  const dir = withTmpDir("t3");
  upsertAtom(dir, { name: "decisions", path: "decisions.md", triggers: ["決策"], confidence: "[固]" });
  const changed = upsertAtom(dir, { name: "decisions", path: "decisions.md", triggers: ["決策", "新trigger"], confidence: "[觀]" });
  assert(changed === true, "trigger 變更 → return true");
  const data = loadAtomIndexJson(dir);
  assertEq(data.atoms.length, 1, "仍只有 1 個（覆寫非新增）");
  assertEq(data.atoms[0].triggers.length, 2, "triggers 變 2 個");
  assertEq(data.atoms[0].confidence, "[觀]", "confidence 更新");
}

// ── Test 4: deleteAtom ─────────────────────────────────────────────────────

console.log("\n═══ Test 4: deleteAtom ═══");
{
  const dir = withTmpDir("t4");
  upsertAtom(dir, { name: "a", path: "a.md", triggers: ["x"], confidence: "[固]" });
  upsertAtom(dir, { name: "b", path: "b.md", triggers: ["y"], confidence: "[觀]" });
  assert(deleteAtom(dir, "a") === true, "刪 a 回傳 true");
  const data = loadAtomIndexJson(dir);
  assertEq(data.atoms.length, 1, "剩 1 個");
  assertEq(data.atoms[0].name, "b", "剩下的是 b");
  assert(deleteAtom(dir, "a") === false, "再刪 a 回傳 false");
}

// ── Test 5: save / load round-trip ─────────────────────────────────────────

console.log("\n═══ Test 5: save/load round-trip ═══");
{
  const dir = withTmpDir("t5");
  const data = {
    version: SCHEMA_VERSION,
    atoms: [
      { name: "x", path: "x.md", triggers: ["t1", "t2"], confidence: "[固]" },
      { name: "y", path: "y.md", triggers: [], confidence: "[臨]" },
    ],
  };
  saveAtomIndexJson(dir, data);
  const loaded = loadAtomIndexJson(dir);
  assertEq(JSON.stringify(loaded), JSON.stringify(data), "round-trip JSON 結構一致");
}

// ── Test 6: regenerateAtomIndexMd ──────────────────────────────────────────

console.log("\n═══ Test 6: regenerateAtomIndexMd 鏡像 ═══");
{
  const dir = withTmpDir("t6");
  upsertAtom(dir, { name: "foo", path: "foo.md", triggers: ["aaa", "bbb"], confidence: "[固]" });
  const mdPath = join(dir, "MEMORY.md");
  assert(existsSync(mdPath), "MEMORY.md 自動產生");
  const md = readFileSync(mdPath, "utf-8");
  assert(md.includes("Auto-generated mirror"), "含 auto-generated 標記");
  assert(md.includes("| foo | foo.md | aaa, bbb | [固] |"), "表格列正確");

  // 手動再呼叫 regenerate 也應該等效
  regenerateAtomIndexMd(dir);
  assert(existsSync(mdPath), "regenerate 後檔案仍在");
}

// ── Test 7: parseLegacyMemoryMd ────────────────────────────────────────────

console.log("\n═══ Test 7: parseLegacyMemoryMd ═══");
{
  const dir = withTmpDir("t7");
  const legacy = [
    "# Atom Index",
    "",
    "| Atom | Path | Trigger | Confidence |",
    "|------|------|---------|------------|",
    "| sub-a | sub-a.md | trig1, trig2 | [固] |",
    "| sub-b | sub-b.md | trig3 | [觀] |",
    "",
    "其他內容",
  ].join("\n");
  const mdPath = join(dir, "MEMORY.md");
  writeFileSync(mdPath, legacy, "utf-8");
  const atoms = parseLegacyMemoryMd(mdPath);
  assertEq(atoms.length, 2, "解析 2 筆");
  assertEq(atoms[0].name, "sub-a", "第一筆 name");
  assertEq(atoms[0].triggers.length, 2, "trigger 切 2 個");
  assertEq(atoms[1].confidence, "[觀]", "第二筆 confidence");
}

// ── Test 8: migrateMdToJson idempotent ────────────────────────────────────

console.log("\n═══ Test 8: migrateMdToJson idempotent ═══");
{
  const dir = withTmpDir("t8");
  const legacy = [
    "# Atom Index",
    "| Atom | Path | Trigger | Confidence |",
    "|------|------|---------|------------|",
    "| old-atom | old-atom.md | aa, bb | [固] |",
  ].join("\n");
  writeFileSync(join(dir, "MEMORY.md"), legacy, "utf-8");

  const first = migrateMdToJson(dir);
  assertEq(first.atoms.length, 1, "第一次遷移產生 1 筆");

  // 修改 JSON（人為更動）後再呼叫 — idempotent 不會覆寫
  saveAtomIndexJson(dir, { version: SCHEMA_VERSION, atoms: [{ name: "manual", path: "manual.md", triggers: [], confidence: "[臨]" }] });
  const second = migrateMdToJson(dir);
  assertEq(second.atoms[0].name, "manual", "已有 JSON 預設不覆寫（idempotent）");

  // overwrite=true → 重新從 MD parse
  const third = migrateMdToJson(dir, { overwrite: true });
  assertEq(third.atoms[0].name, "old-atom", "overwrite 後從 MD 重生");
}

// ── Test 9: validateIndex ───────────────────────────────────────────────────

console.log("\n═══ Test 9: validateIndex ═══");
{
  // 9a: 缺檔
  {
    const dir = withTmpDir("t9a");
    const errs = validateIndex(dir);
    assert(errs.length === 1 && errs[0].startsWith("missing:"), "缺檔回 missing");
  }

  // 9b: ok
  {
    const dir = withTmpDir("t9b");
    upsertAtom(dir, { name: "a", path: "a.md", triggers: ["x"], confidence: "[固]" });
    const errs = validateIndex(dir);
    assertEq(errs.length, 0, "正常 → 0 error");
  }

  // 9c: version mismatch
  {
    const dir = withTmpDir("t9c");
    saveAtomIndexJson(dir, { version: "9.9", atoms: [] });
    const errs = validateIndex(dir);
    assert(errs.some(e => e.includes("version mismatch")), "偵測 version mismatch");
  }

  // 9d: duplicate name
  {
    const dir = withTmpDir("t9d");
    saveAtomIndexJson(dir, {
      version: SCHEMA_VERSION,
      atoms: [
        { name: "dup", path: "a.md", triggers: [], confidence: "[固]" },
        { name: "dup", path: "b.md", triggers: [], confidence: "[固]" },
      ],
    });
    const errs = validateIndex(dir);
    assert(errs.some(e => e.includes("duplicate name: dup")), "偵測 duplicate name");
  }

  // 9e: duplicate path
  {
    const dir = withTmpDir("t9e");
    saveAtomIndexJson(dir, {
      version: SCHEMA_VERSION,
      atoms: [
        { name: "x", path: "same.md", triggers: [], confidence: "[固]" },
        { name: "y", path: "same.md", triggers: [], confidence: "[固]" },
      ],
    });
    const errs = validateIndex(dir);
    assert(errs.some(e => e.includes("duplicate path: same.md")), "偵測 duplicate path");
  }

  // 9f: triggers not list
  {
    const dir = withTmpDir("t9f");
    writeFileSync(
      join(dir, ATOM_INDEX_JSON),
      JSON.stringify({ version: SCHEMA_VERSION, atoms: [{ name: "x", path: "x.md", triggers: "not-list", confidence: "[固]" }] }),
      "utf-8",
    );
    const errs = validateIndex(dir);
    assert(errs.some(e => e.includes("triggers not list")), "偵測 triggers 非 list");
  }

  // 9g: trigger too long (>30)
  {
    const dir = withTmpDir("t9g");
    const longTrigger = "x".repeat(31);
    saveAtomIndexJson(dir, {
      version: SCHEMA_VERSION,
      atoms: [{ name: "x", path: "x.md", triggers: [longTrigger], confidence: "[固]" }],
    });
    const errs = validateIndex(dir);
    assert(errs.some(e => e.includes("trigger too long")), "偵測 trigger 超長");
  }
}

// ── Test 10: index-manager 整合 ─────────────────────────────────────────────

console.log("\n═══ Test 10: index-manager 整合（loadIndex/upsertIndex/removeIndex）═══");
{
  const dir = withTmpDir("t10");
  const memoryMdPath = join(dir, "MEMORY.md");

  // upsertIndex 走 JSON SoT
  upsertIndex(memoryMdPath, { name: "preferences", path: "preferences.md", triggers: ["偏好", "風格"], confidence: "[固]" });
  upsertIndex(memoryMdPath, { name: "toolchain", path: "toolchain.md", triggers: ["工具鏈", "git"], confidence: "[觀]" });

  // _atom_index.json 應已產生
  assert(existsSync(join(dir, "_atom_index.json")), "_atom_index.json 存在");
  // MEMORY.md mirror 也應該存在
  assert(existsSync(memoryMdPath), "MEMORY.md mirror 存在");

  // loadIndex 回傳一致內容
  const entries = loadIndex(memoryMdPath);
  assertEq(entries.length, 2, "loadIndex 回傳 2 筆");
  const names = entries.map(e => e.name).sort();
  assertEq(JSON.stringify(names), JSON.stringify(["preferences", "toolchain"]), "names 正確");

  // matchTriggers 仍能匹配（trigger 大小寫不敏感）
  const matched = matchTriggers("我要看 git 工具鏈", entries);
  assertEq(matched.length, 1, "matchTriggers 命中 1 個");
  assertEq(matched[0].name, "toolchain", "命中 toolchain");

  // removeIndex
  removeIndex(memoryMdPath, "preferences");
  const after = loadIndex(memoryMdPath);
  assertEq(after.length, 1, "remove 後剩 1 筆");
  assertEq(after[0].name, "toolchain", "剩下的是 toolchain");
}

// ── Test 11: legacy MD fallback ─────────────────────────────────────────────

console.log("\n═══ Test 11: legacy MD fallback（_atom_index.json 不存在）═══");
{
  const dir = withTmpDir("t11");
  const memoryMdPath = join(dir, "MEMORY.md");
  // 手寫舊格式 MEMORY.md，不建 JSON
  const legacy = [
    "# Atom Index",
    "| Atom | Path | Trigger | Confidence |",
    "|------|------|---------|------------|",
    "| legacy-a | legacy-a.md | foo, bar | [固] |",
  ].join("\n");
  writeFileSync(memoryMdPath, legacy, "utf-8");

  // 沒有 JSON 時 loadIndex 該 fallback 讀 MD
  assert(!existsSync(join(dir, "_atom_index.json")), "_atom_index.json 尚未產生");
  const entries = loadIndex(memoryMdPath);
  assertEq(entries.length, 1, "fallback 讀 MD 取得 1 筆");
  assertEq(entries[0].name, "legacy-a", "fallback 解析 name 正確");
  assertEq(entries[0].triggers.length, 2, "fallback 解析 triggers");
}

// ── 結果 ────────────────────────────────────────────────────────────────────

console.log(`\n═══ 結果：${passed} passed, ${failed} failed ═══`);
process.exit(failed > 0 ? 1 : 0);
