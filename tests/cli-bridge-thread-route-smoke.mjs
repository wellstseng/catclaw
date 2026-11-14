/**
 * 主 bot 路徑的 CLI bridge 路由 smoke test（discord.ts handleMessage 端到端；假 Discord 物件、不連線、不 spawn CLI）
 *
 * 驗：
 *  1. 新討論串、父頻道有主 bot 模式 bridge → 建 bridge（持久化到 cli-bridges.json）並走這條
 *  2. 父頻道沒 bridge／父 bridge 要 @ 但沒 @／沒過主 bot 的 allowFrom → 不建
 *  3. 有 bridge 的頻道（含自動建的討論串）打「重啟」「更新 xxx」→ 不觸發 CatClaw skill，原樣送進 CLI
 *  4. 沒 bridge 的頻道打「重啟」→ 照舊觸發 skill
 *  5. 主 bot 模式 bridge 頻道打「開新對話」→ 清 sessionId 重建，不送進 CLI
 *  6. 討論串的 sessionId 寫回自己那條；hot-reload 不重建；重啟（shutdownAll → startAll）後照常重建
 *
 * 用法：npm run build && node tests/cli-bridge-thread-route-smoke.mjs
 *      （要測別處編出來的 dist：CATCLAW_DIST=<dist 目錄> node tests/...）
 */

import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

// ── ID（Discord 風格純數字，mention 正規式只認數字） ─────────────────────────
const MAIN_BOT = "900000000000000001";
const WELLS = "100000000000000001";
const STRANGER = "100000000000000002";
const GUILD = "500000000000000001";
const CH_BRIDGED = "200000000000000001";  // 有主 bot 模式 bridge（requireMention=false）
const CH_MENTION = "200000000000000002";  // 有主 bot 模式 bridge（requireMention=true）
const CH_PLAIN = "200000000000000003";    // catclaw.json 放行、沒 bridge
const CH_SECOND = "200000000000000004";   // 有 bridge、有 sessionId（測開新對話）
const T1 = "300000000000000001", T2 = "300000000000000002", T3 = "300000000000000003";
const T4 = "300000000000000004", T5 = "300000000000000005";

const tmpDir = mkdtempSync(join(tmpdir(), "catclaw-thread-route-"));
const workDir = join(tmpDir, "wendy-wd");
mkdirSync(workDir, { recursive: true });
writeFileSync(join(tmpDir, "catclaw.json"), JSON.stringify({
  discord: {
    token: "dummy-token-for-test",
    guilds: {
      [GUILD]: {
        allow: false, requireMention: true, allowFrom: [WELLS],
        channels: {
          [CH_BRIDGED]: { allow: true, requireMention: false },
          [CH_MENTION]: { allow: true, requireMention: false },
          [CH_PLAIN]: { allow: true, requireMention: false },
          [CH_SECOND]: { allow: true, requireMention: false },
        },
      },
    },
  },
  admin: { allowedUserIds: [WELLS] },
  debounceMs: 20,
  safety: { skillSelfReflectEnabled: false },
}));
const bridgesPath = join(tmpDir, "cli-bridges.json");
writeFileSync(bridgesPath, JSON.stringify([{
  enabled: true, label: "wendy", provider: "claude", claudeBin: "claude",
  workingDir: workDir, logDir: join(tmpDir, "logs"),
  keepAliveIntervalMs: 0, turnTimeoutMs: 0, idleSuspendMs: 14_400_000, shutdownDrainTimeoutMs: 0,
  showIntermediateText: "normal",
  channels: {
    [CH_BRIDGED]: { label: "wendy-main", requireMention: false, dangerouslySkipPermissions: false, sessionId: "sid-parent" },
    [CH_MENTION]: { label: "wendy-mention", requireMention: true, dangerouslySkipPermissions: false },
    [CH_SECOND]: { label: "wendy-second", requireMention: false, dangerouslySkipPermissions: false, sessionId: "sid-second" },
  },
}], null, 2));
process.env.CATCLAW_CONFIG_DIR = tmpDir;
process.env.CATCLAW_WORKSPACE = tmpDir;
process.env.CATCLAW_SKILL_SELF_REFLECT = "false";

