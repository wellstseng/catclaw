/**
 * /add-bridge skill — parseArgs 單元測試
 *
 * 用法：npm run build && node test/add-bridge-smoke.mjs
 *
 * 測試範圍：
 *   - key=value 解析（string / 布林 / 數字）
 *   - alias（channelId / workingDir / botToken / showThinking / editIntervalMs / keepAliveIntervalMs）
 *   - 引號包覆路徑（含空白）
 *   - 未知 key 忽略
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 需要 CATCLAW_CONFIG_DIR 才能 import（config.js 載入時會呼叫）
const tmpDir = mkdtempSync(join(tmpdir(), "catclaw-addbridge-"));
writeFileSync(
  join(tmpDir, "catclaw.json"),
  JSON.stringify({ discord: { token: "dummy-token-for-test" } }),
);
process.env.CATCLAW_CONFIG_DIR = tmpDir;
process.env.CATCLAW_WORKSPACE = tmpDir;
process.env.CATCLAW_CLAUDE_BIN = "claude";

const { parseArgs } = await import("../dist/skills/builtin/add-bridge.js");

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; console.error(`  ❌ ${msg}`); }
}

function section(name) { console.log(`\n── ${name} ──`); }

section("基本 key=value");
{
  const r = parseArgs("label=foo channel=123 cwd=/tmp/x");
  assert(r.label === "foo", "label 解析");
  assert(r.channel === "123", "channel 解析");
  assert(r.cwd === "/tmp/x", "cwd 解析");
}

section("alias 接受");
{
  const r = parseArgs("label=foo channelId=999 workingDir=/abs botToken=secret");
  assert(r.channel === "999", "channelId → channel");
  assert(r.cwd === "/abs", "workingDir → cwd");
  assert(r.token === "secret", "botToken → token");
}

section("布林欄位");
{
  const a = parseArgs("label=f channel=1 cwd=/x skipPerms=true thinking=true");
  assert(a.skipPerms === true, "skipPerms=true");
  assert(a.thinking === true, "thinking=true");

  const b = parseArgs("label=f channel=1 cwd=/x skipPerms=false thinking=0");
  assert(b.skipPerms === false, "skipPerms=false");
  assert(b.thinking === false, "thinking=0");
}

section("數字欄位");
{
  const r = parseArgs("label=f channel=1 cwd=/x editInterval=1200 keepAlive=30000");
  assert(r.editInterval === 1200, "editInterval=1200");
  assert(r.keepAlive === 30000, "keepAlive=30000");
}

section("引號包覆含空白的路徑");
{
  const r = parseArgs('label=f channel=1 cwd="/Users/wells/my project" token=abc');
  assert(r.cwd === "/Users/wells/my project", "雙引號路徑");
  assert(r.token === "abc", "token 正確");
}

section("未知 key 忽略");
{
  const r = parseArgs("label=f channel=1 cwd=/x unknown=foo bogus=bar");
  assert(r.label === "f" && r.channel === "1" && r.cwd === "/x", "已知欄位正確");
  assert(!("unknown" in r) && !("bogus" in r), "未知欄位未進入 output");
}

section("空字串");
{
  const r = parseArgs("");
  assert(r.label === undefined && r.channel === undefined && r.cwd === undefined, "空字串 → 全部 undefined");
}

console.log(`\n─────────── ${passed} passed, ${failed} failed ───────────`);
process.exit(failed > 0 ? 1 : 0);
