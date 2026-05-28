/**
 * atom-access smoke test — V5 P3
 *
 * 測試項目：
 *   1. readAccess 不存在 → null
 *   2. initAccess idempotent + return existing
 *   3. incrementReadHits 累加 + 更新 last_used + push timestamps（bounded 50）
 *   4. incrementConfirmation 累加 + push event（bounded 50）
 *   5. recordPromotion 寫 last_promoted_at
 *   6. deleteAccess 移除檔案
 *   7. migrateFromMd 從 .md metadata 建檔；idempotent
 *   8. legacy schema：confirmations 是陣列 → 自動轉 v2
 *   9. integration with atom.touchAtom + readAtom：寫入後讀取反映正確 confirmations
 *
 * 用法：node tests/atom-access-smoke.mjs
 */

import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  ACCESS_SCHEMA,
  readAccess,
  writeAccess,
  deleteAccess,
  initAccess,
  incrementReadHits,
  incrementConfirmation,
  recordPromotion,
  migrateFromMd,
} from "../dist/memory/atom-access.js";

import { writeAtom, readAtom, touchAtom } from "../dist/memory/atom.js";

let passed = 0;
let failed = 0;

function assert(cond, name) {
  if (cond) { console.log(`  ✓ ${name}`); passed++; }
  else { console.error(`  ✗ ${name}`); failed++; }
}
function assertEq(a, b, name) {
  assert(a === b, `${name} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`);
}

const cleanupDirs = [];
function tmpAtom(label) {
  const dir = join(tmpdir(), `catclaw-access-${label}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2,8)}`);
  mkdirSync(dir, { recursive: true });
  cleanupDirs.push(dir);
  const path = join(dir, `${label}.md`);
  writeFileSync(path, `# ${label}\n\n- Confidence: [固]\n- Trigger: x\n\n## 知識\n\nhi\n`, "utf-8");
  return { dir, path };
}
process.on("exit", () => {
  for (const d of cleanupDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch {}
  }
});

// ── Test 1 ──────────────────────────────────────────────────────────────────

console.log("\n═══ Test 1: readAccess 不存在 → null ═══");
{
  const { path } = tmpAtom("t1");
  assertEq(readAccess(path), null, "未 init → null");
}

// ── Test 2 ──────────────────────────────────────────────────────────────────

console.log("\n═══ Test 2: initAccess idempotent ═══");
{
  const { path } = tmpAtom("t2");
  const a = initAccess(path, "2026-01-01");
  assertEq(a.schema, ACCESS_SCHEMA, "schema 正確");
  assertEq(a.first_seen, "2026-01-01", "first_seen 帶入");
  assertEq(a.read_hits, 0, "read_hits=0");

  const b = initAccess(path, "2026-12-31");
  assertEq(b.first_seen, "2026-01-01", "idempotent 不覆寫 first_seen");
}

// ── Test 3 ──────────────────────────────────────────────────────────────────

console.log("\n═══ Test 3: incrementReadHits ═══");
{
  const { path } = tmpAtom("t3");
  initAccess(path);
  for (let i = 0; i < 55; i++) incrementReadHits(path);
  const a = readAccess(path);
  assertEq(a.read_hits, 55, "read_hits 累加 55");
  assert(a.timestamps.length <= 50, `timestamps bounded ≤ 50 (got ${a.timestamps.length})`);
}

// ── Test 4 ──────────────────────────────────────────────────────────────────

console.log("\n═══ Test 4: incrementConfirmation ═══");
{
  const { path } = tmpAtom("t4");
  for (let i = 0; i < 3; i++) incrementConfirmation(path, "test-source");
  const a = readAccess(path);
  assertEq(a.confirmations, 3, "confirmations=3");
  assertEq(a.confirmation_events.length, 3, "events 記 3 筆");
  assertEq(a.confirmation_events[0].source, "test-source", "event source 正確");
}

// ── Test 5 ──────────────────────────────────────────────────────────────────

console.log("\n═══ Test 5: recordPromotion ═══");
{
  const { path } = tmpAtom("t5");
  initAccess(path);
  recordPromotion(path, "[觀]");
  const a = readAccess(path);
  assert(a.last_promoted_at !== null, "last_promoted_at 寫入");
  assert(/^\d{4}-\d{2}-\d{2}$/.test(a.last_promoted_at), "ISO date 格式");
}

// ── Test 6 ──────────────────────────────────────────────────────────────────

console.log("\n═══ Test 6: deleteAccess ═══");
{
  const { path } = tmpAtom("t6");
  initAccess(path);
  assert(existsSync(`${path}.access.json`), "access.json 存在");
  assertEq(deleteAccess(path), true, "刪除回傳 true");
  assert(!existsSync(`${path}.access.json`), "檔案被刪");
  assertEq(deleteAccess(path), false, "再刪 → false");
}

// ── Test 7 ──────────────────────────────────────────────────────────────────

console.log("\n═══ Test 7: migrateFromMd ═══");
{
  const { path } = tmpAtom("t7");
  const out = migrateFromMd(path, { lastUsed: "2025-12-31", confirmations: 7, createdAt: Date.parse("2025-01-01") });
  assertEq(out.confirmations, 7, "migration 帶入 confirmations");
  assertEq(out.last_used, "2025-12-31", "migration 帶入 last_used");
  assertEq(out.first_seen, "2025-01-01", "migration 帶入 first_seen");

  // idempotent：再次 migrate 同樣值 → 不覆寫（confirmations 沒增加）
  const again = migrateFromMd(path, { lastUsed: "2025-12-31", confirmations: 7 });
  assertEq(again.confirmations, 7, "idempotent 不覆寫");
}

// ── Test 8: legacy schema ──────────────────────────────────────────────────

console.log("\n═══ Test 8: legacy confirmations as array ═══");
{
  const { path } = tmpAtom("t8");
  // 寫一份舊 schema：confirmations 是陣列
  writeFileSync(`${path}.access.json`, JSON.stringify({
    confirmations: [Date.now(), Date.now() - 1000, Date.now() - 2000],
    last_used: "2025-06-01",
  }), "utf-8");
  const a = readAccess(path);
  assertEq(a.confirmations, 3, "陣列長度 → confirmations 數字");
  assertEq(a.confirmation_events.length, 3, "events 轉成 3 筆");
}

// ── Test 9: integration with atom.ts ──────────────────────────────────────

console.log("\n═══ Test 9: writeAtom + touchAtom + readAtom integration ═══");
{
  const { dir } = tmpAtom("t9-host");
  const filePath = writeAtom(dir, "integ", {
    description: "integ test",
    confidence: "[固]",
    triggers: ["t"],
    content: "hello",
  });

  // .md 不含 Last-used / Confirmations 欄
  const md = readFileSync(filePath, "utf-8");
  assert(!md.includes("- Last-used:"), ".md 不寫 Last-used");
  assert(!md.includes("- Confirmations:"), ".md 不寫 Confirmations");

  // access.json 自動 init
  assert(existsSync(`${filePath}.access.json`), "access.json 自動 init");

  // touch 後 confirmations 累加
  touchAtom(filePath, "integ-test");
  touchAtom(filePath, "integ-test");
  const atom = readAtom(filePath);
  assertEq(atom.confirmations, 2, "readAtom 反映 access.json confirmations=2");
  assert(atom.lastUsed, "readAtom 有 lastUsed");
}

console.log(`\n═══ 結果：${passed} passed, ${failed} failed ═══`);
process.exit(failed > 0 ? 1 : 0);
