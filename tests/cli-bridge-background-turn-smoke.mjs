/**
 * cli-bridge 背景回合（CLI 自發 turn）smoke test
 *
 * CLI 在 stream-json 模式下，背景 Bash 完成時會自己開新回合（task-notification），
 * 這時沒有 activeTurnId。驗證 bridge 會補開 source=background 的 turn、把最終文字送到綁定頻道、
 * 寫進 turns.jsonl，而且 Discord 插話、control_request、頻道提示都照規矩走。
 *
 * 用法：npm run build && node tests/cli-bridge-background-turn-smoke.mjs
 *      （要測別處編出來的 dist：CATCLAW_DIST=<dist 目錄> node tests/...）
 */

import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const tmpDir = mkdtempSync(join(tmpdir(), "catclaw-bgturn-"));
writeFileSync(join(tmpDir, "catclaw.json"), JSON.stringify({ discord: { token: "dummy-token-for-test" } }));
process.env.CATCLAW_CONFIG_DIR = tmpDir;
process.env.CATCLAW_WORKSPACE = tmpDir;
process.env.CATCLAW_CLAUDE_BIN = "claude";

const distUrl = process.env.CATCLAW_DIST
  ? pathToFileURL(process.env.CATCLAW_DIST.replace(/[\\/]?$/, "/")).href
  : new URL("../dist/", import.meta.url).href;

const { setLogLevel } = await import(`${distUrl}logger.js`);
setLogLevel("warn");
const { CliBridge } = await import(`${distUrl}cli-bridge/bridge.js`);
const { handleCliBridgeReply } = await import(`${distUrl}cli-bridge/reply.js`);

let passed = 0, failed = 0;
function assert(cond, msg) { if (cond) { passed++; console.log(`  ✅ ${msg}`); } else { failed++; console.error(`  ❌ ${msg}`); } }
function section(name) { console.log(`\n── ${name} ──`); }
async function waitFor(pred, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; await new Promise(r => setTimeout(r, 20)); }
  return pred();
}

// ── stubs ──────────────────────────────────────────────────────────────────

class FakeProcess extends EventEmitter {
  alive = true;
  lastStderr = "";
  stdin = [];
  controlResponses = [];
  sendUserMessage(text) { this.stdin.push(text); }
  sendControlResponse(requestId, decision) { this.controlResponses.push({ requestId, decision }); }
  sendInterrupt() {}
  ping() { return true; }
  async shutdown() { this.alive = false; }
}

function makeSender() {
  const calls = [];
  let seq = 0;
  const newMsg = () => ({ id: `msg-${++seq}` });
  return {
    calls,
    mode: "main-bot",
    async init() {},
    async reply(original, content) { calls.push({ kind: "reply", to: original.id, content }); return newMsg(); },
    async send(content) { calls.push({ kind: "send", content }); return newMsg(); },
    async edit(message, content) { calls.push({ kind: "edit", id: message.id, content }); },
    async sendComponents() { return newMsg(); },
    async editComponents() {},
    sendTyping() {},
    onMessage() {},
    stopReceiving() {},
    getBotUserId() { return null; },
    withChannel() { return this; },
    async destroy() {},
  };
}

