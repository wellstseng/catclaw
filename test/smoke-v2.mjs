/**
 * V2 啟動路徑 Smoke Test
 *
 * 用法：cd project/catclaw && npm run build && node test/smoke-v2.mjs
 *
 * 驗證項目：
 *   1. V2 偵測：agentDefaults.model.primary 存在 → V2 path
 *   2. models.json 產生 / 載入 / merge
 *   3. alias 解析正確性
 *   4. auth-profile round-robin + cooldown
 *   5. ProviderRegistry V2 建構 + 路由解析
 */

import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── Test infra ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; console.error(`  ❌ ${msg}`); }
}

function section(name) { console.log(`\n── ${name} ──`); }

// ── Setup temp workspace ────────────────────────────────────────────────────

const TMP = join(tmpdir(), `catclaw-smoke-v2-${Date.now()}`);
mkdirSync(TMP, { recursive: true });

// ── 1. V2 偵測 ─────────────────────────────────────────────────────────────

section("V2 偵測邏輯");

const v2Config = { agentDefaults: { model: { primary: "sonnet" } } };
const v1Config = { provider: "claude-oauth", providers: {} };
const v2Detected = !!v2Config.agentDefaults?.model?.primary;
const v1Detected = !!v1Config.agentDefaults?.model?.primary;

assert(v2Detected === true, "V2 config 有 agentDefaults.model.primary → true");
assert(v1Detected === false, "V1 config 無 agentDefaults → false");

// ── 2. models.json 產生 / 載入 / merge ──────────────────────────────────────

section("models.json 產生/載入/merge");

const { ensureModelsJson, loadModelsJson, resetModelsJsonCache, listAllModels } = await import("../dist/providers/models-config.js");

// 2a. 初始產生（無自訂）
resetModelsJsonCache();
const path1 = ensureModelsJson(TMP);
assert(existsSync(path1), "models.json 已產生");

const json1 = loadModelsJson(TMP);
assert(Object.keys(json1.providers).length >= 3, `內建 provider ≥3（實際: ${Object.keys(json1.providers).length}）`);
assert(json1.providers.anthropic != null, "包含 anthropic provider");
assert(json1.providers.anthropic.models.length >= 3, `anthropic 模型 ≥3（實際: ${json1.providers.anthropic.models.length}）`);

// 2b. merge 模式（自訂 Ollama）
resetModelsJsonCache();
const customModelsConfig = {
  mode: "merge",
  providers: {
    ollama: {
      baseUrl: "http://localhost:11434",
      api: "ollama",
      models: [{ id: "qwen3:14b", name: "Qwen3 14B", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 4096 }],
    },
  },
};
ensureModelsJson(TMP, customModelsConfig);
resetModelsJsonCache();
const json2 = loadModelsJson(TMP);
assert(json2.providers.ollama != null, "merge 模式包含 ollama");
assert(json2.providers.anthropic != null, "merge 模式保留 anthropic");
const ollamaModels = json2.providers.ollama.models.map(m => m.id);
assert(ollamaModels.includes("qwen3:14b"), "ollama 包含自訂 qwen3:14b");

// 2c. replace 模式
resetModelsJsonCache();
ensureModelsJson(TMP, { mode: "replace", providers: { "my-llm": { baseUrl: "http://my.llm", models: [] } } });
resetModelsJsonCache();
const json3 = loadModelsJson(TMP);
assert(json3.providers["my-llm"] != null, "replace 模式包含自訂 provider");
assert(json3.providers.anthropic == null, "replace 模式不含 anthropic");

// 2d. listAllModels
resetModelsJsonCache();
ensureModelsJson(TMP);
resetModelsJsonCache();
const allModels = listAllModels(loadModelsJson(TMP));
assert(allModels.length >= 5, `listAllModels ≥5（實際: ${allModels.length}）`);

// ── 3. Alias 解析 ──────────────────────────────────────────────────────────

section("Alias 解析");

const { parseModelRef, formatModelRef, normalizeProviderId, buildAliasMap } = await import("../dist/providers/model-ref.js");

const aliases = {
  "anthropic/claude-sonnet-4-6": { alias: "sonnet" },
  "anthropic/claude-opus-4-6": { alias: "opus" },
  "anthropic/claude-haiku-4-5-20251001": { alias: "haiku" },
  "ollama/qwen3:14b": { alias: "qwen3" },
};

// 3a. alias → full ref
const ref1 = parseModelRef("sonnet", aliases);
assert(ref1 != null && ref1.provider === "anthropic" && ref1.model === "claude-sonnet-4-6", "sonnet → anthropic/claude-sonnet-4-6");

const ref2 = parseModelRef("haiku", aliases);
assert(ref2 != null && ref2.provider === "anthropic" && ref2.model === "claude-haiku-4-5-20251001", "haiku → anthropic/claude-haiku-4-5-20251001");

const ref3 = parseModelRef("qwen3", aliases);
assert(ref3 != null && ref3.provider === "ollama" && ref3.model === "qwen3:14b", "qwen3 → ollama/qwen3:14b");

// 3b. full ref 直接解析
const ref4 = parseModelRef("anthropic/claude-opus-4-6", aliases);
assert(ref4 != null && ref4.provider === "anthropic" && ref4.model === "claude-opus-4-6", "full ref anthropic/claude-opus-4-6 解析正確");

// 3c. formatModelRef
assert(formatModelRef({ provider: "anthropic", model: "claude-sonnet-4-6" }) === "anthropic/claude-sonnet-4-6", "formatModelRef 正確");

