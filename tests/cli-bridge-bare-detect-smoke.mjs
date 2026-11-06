/**
 * CLI bridge 精簡模式（--bare）偵測 smoke test
 *
 * init 範本取自 2026-11-06 實跑 claude 2.1.318 `-p --output-format stream-json --verbose`：
 *   正常：tools 40、mcp_servers 2、skills 85；CLAUDE_CODE_SIMPLE=1（等同 --bare）：tools 只剩 Bash／Edit／Read、mcp 0、skills 19；
 *   `--bare` 加 `--mcp-config`（bridge 有 botToken 時就會帶）：Bash／Edit／Read＋9 個 mcp__*，MCP 照樣載入
 *
 * 測試項目：
 *   1. detectBareInit：正常／精簡／隔離模式（工具照常）／沒有 tools 欄位
 *   2. ClaudeProvider 收到 init：精簡 → health CRITICAL 並發一次 health:critical；同 bridge 再來一次不重發；
 *      之後正常 init → 標恢復並發 health:recovered；session_init 照常 emit
 *
 * 用法：node tests/cli-bridge-bare-detect-smoke.mjs   （先 tsc 編到 dist/）
 */

import { detectBareInit, ClaudeProvider } from "../dist/cli-bridge/providers/claude.js";
import { getHealth, _resetForTest } from "../dist/core/health-monitor.js";
import { eventBus } from "../dist/core/event-bus.js";

let passed = 0;
let failed = 0;
function assert(cond, name) {
  if (cond) { console.log(`  ✓ ${name}`); passed++; }
  else { console.error(`  ✗ ${name}`); failed++; }
}
function assertEq(a, b, name) {
  assert(JSON.stringify(a) === JSON.stringify(b), `${name} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`);
}

const NORMAL_TOOLS = ["Task", "Artifact", "ArtifactComments", "ArtifactData", "AskUserQuestion", "Bash", "CronCreate", "CronDelete",
  "CronList", "Edit", "EnterPlanMode", "EnterWorktree", "ExitPlanMode", "ExitWorktree", "Glob", "Grep", "ListAgents", "Monitor",
  "NotebookEdit", "PushNotification", "Read", "ReadNotifications", "RemoteTrigger", "ScheduleWakeup", "SendMessage", "Skill",
  "TaskCreate", "TaskGet", "TaskList", "TaskOutput", "TaskStop", "TaskUpdate", "TodoWrite", "ToolSearch", "WebFetch", "WebSearch",
  "Workflow", "Write", "mcp__workflow-guardian__memory_search", "mcp__plugin_discord_discord__reply"];
const normalInit = {
  type: "system", subtype: "init", session_id: "8d4feb87", tools: NORMAL_TOOLS,
  mcp_servers: [{ name: "plugin:discord:discord", status: "connected" }, { name: "workflow-guardian", status: "connected" }],
  skills: new Array(85).fill("s"), claude_code_version: "2.1.318",
};
const bareInit = {
  type: "system", subtype: "init", session_id: "68a6d2cb", tools: ["Bash", "Edit", "Read"],
  mcp_servers: [], skills: new Array(19).fill("s"), claude_code_version: "2.1.318",
};
const bareWithMcpInit = {
  type: "system", subtype: "init", session_id: "b4re-mcp",
  tools: ["Bash", "Edit", "Read", "mcp__workflow-guardian__anti_evasion_report", "mcp__workflow-guardian__atom_edit_meta",
    "mcp__workflow-guardian__atom_move", "mcp__workflow-guardian__atom_promote", "mcp__workflow-guardian__atom_retire",
    "mcp__workflow-guardian__atom_source", "mcp__workflow-guardian__atom_write", "mcp__workflow-guardian__knowledge_harvest_report",
    "mcp__workflow-guardian__memory_search"],
  mcp_servers: [{ name: "workflow-guardian", status: "connected" }], skills: new Array(19).fill("s"), claude_code_version: "2.1.318",
};
const isolationInit = { ...normalInit, tools: NORMAL_TOOLS.filter(t => !["Bash", "WebFetch", "Write"].includes(t)), mcp_servers: [] };

console.log("\n[1] detectBareInit");
assertEq(detectBareInit(normalInit).bare, false, "正常載入 → 不是精簡模式");
assertEq(detectBareInit(bareInit).bare, true, "工具只剩 Bash／Edit／Read → 精簡模式");
assert(detectBareInit(bareInit).detail.includes("內建工具=3") && detectBareInit(bareInit).detail.includes("mcp=0"), "detail 帶工具與 MCP 數");
assertEq(detectBareInit(bareWithMcpInit).bare, true, "精簡模式＋--mcp-config（內建 3 個＋9 個 mcp__*）→ 仍判精簡模式");
assertEq(detectBareInit({ ...normalInit, tools: [...NORMAL_TOOLS, "mcp__x__y"] }).bare, false, "正常載入＋MCP 工具 → 不是精簡模式");
assertEq(detectBareInit(isolationInit).bare, false, "隔離模式（關掉幾個工具、沒 MCP）→ 不誤判");
assertEq(detectBareInit({ type: "system", subtype: "init" }).bare, false, "沒有 tools 欄位 → 不判");
assertEq(detectBareInit({ ...bareInit, tools: ["Read"] }).bare, true, "只剩 Read 也算");
assertEq(detectBareInit({ ...bareInit, tools: ["Bash", "Edit", "Read", "Grep"] }).bare, false, "多一個 Grep → 不是精簡模式");

console.log("\n[2] ClaudeProvider init 處理");
_resetForTest();
const criticals = [];
const recovered = [];
eventBus.on("health:critical", (name, error) => criticals.push({ name, error }));
eventBus.on("health:recovered", (name) => recovered.push(name));
const provider = new ClaudeProvider();
const emitted = [];
const ctx = { emit: (evt) => emitted.push(evt) };
provider.parseStdoutLine(bareInit, ctx);
assertEq(emitted[0], { type: "session_init", sessionId: "68a6d2cb" }, "精簡模式照常 emit session_init");
assertEq(getHealth("cli-bridge:claude:full-load")?.status, "unhealthy", "精簡模式 → component unhealthy");
assertEq(criticals.length, 1, "發一次 health:critical（index.ts 會轉發 Discord）");
assert(criticals[0]?.error.includes("精簡模式") && criticals[0]?.error.includes("內建工具=3"), "通報內容說明原因與數字");
provider.parseStdoutLine(bareInit, ctx);
assertEq(criticals.length, 1, "同 bridge 1 小時內再來一次 → 不重發");
provider.parseStdoutLine(normalInit, ctx);
assertEq(getHealth("cli-bridge:claude:full-load")?.status, "healthy", "正常 init → 恢復 healthy");
assertEq(recovered, ["cli-bridge:claude:full-load"], "發 health:recovered");

console.log(`\n${failed === 0 ? "✅" : "❌"} ${passed} 通過 / ${failed} 失敗`);
console.log(failed === 0 ? "BARE_DETECT_CHECK PASS" : "BARE_DETECT_CHECK FAIL");
process.exit(failed === 0 ? 0 : 1);
