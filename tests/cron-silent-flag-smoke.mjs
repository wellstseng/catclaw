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
function parseExecFlags(content) {
  const trimmed = content.trim();
  const m = trimmed.match(/^(--silent|-s)\s+(.+)$/);
  if (m) return { silent: true, command: m[2] };
  return { silent: false, command: trimmed };
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

// ── Test 3: 無 flag ────────────────────────────────────────────────────

console.log("\n═══ Test 3: 無 flag ═══");
{
  const r = parseExecFlags("ls -la");
  assertEq(r.silent, false, "silent=false");
  assertEq(r.command, "ls -la", "command 不變");
}

// ── Test 4: flag 在指令中段不誤觸 ──────────────────────────────────────

console.log("\n═══ Test 4: --silent 在中段不誤觸 ═══");
{
  const r = parseExecFlags("npm test --silent");
  assertEq(r.silent, false, "中段 --silent 不觸發 flag");
  assertEq(r.command, "npm test --silent", "command 完整保留");
}

// ── Test 5: 前後空白 ──────────────────────────────────────────────────

console.log("\n═══ Test 5: 前後空白 trim ═══");
{
  const r = parseExecFlags("   --silent   echo hi   ");
  assertEq(r.silent, true, "trim 後仍識別 flag");
  assertEq(r.command, "echo hi", "command 前後空白已 trim（trim() 副作用）");
}

// ── Test 6: 邊界 — 只有 flag 沒 command ──────────────────────────────

console.log("\n═══ Test 6: 只有 --silent 沒 command（不該 match）═══");
{
  const r = parseExecFlags("--silent");
  // regex 要求 flag 後至少 1 空白 + 非空 → 不 match → silent=false, command="--silent"
  assertEq(r.silent, false, "孤立 --silent 不視為 flag");
  assertEq(r.command, "--silent", "command 原樣保留");
}

// ── Test 7: --silentX 不誤觸（boundary） ──────────────────────────────

console.log("\n═══ Test 7: --silent-mode 之類不誤觸 ═══");
{
  const r = parseExecFlags("--silent-mode foo");
  // 我們的 regex `^(--silent|-s)\s+`，--silent 後緊接 -mode 不是 \s → 不 match
  assertEq(r.silent, false, "--silent-mode 不誤觸");
  assertEq(r.command, "--silent-mode foo", "command 原樣");
}

console.log(`\n═══ 結果：${passed} passed, ${failed} failed ═══`);
process.exit(failed > 0 ? 1 : 0);