function makeBridge(label, extraConfig = {}) {
  const bridgeConfig = {
    enabled: true, label, workingDir: tmpDir, logDir: join(tmpDir, "logs"),
    channels: {}, turnTimeoutMs: 0, ...extraConfig,
  };
  const bridge = new CliBridge(label, "CH-HOME", bridgeConfig, { label });
  const proc = new FakeProcess();
  const sender = makeSender();
  bridge.process = proc;       // 跳過 spawn，直接餵事件
  bridge._status = "idle";
  bridge.setSender(sender);
  const emit = (evt) => bridge.handleEvent(evt);
  const turnsPath = join(tmpDir, "logs", label, "turns.jsonl");
  const readTurns = () => existsSync(turnsPath)
    ? readFileSync(turnsPath, "utf-8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l))
    : [];
  return { bridge, proc, sender, emit, readTurns, bridgeConfig };
}

const fakeDiscordMessage = {
  id: "orig-1", channelId: "CH-HOME", createdTimestamp: Date.now(),
  author: { displayName: "Wells", username: "wells" },
  async react() {}, reactions: { cache: { get: () => undefined } },
};

// ── Test 1：背景回合 → 頻道收到最終文字 + turns.jsonl 多一筆 background ─────

section("背景回合：session_init 不開 turn，第一個內容事件才開");
{
  const { bridge, sender, emit, readTurns } = makeBridge("bg-basic");
  emit({ type: "session_init", sessionId: "sid-1" });
  assert(bridge.activeTurnId === null, "session_init 後仍無 activeTurnId");
  assert(bridge.status === "idle", "session_init 後 status 仍 idle");

  emit({ type: "text_delta", text: "驗收 OK。" });
  const bgTurnId = bridge.activeTurnId;
  assert(typeof bgTurnId === "string", "第一個 text_delta 開出 background turn");
  assert(bridge.status === "busy", "背景回合期間 status=busy");

  emit({ type: "tool_call", title: "Bash" });
  emit({ type: "tool_result", title: "Bash", duration_ms: 12 });
  emit({ type: "text_delta", text: "包好了，" });
  emit({ type: "text_delta", text: "已上版 r5640" });
  emit({ type: "result", is_error: false, text: "包好了，已上版 r5640", session_id: "sid-1" });

  assert(bridge.activeTurnId === null, "result 後 activeTurnId 清空");
  assert(bridge.status === "idle", "result 後 status 回 idle");

  const delivered = await waitFor(() => sender.calls.length > 0);
  assert(delivered, "result 後頻道有收到訊息");
  assert(sender.calls[0]?.kind === "send" && sender.calls[0]?.content === "包好了，已上版 r5640",
    `只送最後一個 tool_call 之後的文字（got ${JSON.stringify(sender.calls[0])}）`);
  assert(sender.calls.length === 1, "最終文字只送一則");

  const turns = readTurns();
  const rec = turns.find(t => t.turnId === bgTurnId);
  assert(!!rec, "turns.jsonl 多一筆該 turn");
  assert(rec?.source === "background", `source=background（got ${rec?.source}）`);
  assert(rec?.assistantReply === "驗收 OK。包好了，已上版 r5640", "assistantReply 含整回合文字");
  assert(rec?.toolCalls?.length === 1 && rec.toolCalls[0].name === "Bash" && rec.toolCalls[0].durationMs === 12, "toolCalls 有累積");
  await waitFor(() => bridge.getTurnHistory(5).find(t => t.turnId === bgTurnId)?.discordDelivery === "success");
  assert(bridge.getTurnHistory(5).find(t => t.turnId === bgTurnId)?.discordDelivery === "success", "記憶體內 delivery 更新為 success");
}

// ── Test 2：背景回合的 control_request 直接 deny ───────────────────────────

section("背景回合：control_request 自動拒絕");
{
  const { proc, sender, emit } = makeBridge("bg-control");
  emit({ type: "text_delta", text: "要改檔" });
  emit({ type: "control_request", requestId: "req-1", tool: "Edit", input: {}, description: "edit" });
  const resp = proc.controlResponses[0];
  assert(resp?.requestId === "req-1" && resp.decision.behavior === "deny", "control_request 被 deny");
  assert(/background/.test(resp?.decision.message ?? ""), "deny 訊息標明來源 background");
  emit({ type: "result", is_error: false, text: "" });
  await waitFor(() => sender.calls.length > 0);
  assert(sender.calls[0]?.content === "要改檔", "deny 後 result 仍把累積文字送出");
}

// ── Test 3：背景回合期間 Discord 插話 → 背景已累積文字先送、新 turn 接手 ────

section("背景回合期間 Discord 插話");
{
  const { bridge, proc, sender, emit, readTurns } = makeBridge("bg-interject");
  emit({ type: "text_delta", text: "背景進度一半" });
  const bgTurnId = bridge.activeTurnId;

  const handle = bridge.send("使用者插話", "discord", { user: "wells" });
  assert(bridge.activeTurnId === handle.turnId && handle.turnId !== bgTurnId, "activeTurnId 換成 Discord turn");
  assert(proc.stdin.length === 1 && proc.stdin[0].includes("使用者插話"), "插話文字有送進 stdin");

  const bgFlushed = await waitFor(() => sender.calls.some(c => c.content === "背景進度一半"));
  assert(bgFlushed, "背景已累積文字在插話時送出");
  const bgRec = readTurns().find(t => t.turnId === bgTurnId);
  assert(bgRec?.source === "background" && bgRec?.assistantReply === "背景進度一半", "背景 turn 記進 turns.jsonl");

  emit({ type: "text_delta", text: "回覆插話" });
  emit({ type: "result", is_error: false, text: "回覆插話" });
  const events = [];
  for await (const evt of handle.events) events.push(evt);
  assert(events.some(e => e.type === "text_delta" && e.text === "回覆插話") && events.at(-1)?.type === "result",
    "Discord turn 的 listener 收到後續事件");
  const dcRec = readTurns().find(t => t.turnId === handle.turnId);
  assert(dcRec?.source === "discord" && dcRec?.assistantReply === "回覆插話", "Discord turn 紀錄不混到背景文字");
  assert(sender.calls.length === 1, "bridge 端沒替 Discord turn 多送訊息（由 reply handler 負責）");
}

// ── Test 4：背景回覆接在綁定頻道最後處理的訊息下 ──────────────────────────

section("背景回覆 reply 到最後處理的頻道訊息");
{
  const { bridge, sender, emit, bridgeConfig } = makeBridge("bg-anchor");
  const replying = handleCliBridgeReply(bridge, "請跑背景", fakeDiscordMessage, { showToolCalls: "none" }, bridgeConfig);
  await waitFor(() => bridge.activeTurnId !== null);
  emit({ type: "text_delta", text: "背景開跑" });
  emit({ type: "result", is_error: false, text: "背景開跑" });
  await replying;
  assert(sender.calls.some(c => c.kind === "reply" && c.to === "orig-1"), "Discord turn 本身是 reply 原訊息");

  sender.calls.length = 0;
  emit({ type: "text_delta", text: "背景完成" });
  emit({ type: "result", is_error: false, text: "背景完成" });
  await waitFor(() => sender.calls.length > 0);
  assert(sender.calls[0]?.kind === "reply" && sender.calls[0]?.to === "orig-1" && sender.calls[0]?.content === "背景完成",
    `背景最終文字 reply 到 orig-1（got ${JSON.stringify(sender.calls[0])}）`);
}

// ── Test 5：頻道提示依 botToken 有無決定要不要提 bridge-discord 工具 ────────

section("頻道提示：無 botToken 不提 mcp__catclaw-bridge-discord");
{
  const noToken = makeBridge("hint-no-token");
  noToken.bridge.send("hi", "discord", { user: "u" });
  const text = noToken.proc.stdin[0] ?? "";
  assert(!text.includes("mcp__catclaw-bridge-discord"), "無 botToken：提示不含該工具名");
  assert(text.includes("stdout"), "無 botToken：仍提示用 stdout 回覆");

  const withToken = makeBridge("hint-token", { botToken: "dummy" });
  withToken.bridge.send("hi", "discord", { user: "u" });
  assert((withToken.proc.stdin[0] ?? "").includes("mcp__catclaw-bridge-discord__*"), "有 botToken：提示含該工具名");
}

// ── 結果 ───────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
console.log(failed === 0 ? "CLI_BRIDGE_BG_TURN_CHECK PASS" : "CLI_BRIDGE_BG_TURN_CHECK FAIL");
process.exit(failed === 0 ? 0 : 1);