const distUrl = process.env.CATCLAW_DIST
  ? pathToFileURL(process.env.CATCLAW_DIST.replace(/[\\/]?$/, "/")).href
  : new URL("../dist/", import.meta.url).href;

const { setLogLevel } = await import(`${distUrl}logger.js`);
setLogLevel("warn");
const { CliBridge } = await import(`${distUrl}cli-bridge/bridge.js`);
const cb = await import(`${distUrl}cli-bridge/index.js`);
const { registerSkill } = await import(`${distUrl}skills/registry.js`);
const { createBot } = await import(`${distUrl}discord.js`);

let passed = 0, failed = 0;
function assert(cond, msg) { if (cond) { passed++; console.log(`  ✅ ${msg}`); } else { failed++; console.error(`  ❌ ${msg}`); } }
function section(name) { console.log(`\n── ${name} ──`); }
async function waitFor(pred, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; await sleep(20); }
  return pred();
}
const readBridges = () => JSON.parse(readFileSync(bridgesPath, "utf-8"));
function entryFor(channelId) {
  for (const entry of readBridges()) if (entry.channels[channelId]) return entry;
  return undefined;
}

// ── stubs ──────────────────────────────────────────────────────────────────

/** 假 CLI process：只收 stdin，不真的 spawn */
class FakeProcess extends EventEmitter {
  alive = true;
  lastStderr = "";
  stdin = [];
  sendUserMessage(text) { this.stdin.push(text); }
  sendControlResponse() {}
  sendInterrupt() {}
  ping() { return true; }
  async shutdown() { this.alive = false; }
}
/** channelId → 這個頻道 spawn 過的假 process（依序） */
const procs = new Map();
CliBridge.prototype.spawnProcess = async function () {
  const proc = new FakeProcess();
  this.process = proc;
  proc.on("event", (evt) => this.handleEvent(evt));
  if (!procs.has(this.channelId)) procs.set(this.channelId, []);
  procs.get(this.channelId).push(proc);
};
function stdinOf(channelId) {
  const lines = [];
  for (const proc of procs.get(channelId) ?? []) lines.push(...proc.stdin);
  return lines.join("\n");
}

/** channelId → 送到該頻道的內容 */
const channelSends = new Map();
let sentSeq = 0;
function sentMessage(channelId, content) {
  return {
    id: `sent-${++sentSeq}`, channelId, content,
    async edit() {}, async react() {}, async delete() {},
    reactions: { cache: { get: () => undefined } },
  };
}
const channels = new Map();
function addChannel(id, parentId = null) {
  const ch = {
    id, name: `ch-${id.slice(-3)}`, parentId,
    type: parentId ? 11 /* PublicThread */ : 0 /* GuildText */,
    isSendable: () => true, isTextBased: () => true, isDMBased: () => false, isThread: () => !!parentId,
    async send(content) {
      if (!channelSends.has(id)) channelSends.set(id, []);
      channelSends.get(id).push(typeof content === "string" ? content : JSON.stringify(content));
      return sentMessage(id, content);
    },
    async sendTyping() {},
  };
  channels.set(id, ch);
  return ch;
}
for (const id of [CH_BRIDGED, CH_MENTION, CH_PLAIN, CH_SECOND]) addChannel(id);
addChannel(T1, CH_BRIDGED); addChannel(T2, CH_BRIDGED); addChannel(T3, CH_PLAIN);
addChannel(T4, CH_BRIDGED); addChannel(T5, CH_MENTION);

const fakeClient = {
  user: { id: MAIN_BOT, tag: "Wendy#0001", username: "Wendy", displayName: "Wendy" },
  channels: { fetch: async (id) => channels.get(id) ?? null },
  users: { fetch: async () => { throw new Error("no users in test"); } },
  isReady: () => true,
};

let msgSeq = 0;
function makeMessage(channelId, content, { authorId = WELLS, mention = false } = {}) {
  const replies = [];
  return {
    id: `in-${++msgSeq}`, channelId, content: mention ? `<@${MAIN_BOT}> ${content}` : content,
    createdTimestamp: Date.now(), editedAt: null,
    channel: channels.get(channelId), guild: { id: GUILD }, client: fakeClient,
    author: { id: authorId, bot: false, tag: `${authorId.slice(-3)}#0001`, displayName: `u${authorId.slice(-3)}`, username: `u${authorId.slice(-3)}` },
    attachments: new Map(),
    mentions: { everyone: false, has: (id) => mention && id === MAIN_BOT, users: { some: () => false } },
    reactions: { cache: { get: () => undefined } },
    async react() {},
    async reply(text) { replies.push(text); return sentMessage(channelId, text); },
    replies,
  };
}

