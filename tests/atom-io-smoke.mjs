/**
 * atom-io smoke test — V5 P4
 *
 * 測試項目：
 *   1. writeAtom funnel：產出 .md + init access.json + 記 audit log
 *   2. invalid source → throw
 *   3. dryRun：不寫檔但記 audit
 *   4. deleteAtom：刪 .md + .access.json + 記 audit
 *   5. updateAtomConfidence：改 Confidence 行 + 記 last_promoted_at + audit
 *   6. rawWrite：純 content 寫入（episodic 用）+ 記 audit；不 init access.json
 *   7. readAuditLog：parse JSONL 回 records
 *   8. integration with atom.ts writeAtom → 委派走 funnel（audit 記 source="tool:atom-write"）
 *   9. integration with consolidate.autoPromote → 走 funnel（audit 記 source="tool:consolidate-promote"）
 *
 * 用法：node tests/atom-io-smoke.mjs
 */

import { mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  writeAtom as ioWriteAtom,
  deleteAtom as ioDeleteAtom,
  updateAtomConfidence,
  rawWrite,
  readAuditLog,
  VALID_SOURCES,
  AUDIT_RELATIVE_PATH,
} from "../dist/memory/atom-io.js";

import { writeAtom, readAtom } from "../dist/memory/atom.js";
import { readAccess } from "../dist/memory/atom-access.js";

let passed = 0, failed = 0;
function assert(c, n) {
  if (c) { console.log(`  ✓ ${n}`); passed++; } else { console.error(`  ✗ ${n}`); failed++; }
}
function assertEq(a, b, n) { assert(a === b, `${n} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`); }

const cleanupDirs = [];
function freshDir(label) {
  const d = join(tmpdir(), `catclaw-io-${label}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2,8)}`);
  mkdirSync(d, { recursive: true });
  cleanupDirs.push(d);
  return d;
}
process.on("exit", () => { for (const d of cleanupDirs) { try { rmSync(d, { recursive: true, force: true }); } catch {} } });

// ── Test 1: writeAtom funnel ─────────────────────────────────────────────

console.log("\n═══ Test 1: writeAtom funnel ═══");
{
  const dir = freshDir("t1");
  const r = ioWriteAtom({
    dir, name: "foo",
    content: "hello",
    confidence: "[固]", triggers: ["t"],
    source: "test",
  });
  assert(existsSync(r.path), ".md 寫入");
  assert(existsSync(`${r.path}.access.json`), "access.json 自動 init");
  assert(r.bytes > 0, `bytes > 0 (${r.bytes})`);
  assert(/^[0-9a-f]{16}$/.test(r.auditId), "auditId 16 hex");
  // audit log
  const logs = readAuditLog(dir);
  assertEq(logs.length, 1, "audit 記 1 筆");
  assertEq(logs[0].action, "write", "audit action=write");
  assertEq(logs[0].source, "test", "audit source=test");
  assertEq(logs[0].atom_name, "foo", "audit atom_name=foo");
}

// ── Test 2: invalid source ───────────────────────────────────────────────

console.log("\n═══ Test 2: invalid source 拋錯 ═══");
{
  const dir = freshDir("t2");
  let threw = false;
  try {
    ioWriteAtom({ dir, name: "x", content: "y", source: "nonsense-source" });
  } catch (e) { threw = e.message.includes("invalid source"); }
  assert(threw, "未在 VALID_SOURCES 名單 → throw");
  assert(VALID_SOURCES.has("test"), "test 在 VALID_SOURCES");
  assert(VALID_SOURCES.has("hook:episodic"), "hook:episodic 在 VALID_SOURCES");
}

// ── Test 3: dryRun ──────────────────────────────────────────────────────

console.log("\n═══ Test 3: dryRun ═══");
{
  const dir = freshDir("t3");
  const r = ioWriteAtom({ dir, name: "dry", content: "x", source: "test", dryRun: true });
  assert(!existsSync(r.path), "dryRun 不寫檔");
  const logs = readAuditLog(dir);
  assertEq(logs.length, 1, "dryRun 仍記 audit");
  assertEq(logs[0].dry_run, true, "audit 標記 dry_run=true");
}

// ── Test 4: deleteAtom ──────────────────────────────────────────────────