// 3d. normalizeProviderId
assert(normalizeProviderId("claude") === "anthropic", "claude → anthropic");
assert(normalizeProviderId("claude-oauth") === "anthropic", "claude-oauth → anthropic");
assert(normalizeProviderId("ollama") === "ollama", "ollama → ollama");

// 3e. buildAliasMap
const aliasMap = buildAliasMap(aliases);
assert(aliasMap.get("sonnet") === "anthropic/claude-sonnet-4-6", "aliasMap sonnet 正確");
assert(aliasMap.get("qwen3") === "ollama/qwen3:14b", "aliasMap qwen3 正確");

// ── 4. Auth Profile Store ──────────────────────────────────────────────────

section("Auth Profile Store");

const { AuthProfileStore } = await import("../dist/providers/auth-profile-store.js");

// 4a. V1 → V2 自動遷移
const v1ProfilePath = join(TMP, "auth-v1.json");
writeFileSync(v1ProfilePath, JSON.stringify([
  { id: "key-1", credential: "sk-ant-api-111" },
  { id: "key-2", credential: "sk-ant-api-222" },
]));
const store1 = new AuthProfileStore(v1ProfilePath);
store1.load();
const all1 = store1.listAll();
assert(Object.keys(all1).length === 2, "V1 遷移後有 2 組 profile");
assert(all1["anthropic:key-1"]?.type === "api_key", "V1 遷移 key 格式正確");

// 4b. Round-robin
const pick1 = store1.pickForProvider("anthropic");
assert(pick1 != null, "pickForProvider 回傳非 null");
assert(pick1.apiKey === "sk-ant-api-111" || pick1.apiKey === "sk-ant-api-222", "pick 的 apiKey 是有效值");

const pick2 = store1.pickForProvider("anthropic");
assert(pick2 != null && pick2.profileId !== pick1.profileId, "第二次 pick 輪到不同 profile（round-robin）");

// 4c. Cooldown
store1.setCooldown(pick1.profileId, "rate_limit");
const pick3 = store1.pickForProvider("anthropic");
assert(pick3 != null && pick3.profileId !== pick1.profileId, "cooldown 後 pick 跳過受限 profile");

// 4d. 全部 cooldown
store1.setCooldown(pick3.profileId, "rate_limit");
const pick4 = store1.pickForProvider("anthropic");
assert(pick4 == null, "全部 cooldown → pick 回傳 null");

// 4e. Clear cooldown
store1.clearCooldown(pick1.profileId);
const pick5 = store1.pickForProvider("anthropic");
assert(pick5 != null && pick5.profileId === pick1.profileId, "clearCooldown 後 pick 恢復");

// 4f. V2 格式直接載入
const v2ProfilePath = join(TMP, "auth-v2.json");
writeFileSync(v2ProfilePath, JSON.stringify({
  version: 1,
  profiles: {
    "anthropic:main": { type: "api_key", provider: "anthropic", key: "sk-ant-api-main" },
    "anthropic:backup": { type: "api_key", provider: "anthropic", key: "sk-ant-api-backup" },
  },
  order: { anthropic: ["anthropic:main", "anthropic:backup"] },
  usageStats: {},
}));
const store2 = new AuthProfileStore(v2ProfilePath);
store2.load();
const orderPick = store2.pickForProvider("anthropic");
assert(orderPick?.profileId === "anthropic:main", "按 order 排序第一個是 main");

// ── 5. ProviderRegistry V2 建構（路由解析）──────────────────────────────────

section("ProviderRegistry V2");

const { ProviderRegistry } = await import("../dist/providers/registry.js");

// 模擬 registry（不需要實際 provider，直接用 ProviderRegistry 測試路由邏輯）
const mockProvider = (id) => ({ id, init: null, shutdown: null, chat: async () => ({ content: "mock" }) });

const registry = new ProviderRegistry("anthropic/claude-sonnet-4-6", {
  channels: { "ch-123": "haiku" },
  roles: { default: "sonnet" },
}, aliases);

registry.register(mockProvider("anthropic/claude-sonnet-4-6"));
registry.register(mockProvider("anthropic/claude-haiku-4-5-20251001"));
registry.register(mockProvider("anthropic/claude-opus-4-6"));

// 5a. 預設解析
const r1 = registry.resolve();
assert(r1.id === "anthropic/claude-sonnet-4-6", "預設解析 → primary (sonnet)");

// 5b. channel 覆蓋（alias → full ref）
const r2 = registry.resolve({ channelId: "ch-123" });
assert(r2.id === "anthropic/claude-haiku-4-5-20251001", "channel ch-123 → haiku alias → claude-haiku-4-5");

// 5c. role 覆蓋
const r3 = registry.resolve({ role: "default" });
assert(r3.id === "anthropic/claude-sonnet-4-6", "role=default → sonnet");

// 5d. get by alias
const g1 = registry.get("opus");
assert(g1?.id === "anthropic/claude-opus-4-6", "get('opus') → claude-opus-4-6");

// 5e. get by full ref
const g2 = registry.get("anthropic/claude-sonnet-4-6");
assert(g2?.id === "anthropic/claude-sonnet-4-6", "get full ref → 正確");

// 5f. list
const all = registry.list();
assert(all.length === 3, `list() 回傳 3 個 provider（實際: ${all.length}）`);

// ── Cleanup ─────────────────────────────────────────────────────────────────

rmSync(TMP, { recursive: true, force: true });

// ── 結果 ────────────────────────────────────────────────────────────────────

console.log(`\n${"═".repeat(50)}`);
console.log(`  ✅ Passed: ${passed}  ❌ Failed: ${failed}`);
console.log(`${"═".repeat(50)}`);
process.exit(failed > 0 ? 1 : 0);