/** 假 skill：觸發詞同 CatClaw 的「重啟」「更新」，只記錄有沒有被叫到 */
const skillCalls = [];
registerSkill({
  name: "restart-probe", description: "test probe", tier: "public", trigger: ["重啟", "更新"],
  async execute(ctx) { skillCalls.push({ channelId: ctx.channelId, args: ctx.args }); return { text: "probe-ran" }; },
});

const bot = createBot(); // discord.js Client，不 login；只拿它的 messageCreate handler
const emit = (msg) => bot.emit("messageCreate", msg);
const SETTLE_MS = 300; // 負向斷言：debounce 20ms + 處理時間

await cb.startAllBridges(fakeClient);

// ── 純函式 ─────────────────────────────────────────────────────────────────

section("threadBridgeConfigFromParent：照抄父條目、換 label、不帶 sessionId");
{
  const parentCfg = readBridges()[0];
  const parentCh = parentCfg.channels[CH_BRIDGED];
  const plan = cb.threadBridgeConfigFromParent(parentCfg, parentCh, "wendy-main", T1);
  assert(plan?.channelConfig.label === `wendy-main-t-${T1}`, `channel label = wendy-main-t-<討論串ID>（got ${plan?.channelConfig.label}）`);
  assert(plan?.cfg.label === plan?.channelConfig.label, "top-level label 也換成同一個（persistSessionId 靠它找條目）");
  assert(JSON.stringify(Object.keys(plan?.cfg.channels ?? {})) === JSON.stringify([T1]), "channels 只留這個討論串");
  assert(plan?.channelConfig.sessionId === undefined, "不帶父頻道 sessionId（獨立一段對話）");
  assert(plan?.cfg.workingDir === workDir && plan?.cfg.idleSuspendMs === 14_400_000, "工作目錄與 CLI 參數沿用父條目");
  assert(parentCh.sessionId === "sid-parent", "父條目物件沒被改到");
  const ment = cb.threadBridgeConfigFromParent(parentCfg, parentCfg.channels[CH_MENTION], "wendy-mention", T5);
  assert(ment?.channelConfig.requireMention === true, "父 bridge requireMention=true → 討論串沿用");
  assert(cb.threadBridgeConfigFromParent({ ...parentCfg, botToken: "x" }, parentCh, "judy", T1) === null, "父條目有 botToken（獨立 bot 模式）→ null，不建");
}

section("bridgeTakesMainBotMessage");
{
  const fake = (sender, requireMention) => ({
    getSender: () => { if (!sender) throw new Error("sender 尚未初始化"); return sender; },
    getChannelConfig: () => ({ label: "x", requireMention }),
  });
  const mainSender = { mode: "main-bot", getBotUserId: () => MAIN_BOT };
  assert(cb.bridgeTakesMainBotMessage(fake(mainSender, false), () => false) === true, "主 bot 模式、不需 @ → 接");
  assert(cb.bridgeTakesMainBotMessage(fake(mainSender, true), () => false) === false, "主 bot 模式、要 @ 沒 @ → 不接");
  assert(cb.bridgeTakesMainBotMessage(fake(mainSender, true), (id) => id === MAIN_BOT) === true, "主 bot 模式、要 @ 有 @ → 接");
  assert(cb.bridgeTakesMainBotMessage(fake({ mode: "independent-bot", getBotUserId: () => "J" }, true), () => false) === true, "獨立 bot 頻道 → 算接（主 bot 不處理）");
  assert(cb.bridgeTakesMainBotMessage(fake(null, false), () => false) === false, "sender 未就緒 → 不算");
}

// ── 端到端：discord.ts handleMessage ────────────────────────────────────────