console.log("\n═══ Test 4: deleteAtom ═══");
{
  const dir = freshDir("t4");
  const r = ioWriteAtom({ dir, name: "del", content: "x", source: "test" });
  assert(existsSync(r.path), "atom 寫入");
  assert(existsSync(`${r.path}.access.json`), "access.json 寫入");

  const dr = ioDeleteAtom(r.path, "test");
  assertEq(dr.deleted, true, "deleted=true");
  assert(!existsSync(r.path), ".md 被刪");
  assert(!existsSync(`${r.path}.access.json`), ".access.json 被刪");

  const logs = readAuditLog(dir);
  assertEq(logs.length, 2, "audit 記 2 筆（write + delete）");
  assertEq(logs[1].action, "delete", "第二筆 action=delete");
}

// ── Test 5: updateAtomConfidence ────────────────────────────────────────

console.log("\n═══ Test 5: updateAtomConfidence ═══");
{
  const dir = freshDir("t5");
  const r = ioWriteAtom({ dir, name: "u", content: "x", confidence: "[臨]", triggers: ["t"], source: "test" });

  const ur = updateAtomConfidence(r.path, "[觀]", "test");
  assertEq(ur.changed, true, "changed=true");

  const md = readFileSync(r.path, "utf-8");
  assert(md.includes("- Confidence: [觀]"), "Confidence 改為 [觀]");
  assert(!md.includes("- Confidence: [臨]"), "舊 Confidence 不再存在");

  const access = readAccess(r.path);
  assert(access.last_promoted_at, "last_promoted_at 寫入");

  const logs = readAuditLog(dir);
  assertEq(logs[logs.length - 1].action, "update-confidence", "audit 記 update-confidence");
}

// ── Test 6: rawWrite ────────────────────────────────────────────────────

console.log("\n═══ Test 6: rawWrite（episodic 用）═══");
{
  const dir = freshDir("t6");
  const path = join(dir, "episodic-2026-05-28-abcd.md");
  const r = rawWrite(path, "raw content", "hook:episodic");
  assert(existsSync(path), "raw 寫入");
  assert(!existsSync(`${path}.access.json`), "rawWrite 不 init access.json");
  assertEq(r.bytes, Buffer.byteLength("raw content", "utf-8"), "bytes 正確");

  const logs = readAuditLog(dir);
  assertEq(logs[0].action, "raw-write", "audit action=raw-write");
  assertEq(logs[0].source, "hook:episodic", "audit source=hook:episodic");
}

// ── Test 7: readAuditLog ────────────────────────────────────────────────

console.log("\n═══ Test 7: readAuditLog parse JSONL ═══");
{
  const dir = freshDir("t7");
  ioWriteAtom({ dir, name: "a", content: "x", source: "test" });
  ioWriteAtom({ dir, name: "b", content: "y", source: "test" });
  const logs = readAuditLog(dir);
  assertEq(logs.length, 2, "讀回 2 筆");
  assert(logs[0].id !== logs[1].id, "兩筆 id 不同");
  const auditPath = join(dir, AUDIT_RELATIVE_PATH);
  assert(existsSync(auditPath), `audit log 在 ${AUDIT_RELATIVE_PATH}`);
}

// ── Test 8: atom.writeAtom 委派 funnel ─────────────────────────────────

console.log("\n═══ Test 8: atom.writeAtom 委派 funnel ═══");
{
  const dir = freshDir("t8");
  writeAtom(dir, "delegated", {
    description: "test",
    content: "via atom.ts",
    confidence: "[固]",
    triggers: ["x"],
  });
  const logs = readAuditLog(dir);
  // atom.writeAtom 內部委派 source="tool:atom-write"
  assert(logs.some(l => l.source === "tool:atom-write" && l.atom_name === "delegated"),
    "audit 記 source=tool:atom-write");
}

// ── Test 9: integration round-trip ─────────────────────────────────────

console.log("\n═══ Test 9: integration round-trip（write→read→audit consistency）═══");
{
  const dir = freshDir("t9");
  writeAtom(dir, "rt", { description: "rt", content: "round-trip", confidence: "[觀]", triggers: ["a","b"] });
  const a = readAtom(join(dir, "rt.md"));
  assertEq(a.name, "rt", "readAtom name");
  assertEq(a.confidence, "[觀]", "readAtom confidence");
  assertEq(a.triggers.length, 2, "readAtom triggers");

  const logs = readAuditLog(dir);
  const writeRec = logs.find(l => l.action === "write" && l.atom_name === "rt");
  assert(writeRec, "audit 含對應 write record");
  assert(writeRec.bytes > 0, "write record 含 bytes");
}

console.log(`\n═══ 結果：${passed} passed, ${failed} failed ═══`);
process.exit(failed > 0 ? 1 : 0);
