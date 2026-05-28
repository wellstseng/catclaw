/**
 * Windows stdout decode smoke test — run_command CP950 fallback
 *
 * 測試項目：
 *   1. 純 UTF-8 buffer → 不觸發 fallback，直接 UTF-8 decode
 *   2. CP950 中文 buffer（如 cmd find 印錯誤訊息）→ 偵測 U+FFFD 過量 → CP950 decode 成正確中文
 *   3. CP950 buffer 沒有中文（純 ASCII）→ UTF-8 decode 也正確（不誤觸 fallback）
 *   4. CATCLAW_FORCE_DECODE=cp950 強制指定 → 即使 UTF-8 也走 CP950
 *
 * 注意：decodeWindowsStdout 是 run-command.ts 內部函式，不 export。
 *      用相同邏輯 reproduction（同步原始碼變更）。
 *
 * 用法：node tests/windows-decode-smoke.mjs
 */

import iconv from "iconv-lite";

let passed = 0, failed = 0;
function assert(c, n) { if (c) { console.log(`  ✓ ${n}`); passed++; } else { console.error(`  ✗ ${n}`); failed++; } }
function assertEq(a, b, n) { assert(a === b, `${n} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`); }

// 重現 run-command.ts:decodeWindowsStdout 邏輯（雙門檻）
const REPLACEMENT_CHAR = "�";
const MOJIBAKE_THRESHOLD = 0.03;
const MOJIBAKE_MIN_COUNT = 3;

function decodeWindowsStdout(buf) {
  const forced = process.env["CATCLAW_FORCE_DECODE"];
  if (forced && iconv.encodingExists(forced)) {
    return iconv.decode(buf, forced);
  }
  const utf8 = buf.toString("utf8");
  let count = 0;
  for (let i = 0; i < utf8.length; i++) if (utf8[i] === REPLACEMENT_CHAR) count++;
  const ratio = utf8.length > 0 ? count / utf8.length : 0;
  if (count < MOJIBAKE_MIN_COUNT || ratio < MOJIBAKE_THRESHOLD) return utf8;
  try { return iconv.decode(buf, "cp950"); } catch { return utf8; }
}

// ── Test 1: 純 UTF-8 → 不觸發 fallback ──────────────────────────────────

console.log("\n═══ Test 1: 純 UTF-8 中文 buffer ═══");
{
  const text = "工具鏈 git 設定完成";
  const buf = Buffer.from(text, "utf8");
  const out = decodeWindowsStdout(buf);
  assertEq(out, text, "UTF-8 中文正確 round-trip");
}

// ── Test 2: CP950 中文 → fallback 解 ────────────────────────────────────

console.log("\n═══ Test 2: CP950 中文 buffer（模擬 Windows cmd 錯誤訊息）═══");
{
  // 用 iconv-lite encode 成 CP950，模擬 Windows cmd 印的中文
  const original = "系統找不到指定的路徑";
  const buf = iconv.encode(original, "cp950");

  // 直接 UTF-8 decode 應該變亂碼（U+FFFD 多）
  const utf8Garbage = buf.toString("utf8");
  let fffdCount = 0;
  for (let i = 0; i < utf8Garbage.length; i++) if (utf8Garbage[i] === REPLACEMENT_CHAR) fffdCount++;
  assert(fffdCount > 0, `UTF-8 decode CP950 buffer 含 U+FFFD (${fffdCount} 個)`);

  // 走 decodeWindowsStdout 應該偵測到 mojibake 並 fallback CP950
  const decoded = decodeWindowsStdout(buf);
  assertEq(decoded, original, "fallback CP950 decode 正確還原");
}

// ── Test 3: 純 ASCII → 不觸發 fallback ──────────────────────────────────

console.log("\n═══ Test 3: 純 ASCII buffer ═══");
{
  const text = "exitCode: 0\nls -la\nrun_command output";
  const buf = Buffer.from(text, "utf8");
  const out = decodeWindowsStdout(buf);
  assertEq(out, text, "純 ASCII 不觸發 fallback");
}

// ── Test 4: 環境變數強制指定 ──────────────────────────────────────────

console.log("\n═══ Test 4: CATCLAW_FORCE_DECODE override ═══");
{
  const original = "繁體中文測試";
  const cp950Buf = iconv.encode(original, "cp950");

  process.env["CATCLAW_FORCE_DECODE"] = "cp950";
  const out = decodeWindowsStdout(cp950Buf);
  delete process.env["CATCLAW_FORCE_DECODE"];

  assertEq(out, original, "FORCE_DECODE=cp950 強制走 CP950");
}

// ── Test 5: 空 buffer ───────────────────────────────────────────────────

console.log("\n═══ Test 5: 空 buffer ═══");
{
  const out = decodeWindowsStdout(Buffer.alloc(0));
  assertEq(out, "", "空 buffer → 空字串");
}

// ── Test 6: 混合場景 — 部分 UTF-8 + 部分 CP950 ─────────────────────────

console.log("\n═══ Test 6: 邊界 — 少量 U+FFFD（< 3% 閾值）不觸發 fallback ═══");
{
  // 故意製造少量亂碼 byte（小於 3% threshold），不該觸發 fallback
  const utf8Text = "正常的中文輸出能正確顯示而不被誤判為亂碼";
  const utf8Buf = Buffer.from(utf8Text, "utf8");
  // 附加 1 個 high-bit byte 製造 1 個 U+FFFD
  const buf = Buffer.concat([utf8Buf, Buffer.from([0xFF])]);
  const out = decodeWindowsStdout(buf);
  // 應仍走 UTF-8（FFFD count / total < 3%）
  assert(out.startsWith(utf8Text), "少量亂碼 byte 不觸發 fallback，UTF-8 主體保留");
}

console.log(`\n═══ 結果：${passed} passed, ${failed} failed ═══`);
process.exit(failed > 0 ? 1 : 0);