section("新討論串、父頻道有主 bot 模式 bridge → 建 bridge 並走這條");
let t1Bridge;
{
  const before = readBridges().length;
  emit(makeMessage(T1, "幫我整理今天的待辦"));
  const routed = await waitFor(() => stdinOf(T1).includes("幫我整理今天的待辦"));
  assert(routed, "訊息送進討論串 bridge 的 CLI stdin");
  t1Bridge = cb.getCliBridge(T1);
  assert(t1Bridge?.label === `wendy-main-t-${T1}`, `記憶體內有討論串 bridge（got ${t1Bridge?.label}）`);
  const entry = entryFor(T1);
  assert(readBridges().length === before + 1, "cli-bridges.json 多一條");
  assert(entry?.label === `wendy-main-t-${T1}` && entry?.enabled === true, "持久化條目 label／enabled 正確");
  assert(entry && Object.keys(entry.channels).length === 1 && entry.channels[T1]?.requireMention === false, "條目只含這個討論串，requireMention 沿用父頻道");
  assert(entry?.workingDir === workDir && entry?.botToken === undefined, "工作目錄沿用、沒有 botToken（主 bot 模式）");
  assert(entry?.channels[T1]?.sessionId === undefined, "沒帶父頻道 sessionId");
  assert(!procs.has(CH_BRIDGED), "父頻道 bridge 沒被叫醒");
  assert(skillCalls.length === 0, "沒觸發 skill");
}

section("同一討論串第二則 → 沿用同一條，不重複建");
{
  emit(makeMessage(T1, "再補一句"));
  await waitFor(() => stdinOf(T1).includes("再補一句"));
  assert(stdinOf(T1).includes("再補一句"), "第二則也送進同一條 CLI");
  assert(cb.getCliBridge(T1) === t1Bridge, "bridge 物件不變");
  assert(readBridges().filter(c => c.channels[T1]).length === 1, "cli-bridges.json 只有一條這個討論串");
}

section("有 bridge 的頻道打「重啟」→ 不觸發 skill，原樣交給 bridge");
{
  emit(makeMessage(CH_BRIDGED, "重啟"));
  const routed = await waitFor(() => stdinOf(CH_BRIDGED).includes("重啟"));
  assert(routed, "「重啟」送進父頻道 bridge 的 CLI");
  assert(skillCalls.length === 0, "skill 沒被叫到");
}

section("自動建的討論串打「更新 一下家計簿」→ 不觸發 skill，交給新 bridge");
{
  emit(makeMessage(T2, "更新 一下家計簿"));
  const routed = await waitFor(() => stdinOf(T2).includes("更新 一下家計簿"));
  assert(routed, "送進新建的討論串 bridge");
  assert(cb.getCliBridge(T2)?.label === `wendy-main-t-${T2}`, "討論串 bridge 已建");
  assert(skillCalls.length === 0, "skill 沒被叫到");
}

section("沒 bridge 的頻道打「重啟」→ 照舊觸發 skill");
{
  const msg = makeMessage(CH_PLAIN, "重啟");
  emit(msg);
  await waitFor(() => skillCalls.length > 0);
  assert(skillCalls.length === 1 && skillCalls[0].channelId === CH_PLAIN, "skill 被叫到一次");
  await waitFor(() => msg.replies.length > 0);
  assert(msg.replies.includes("probe-ran"), "skill 結果有回覆");
  assert(!cb.getCliBridge(CH_PLAIN), "沒替一般頻道建 bridge");
}

section("父頻道沒 bridge 的討論串 → 不建，「重啟」照舊觸發 skill");
{
  const before = JSON.stringify(readBridges());
  emit(makeMessage(T3, "你好"));
  await sleep(SETTLE_MS);
  assert(!cb.getCliBridge(T3), "沒建 bridge");
  assert(JSON.stringify(readBridges()) === before, "cli-bridges.json 沒變");
  emit(makeMessage(T3, "重啟"));
  await waitFor(() => skillCalls.length > 1);
  assert(skillCalls.length === 2 && skillCalls[1].channelId === T3, "skill 照舊被叫到");
}

section("沒過主 bot 的 allowFrom → 父頻道有 bridge 也不建");
{
  const before = JSON.stringify(readBridges());
  emit(makeMessage(T4, "我是路人", { authorId: STRANGER }));
  emit(makeMessage(T4, "重啟", { authorId: STRANGER }));
  await sleep(SETTLE_MS);
  assert(!cb.getCliBridge(T4), "沒建 bridge");
  assert(JSON.stringify(readBridges()) === before, "cli-bridges.json 沒變");
  assert(!procs.has(T4) && skillCalls.length === 2, "沒送進任何 CLI、也沒觸發 skill");
}

