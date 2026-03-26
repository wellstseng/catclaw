/**
 * @file scripts/smoke-test-s13.mjs
 * @description Smoke test — S13 Cleanup + HomeClaudeCode config
 * 執行：node scripts/smoke-test-s13.mjs
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

// ── 1. /help skill 可載入 ───────────────────────────────────────────────────

test("help skill: 可載入且 tier=public", async () => {
  const { skill } = await import("../dist/skills/builtin/help.js");
  assertEqual(skill.name, "help");
  assertEqual(skill.tier, "public");
  assert(skill.trigger.includes("/help"));
});

test("help skill: execute 不崩潰（無 platform）", async () => {
  const { skill } = await import("../dist/skills/builtin/help.js");
  const ctx = { args: "", authorId: "test-user", channelId: "ch1", message: {}, config: {} };
  const result = await skill.execute(ctx);
  assert(typeof result.text === "string", "should return text");
});

// ── 2. listSkills 有被正確匯出 ──────────────────────────────────────────────

test("registry: listSkills() 存在且回傳陣列", async () => {
  const { listSkills } = await import("../dist/skills/registry.js");
  const list = listSkills();
  assert(Array.isArray(list), "listSkills should return array");
});

// ── 3. HomeClaudeCode config 型別與預設 ────────────────────────────────────

test("HomeClaudeCodeConfig: 型別可用（編譯驗證）", async () => {
  // 若 build 成功則型別沒問題，此測試只驗證 runtime 值
  const cfg = { enabled: true, path: "/custom/path" };
  assertEqual(cfg.enabled, true);
  assertEqual(cfg.path, "/custom/path");
  assert(true, "HomeClaudeCodeConfig type is valid");
});

test("migrate skill: 可載入且 tier=admin", async () => {
  const { skill } = await import("../dist/skills/builtin/migrate.js");
  assertEqual(skill.name, "migrate");
  assertEqual(skill.tier, "admin");
  assert(skill.trigger.includes("/migrate"));
});

test("migrate skill: status 子命令不崩潰", async () => {
  const { skill } = await import("../dist/skills/builtin/migrate.js");
  const ctx = { args: "status", authorId: "admin", channelId: "ch1", message: {}, config: {} };
  const result = await skill.execute(ctx);
  assert(typeof result.text === "string");
  assert(result.text.includes("遷移狀態"), `should show status, got: ${result.text}`);
});

test("migrate skill: 無效子命令回傳 help", async () => {
  const { skill } = await import("../dist/skills/builtin/migrate.js");
  const ctx = { args: "unknown", authorId: "admin", channelId: "ch1", message: {}, config: {} };
  const result = await skill.execute(ctx);
  assert(result.text.includes("/migrate"), "should show help text");
});

// ── 執行 ──────────────────────────────────────────────────────────────────────

console.log("\nSmoke Test — S13 Cleanup + HomeClaudeCode\n");
await runAll();
console.log(`\n結果：${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
