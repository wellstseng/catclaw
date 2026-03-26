/**
 * @file scripts/smoke-test-s14.mjs
 * @description Smoke test — S14 Agent Registry + Multi-Bot
 * 執行：node scripts/smoke-test-s14.mjs
 */

let passed = 0, failed = 0;
const _queue = [];

function test(name, fn) { _queue.push({ name, fn }); }
async function runAll() {
  for (const { name, fn } of _queue) {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (err) { console.error(`  ✗ ${name}: ${err.message}`); failed++; }
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg ?? "assertion failed"); }
function assertEqual(a, b, msg) { if (a !== b) throw new Error(msg ?? `${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }

// ── 1. deepMerge ─────────────────────────────────────────────────────────────

test("deepMerge: 純值覆寫", async () => {
  const { deepMerge } = await import("../dist/core/agent-registry.js");
  const base = { a: 1, b: 2 };
  const over = { b: 99 };
  const r = deepMerge(base, over);
  assertEqual(r.a, 1);
  assertEqual(r.b, 99);
});

test("deepMerge: Object 遞迴合併", async () => {
  const { deepMerge } = await import("../dist/core/agent-registry.js");
  const base = { nested: { x: 1, y: 2 } };
  const over = { nested: { y: 99 } };
  const r = deepMerge(base, over);
  assertEqual(r.nested.x, 1);  // 保留
  assertEqual(r.nested.y, 99); // 覆寫
});

test("deepMerge: Array 完全替換（不 concat）", async () => {
  const { deepMerge } = await import("../dist/core/agent-registry.js");
  const base = { arr: [1, 2, 3] };
  const over = { arr: [9] };
  const r = deepMerge(base, over);
  assertEqual(r.arr.length, 1);
  assertEqual(r.arr[0], 9);
});

test("deepMerge: undefined 值不覆寫", async () => {
  const { deepMerge } = await import("../dist/core/agent-registry.js");
  const base = { a: 42 };
  const over = { a: undefined };
  const r = deepMerge(base, over);
  assertEqual(r.a, 42); // base 保留
});

// ── 2. AgentRegistry ─────────────────────────────────────────────────────────

test("AgentRegistry: list() 回傳 agent ids", async () => {
  const { AgentRegistry } = await import("../dist/core/agent-registry.js");
  const reg = new AgentRegistry({ "bot-a": {}, "bot-b": {} });
  const ids = reg.list();
  assert(ids.includes("bot-a"));
  assert(ids.includes("bot-b"));
  assertEqual(ids.length, 2);
});

test("AgentRegistry: has()", async () => {
  const { AgentRegistry } = await import("../dist/core/agent-registry.js");
  const reg = new AgentRegistry({ "bot-a": {} });
  assert(reg.has("bot-a"));
  assert(!reg.has("bot-x"));
});

test("AgentRegistry: resolve() 深合併設定", async () => {
  const { AgentRegistry } = await import("../dist/core/agent-registry.js");
  const base = {
    discord: { token: "base-token", dm: { enabled: true }, guilds: {} },
    providers: { "claude-api": { model: "claude-opus-4-6" } },
    admin: { allowedUserIds: [] },
  };
  const reg = new AgentRegistry({
    "support-bot": {
      discord: { token: "support-token" },
      providers: { "claude-api": { model: "claude-haiku-4-5-20251001" } },
    },
  });

  const resolved = reg.resolve("support-bot", base);
  assertEqual(resolved.discord.token, "support-token");                     // 覆寫
  assertEqual(resolved.discord.dm.enabled, true);                           // 繼承
  assertEqual(resolved.providers["claude-api"].model, "claude-haiku-4-5-20251001"); // 覆寫
});

test("AgentRegistry: resolve() 找不到 agent → throw", async () => {
  const { AgentRegistry } = await import("../dist/core/agent-registry.js");
  const reg = new AgentRegistry({});
  let threw = false;
  try { reg.resolve("nonexistent", {}); } catch { threw = true; }
  assert(threw, "should throw for unknown agent");
});

// ── 3. 單例 ──────────────────────────────────────────────────────────────────

test("AgentRegistry singleton: init / get / reset", async () => {
  const { initAgentRegistry, getAgentRegistry, resetAgentRegistry } =
    await import("../dist/core/agent-registry.js");

  resetAgentRegistry();
  let threw = false;
  try { getAgentRegistry(); } catch { threw = true; }
  assert(threw, "should throw before init");

  initAgentRegistry({ "bot-a": {} });
  const reg = getAgentRegistry();
  assert(reg.has("bot-a"));

  resetAgentRegistry();
});

// ── 4. parseAgentArg ─────────────────────────────────────────────────────────

test("parseAgentArg: --agent <id>", async () => {
  const { parseAgentArg } = await import("../dist/core/agent-loader.js");
  const id = parseAgentArg(["node", "index.js", "--agent", "support-bot"]);
  assertEqual(id, "support-bot");
});

test("parseAgentArg: --agent=<id>", async () => {
  const { parseAgentArg } = await import("../dist/core/agent-loader.js");
  const id = parseAgentArg(["node", "index.js", "--agent=dev-bot"]);
  assertEqual(id, "dev-bot");
});

test("parseAgentArg: 無 --agent → undefined", async () => {
  const { parseAgentArg } = await import("../dist/core/agent-loader.js");
  const id = parseAgentArg(["node", "index.js"]);
  assertEqual(id, undefined);
});

// ── 5. loadAgentConfig ───────────────────────────────────────────────────────

test("loadAgentConfig: per-agent data 路徑獨立", async () => {
  const { loadAgentConfig } = await import("../dist/core/agent-loader.js");
  const base = {
    discord: { token: "tok", dm: { enabled: true }, guilds: {} },
    admin: { allowedUserIds: [] },
    agents: {
      "bot-x": {
        discord: { token: "tok-x" },
      },
    },
    session: { ttlHours: 168, maxHistoryTurns: 50, compactAfterTurns: 30, persistPath: "/base/sessions" },
    memory: { enabled: true, globalPath: "/mem/global", vectorDbPath: "/mem/_vectordb" },
  };

  const resolved = loadAgentConfig(base, "bot-x");
  assert(resolved.session.persistPath.includes("agents/bot-x"), `persistPath should be per-agent: ${resolved.session.persistPath}`);
  assert(resolved.memory.vectorDbPath.includes("agents/bot-x"), `vectorDbPath should be per-agent: ${resolved.memory.vectorDbPath}`);
  assertEqual(resolved.discord.token, "tok-x");
});

test("loadAgentConfig: 找不到 agent → throw", async () => {
  const { loadAgentConfig } = await import("../dist/core/agent-loader.js");
  const base = { agents: {} };
  let threw = false;
  try { loadAgentConfig(base, "no-such-agent"); } catch { threw = true; }
  assert(threw);
});

// ── 執行 ──────────────────────────────────────────────────────────────────────

console.log("\nSmoke Test — S14 Agent Registry + Multi-Bot\n");
await runAll();
console.log(`\n結果：${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