section("父 bridge 要 @：沒 @ 不建，有 @ 才建（討論串沿用要 @）");
{
  emit(makeMessage(T5, "沒有 at 的閒聊"));
  await sleep(SETTLE_MS);
  assert(!cb.getCliBridge(T5), "沒 @ → 沒建 bridge");
  emit(makeMessage(T5, "有 at 的問題", { mention: true }));
  const routed = await waitFor(() => stdinOf(T5).includes("有 at 的問題"));
  assert(routed, "有 @ → 建 bridge 並送進 CLI");
  assert(entryFor(T5)?.channels[T5]?.requireMention === true, "討論串條目 requireMention=true");
  emit(makeMessage(T5, "重啟"));
  await waitFor(() => skillCalls.length > 2);
  assert(skillCalls.length === 3 && skillCalls[2].channelId === T5, "要 @ 的 bridge 沒 @ → 不歸 bridge，照舊走 skill／agent-loop");
  assert(!stdinOf(T5).includes("重啟"), "沒 @ 的「重啟」沒送進 CLI");
}

section("主 bot 模式 bridge 頻道打「開新對話」→ 清 sessionId 重建，不送進 CLI");
{
  const oldBridge = cb.getCliBridge(CH_SECOND);
  const msg = makeMessage(CH_SECOND, "開新對話");
  emit(msg);
  const rebuilt = await waitFor(() => cb.getCliBridge(CH_SECOND) && cb.getCliBridge(CH_SECOND) !== oldBridge
    && (channelSends.get(CH_SECOND) ?? []).some(s => s.includes("已開新對話")));
  assert(rebuilt, "bridge 重建，頻道收到「已開新對話」");
  assert(msg.replies.includes("⏳ 開新對話中…"), "先回「開新對話中」");
  assert(entryFor(CH_SECOND)?.channels[CH_SECOND]?.sessionId === undefined, "cli-bridges.json 的 sessionId 已清");
  assert(!stdinOf(CH_SECOND).includes("開新對話"), "口令沒送進 CLI");
  assert(skillCalls.length === 3, "沒觸發 skill");
}

section("討論串 sessionId 寫回自己那條；hot-reload 不重建");
{
  procs.get(T1).at(-1).emit("event", { type: "session_init", sessionId: "sid-thread-1" });
  assert(entryFor(T1)?.channels[T1]?.sessionId === "sid-thread-1", "討論串條目寫入 sessionId");
  assert(entryFor(CH_BRIDGED)?.channels[CH_BRIDGED]?.sessionId === "sid-parent", "父頻道 sessionId 不受影響");
  const parentBridge = cb.getCliBridge(CH_BRIDGED);
  await sleep(2600); // watchFile interval 2s
  assert(cb.getCliBridge(T1) === t1Bridge, "hot-reload 後討論串 bridge 沒被重建");
  assert(cb.getCliBridge(CH_BRIDGED) === parentBridge, "hot-reload 後父頻道 bridge 沒被重建");
}

section("重啟（shutdownAll → startAll）後討論串 bridge 照常重建");
{
  await cb.shutdownAllBridges();
  assert(!cb.getCliBridge(T1), "關閉後記憶體內沒有");
  await cb.startAllBridges(fakeClient);
  const b = cb.getCliBridge(T1);
  assert(b?.label === `wendy-main-t-${T1}`, "重啟後討論串 bridge 由 cli-bridges.json 重建");
  assert(b?.getChannelConfig().sessionId === "sid-thread-1", "帶回自己的 sessionId（--resume 用）");
  assert(b?.getBridgeConfig().workingDir === workDir, "工作目錄不變");
  emit(makeMessage(T1, "重啟後的訊息"));
  const routed = await waitFor(() => stdinOf(T1).includes("重啟後的訊息"));
  assert(routed, "重啟後訊息照樣走討論串 bridge");
}

await cb.shutdownAllBridges();

// ── 結果 ───────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
console.log(failed === 0 ? "CLI_BRIDGE_THREAD_ROUTE_CHECK PASS" : "CLI_BRIDGE_THREAD_ROUTE_CHECK FAIL");
process.exit(failed === 0 ? 0 : 1);
