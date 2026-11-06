/**
 * agent-loop 記憶區塊不重複注入 smoke test
 *
 * 背景：session 開場凍結的記憶區塊，message-pipeline 已組進 systemPrompt，agent-loop 3b 又前置一份 →
 * 每回合同一塊記憶送兩次（2026-10 trace：frozen-snapshot 回合 12/12 都重複）。
 *
 * 測試項目（mock provider 擷取實際送給模型的 systemPrompt）：
 *   1. 呼叫端 systemPrompt 已含 <memory-context> → agent-loop 不再前置凍結區塊，整份只出現一次
 *   2. 呼叫端沒帶記憶（子 agent、cron 直呼）→ agent-loop 照常前置凍結區塊
 *   3. trace 的 memoryRecall 記下凍結區塊實際放了哪些卡（不再是空陣列）
 *
 * 用法：node tests/memory-inject-dedup-smoke.mjs   （先 tsc 編到 dist/）
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tmpRoot = join(tmpdir(), `catclaw-dedup-${process.pid}-${Date.now()}`);
mkdirSync(join(tmpRoot, "workspace"), { recursive: true });
writeFileSync(join(tmpRoot, "catclaw.json"), "{}\n", "utf-8");   // 全吃預設值；不碰 ~/.catclaw
process.env.CATCLAW_CONFIG_DIR = tmpRoot;
process.env.CATCLAW_WORKSPACE = join(tmpRoot, "workspace");
process.on("exit", () => { try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {} });

let passed = 0;
let failed = 0;
function assert(cond, name) {
  if (cond) { console.log(`  ✓ ${name}`); passed++; }
  else { console.error(`  ✗ ${name}`); failed++; }
}
const count = (s, sub) => s.split(sub).length - 1;

const { AccountRegistry } = await import("../dist/accounts/registry.js");
const { PermissionGate } = await import("../dist/accounts/permission-gate.js");
const { ToolRegistry } = await import("../dist/tools/registry.js");
const { SafetyGuard } = await import("../dist/safety/guard.js");
const { SessionManager } = await import("../dist/core/session.js");
const { eventBus } = await import("../dist/core/event-bus.js");
const { agentLoop } = await import("../dist/core/agent-loop.js");
const { getFrozenMaterials, setFrozenMaterials } = await import("../dist/core/session-snapshot.js");
const { MessageTrace } = await import("../dist/core/message-trace.js");

const accReg = new AccountRegistry(tmpRoot);
accReg.init();
accReg.create({ accountId: "owner-a", displayName: "Owner", role: "platform-owner" });
const toolReg = new ToolRegistry();
const sessionMgr = new SessionManager({ ttlHours: 1, maxHistoryTurns: 10, compactAfterTurns: 50, persistPath: join(tmpRoot, "sessions") });
await sessionMgr.init();
const deps = { sessionManager: sessionMgr, permissionGate: new PermissionGate(accReg, toolReg), toolRegistry: toolReg, safetyGuard: new SafetyGuard(), eventBus };

const seen = [];
const captureProvider = {
  id: "capture", name: "Capture", supportsToolUse: true, maxContextTokens: 200000,
  async stream(_messages, opts) {
    seen.push(opts?.systemPrompt ?? "");
    const text = "ok";
    async function* events() {
      yield { type: "text_delta", text };
      yield { type: "done", stopReason: "end_turn", text };
    }
    return { events: events(), stopReason: "end_turn", toolCalls: [], text, usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, estimated: false } };
  },
};

const sessionKey = "test:ch:dedup";
async function runTurn(prompt, systemPrompt, trace) {
  const events = [];
  for await (const ev of agentLoop(prompt, {
    channelId: "dedup", accountId: "owner-a", provider: captureProvider,
    systemPrompt, _sessionKeyOverride: sessionKey, trace,
  }, deps)) events.push(ev);
  return events;
}

// 第一回合：建立 session 與凍結材料（測試環境沒有記憶引擎 → 記憶區塊空）
const first = await runTurn("hello", "BASE");
assert(first.some(e => e.type === "done"), "第一回合正常結束（mock provider 帶 usage）");
const frozen = getFrozenMaterials(sessionKey);
assert(frozen !== null, "第一回合建立凍結材料");

// 塞入一份凍結記憶，模擬 session 開場撈到兩張卡
const FROZEN_BLOCK = "<memory-context>\n[系統提示] 以下為 memory 層檢索結果\n\nFROZEN-ATOM-TEXT\n</memory-context>";
setFrozenMaterials(sessionKey, { ...frozen, memoryContextBlock: FROZEN_BLOCK, memoryAtoms: [{ name: "atom-a", path: "/x/atom-a.md" }, { name: "atom-b", path: "/x/atom-b.md" }] });

console.log("\n[1] 呼叫端已注入記憶");
seen.length = 0;
await runTurn("第二句", "<memory-context>\nFROM-PIPELINE\n</memory-context>\n\nBASE");
const sp1 = seen[0] ?? "";
assert(count(sp1, "<memory-context>") === 1, `記憶區塊只出現一次（實際 ${count(sp1, "<memory-context>")} 次）`);
assert(sp1.includes("FROM-PIPELINE") && !sp1.includes("FROZEN-ATOM-TEXT"), "保留呼叫端那份、不再前置凍結區塊");

console.log("\n[2] 呼叫端沒帶記憶");
seen.length = 0;
const trace = MessageTrace.create(`dedup-${Date.now()}`, "dedup", "owner-a");
trace.recordContextStart();   // 正式流程由 message-pipeline 開 context 段
await runTurn("第三句", "BASE", trace);
const sp2 = seen[0] ?? "";
assert(count(sp2, "FROZEN-ATOM-TEXT") === 1, "前置凍結區塊一次");
assert(sp2.indexOf("FROZEN-ATOM-TEXT") < sp2.indexOf("BASE"), "凍結區塊在呼叫端 systemPrompt 之前");

console.log("\n[3] trace 記下凍結區塊的卡");
const recall = trace.entry?.context?.memoryRecall;   // entry 是 TS private，執行期可讀
assert(recall?.source === "frozen-snapshot", `trace 來源 frozen-snapshot（${recall?.source}）`);
assert(JSON.stringify(recall?.atomNames) === JSON.stringify(["atom-a", "atom-b"]), `trace atomNames（${JSON.stringify(recall?.atomNames)}）`);

console.log("\n[4] memoryInjectedByCaller 旗標＋效用帳登記（用 agentLoop 實際的 sessionKey）");
{
  const { initUsefulnessTracker } = await import("../dist/memory/usefulness.js");
  const { readFileSync, existsSync } = await import("node:fs");
  const wfDir = join(tmpRoot, "wf");
  initUsefulnessTracker(eventBus, wfDir, (key) => getFrozenMaterials(key)?.memoryAtoms ?? []);
  const ledgerPath = join(wfDir, "memory-usefulness.ndjson");
  function turnLines() {
    if (!existsSync(ledgerPath)) return [];
    const lines = readFileSync(ledgerPath, "utf-8").trim().split("\n").map(line => JSON.parse(line));
    return lines.filter(l => l.kind === "turn");
  }

  seen.length = 0;
  for await (const _ of agentLoop("第四句", {
    channelId: "dedup", accountId: "owner-a", provider: captureProvider, systemPrompt: "BASE-NO-FENCE",
    _sessionKeyOverride: sessionKey, memoryInjectedByCaller: { atoms: [{ name: "caller-atom", path: "/x/caller-atom.md" }] },
  }, deps)) { /* drain */ }
  assert(!(seen[0] ?? "").includes("FROZEN-ATOM-TEXT"), "帶旗標（即使 systemPrompt 沒有記憶標記）→ 不前置凍結區塊");
  assert(JSON.stringify(turnLines().at(-1)?.candidates) === JSON.stringify(["caller-atom"]),
    `效用帳只記呼叫端那份名單（${JSON.stringify(turnLines().at(-1)?.candidates)}）`);

  await runTurn("第五句", "BASE");
  assert(JSON.stringify(turnLines().at(-1)?.candidates) === JSON.stringify(["atom-a", "atom-b"]),
    `沒帶旗標、用凍結區塊 → 效用帳記凍結的卡（${JSON.stringify(turnLines().at(-1)?.candidates)}）`);

  const before = turnLines().length;
  await runTurn("第六句", "<memory-context>\nX\n</memory-context>");
  assert(turnLines().length === before, "只有記憶標記、沒帶名單 → 不知道送了哪些卡，這回合不記（不會誤記凍結卡）");
}

console.log(`\n${failed === 0 ? "✅" : "❌"} ${passed} 通過 / ${failed} 失敗`);
console.log(failed === 0 ? "MEMORY_INJECT_DEDUP_CHECK PASS" : "MEMORY_INJECT_DEDUP_CHECK FAIL");
process.exit(failed === 0 ? 0 : 1);
