/**
 * cron silent flag smoke test
 *
 * 確認 parseExecFlags 正確抽 --silent / -s 開頭 flag，
 * 不誤吃指令參數中含 --silent 字串的場景。
 *
 * 用法：node tests/cron-silent-flag-smoke.mjs
 */

// 重現 src/skills/builtin/remind.ts:parseExecFlags（remind.ts 依賴 catclaw config，
// 隔離環境 import 會 throw；smoke 同步邏輯而非載入）
// 預設 silent=true；--verbose / -v 反向 flag
function parseExecFlags(content) {
  const trimmed = content.trim();
  const verboseMatch = trimmed.match(/^(--verbose|-v)\s+(.+)$/);
  if (verboseMatch) return { silent: false, command: verboseMatch[2] };
  const silentMatch = trimmed.match(/^(--silent|-s)\s+(.+)$/);
  if (silentMatch) return { silent: true, command: silentMatch[2] };
  return { silent: true, command: trimmed };
}

let passed = 0, failed = 0;
function assert(c, n) { if (c) { console.log(`  ✓ ${n}`); passed++; } else { console.error(`  ✗ ${n}`); failed++; } }
function assertEq(a, b, n) { assert(a === b, `${n} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`); }

// ── Test 1: --silent ────────────────────────────────────────────────────

console.log("\n═══ Test 1: --silent flag ═══");
{
  const r = parseExecFlags("--silent ls -la");
  assertEq(r.silent, true, "silent=true");
  assertEq(r.command, "ls -la", "command 去掉 flag");
}

// ── Test 2: -s 短形式 ──────────────────────────────────────────────────

console.log("\n═══ Test 2: -s 短形式 ═══");
{
  const r = parseExecFlags("-s mkdir foo");
  assertEq(r.silent, true, "silent=true");
  assertEq(r.command, "mkdir foo", "command 去掉 flag");
}

// ── Test 3: 無 flag → 預設 silent=true ─────────────────────────────────

console.log("\n═══ Test 3: 無 flag → 預設 silent=true ═══");
{
  const r = parseExecFlags("ls -la");
  assertEq(r.silent, true, "預設 silent=true（不推 Discord）");
  assertEq(r.command, "ls -la", "command 不變");
}

// ── Test 3b: --verbose 反向 flag ────────────────────────────────────────

console.log("\n═══ Test 3b: --verbose 反向 flag ═══");
{
  const r = parseExecFlags("--verbose npm run build");
  assertEq(r.silent, false, "--verbose → silent=false（強制推通知）");
  assertEq(r.command, "npm run build", "command 去掉 flag");
}

// ── Test 3c: -v 短形式 ──────────────────────────────────────────────────

console.log("\n═══ Test 3c: -v 短形式 ═══");
{
  const r = parseExecFlags("-v echo hi");
  assertEq(r.silent, false, "-v → silent=false");
  assertEq(r.command, "echo hi", "command 去掉 flag");
}

// ── Test 4: flag 在指令中段不誤觸 ──────────────────────────────────────

console.log("\n═══ Test 4: --silent / --verbose 在中段不誤觸 ═══");
{
  // 中段不 match flag regex；走預設 silent=true
  const r = parseExecFlags("npm test --silent");
  assertEq(r.silent, true, "中段 --silent 不觸發 flag → 走預設 silent=true");
  assertEq(r.command, "npm test --silent", "command 完整保留");

  const r2 = parseExecFlags("npm test --verbose");
  assertEq(r2.silent, true, "中段 --verbose 不觸發 → 走預設 silent=true");
  assertEq(r2.command, "npm test --verbose", "command 完整保留");
}

// ── Test 5: 前後空白 ──────────────────────────────────────────────────

console.log("\n═══ Test 5: 前後空白 trim ═══");
{
  const r = parseExecFlags("   --silent   echo hi   ");
  assertEq(r.silent, true, "trim 後仍識別 flag");
  assertEq(r.command, "echo hi", "command 前後空白已 trim（trim() 副作用）");
}

// ── Test 6: 邊界 — 只有 flag 沒 command ──────────────────────────────

console.log("\n═══ Test 6: 孤立 flag 沒 command（不該 match → 走預設）═══");
{
  // regex 要求 flag 後至少 1 空白 + 非空 → 不 match → 走預設 silent=true
  const r = parseExecFlags("--silent");
  assertEq(r.silent, true, "孤立 --silent 不視為 flag → 預設 silent=true");
  assertEq(r.command, "--silent", "command 原樣保留");

  const r2 = parseExecFlags("--verbose");
  assertEq(r2.silent, true, "孤立 --verbose 不視為 flag → 預設 silent=true");
  assertEq(r2.command, "--verbose", "command 原樣保留");
}

// ── Test 7: --silentX 不誤觸（boundary） ──────────────────────────────

console.log("\n═══ Test 7: --silent-mode 之類不誤觸 flag regex ═══");
{
  const r = parseExecFlags("--silent-mode foo");
  // regex `^(--silent|-s)\s+`，--silent 後緊接 -mode 不是 \s → 不 match → 走預設 silent=true
  assertEq(r.silent, true, "--silent-mode 不誤觸 flag regex → 走預設 silent=true");
  assertEq(r.command, "--silent-mode foo", "command 原樣");
}

console.log(`\n═══ 結果：${passed} passed, ${failed} failed ═══`);
process.exit(failed > 0 ? 1 : 0);
