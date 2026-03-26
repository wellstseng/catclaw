/**
 * @file scripts/smoke-test-s10.mjs
 * @description Smoke test — S10 專案管理 + 三層記憶
 * 執行：node scripts/smoke-test-s10.mjs
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let passed = 0, failed = 0;
const _queue = [];

function test(name, fn) { _queue.push({ name, fn }); }
async function runAll() {
  for (const { name, fn } of _queue) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ✗ ${name}: ${err.message}`);
      failed++;
    }
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg ?? "assertion failed"); }
function assertEqual(a, b, msg) { if (a !== b) throw new Error(msg ?? `${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }

// ── 1. ProjectManager — CRUD ──────────────────────────────────────────────────

test("ProjectManager: create + get", async () => {
  const { ProjectManager } = await import("../dist/projects/manager.js");
  const tmpDir = mkdtempSync(join(tmpdir(), "s10-pm-"));
  const mgr = new ProjectManager(tmpDir);
  mgr.init();

  const project = mgr.create({ projectId: "my-proj", displayName: "My Project", createdBy: "wells" });
  assertEqual(project.projectId, "my-proj");
  assertEqual(project.displayName, "My Project");
  assert(project.members.includes("wells"));

  const got = mgr.get("my-proj");
  assert(got !== null);
  assertEqual(got.displayName, "My Project");
  rmSync(tmpDir, { recursive: true });
});

test("ProjectManager: duplicate create → error", async () => {
  const { ProjectManager } = await import("../dist/projects/manager.js");
  const tmpDir = mkdtempSync(join(tmpdir(), "s10-pm2-"));
  const mgr = new ProjectManager(tmpDir);
  mgr.init();

  mgr.create({ projectId: "proj1", displayName: "P1", createdBy: "a" });
  let threw = false;
  try { mgr.create({ projectId: "proj1", displayName: "P1b", createdBy: "b" }); }
  catch { threw = true; }
  assertEqual(threw, true, "should throw on duplicate");
  rmSync(tmpDir, { recursive: true });
});

test("ProjectManager: invalid projectId → error", async () => {
  const { ProjectManager } = await import("../dist/projects/manager.js");
  const tmpDir = mkdtempSync(join(tmpdir(), "s10-pm3-"));
  const mgr = new ProjectManager(tmpDir);
  mgr.init();

  let threw = false;
  try { mgr.create({ projectId: "a b c", displayName: "Bad", createdBy: "x" }); }
  catch { threw = true; }
  assertEqual(threw, true, "should throw on invalid id");
  rmSync(tmpDir, { recursive: true });
});

test("ProjectManager: list + listForAccount", async () => {
  const { ProjectManager } = await import("../dist/projects/manager.js");
  const tmpDir = mkdtempSync(join(tmpdir(), "s10-pm4-"));
  const mgr = new ProjectManager(tmpDir);
  mgr.init();

  mgr.create({ projectId: "pub", displayName: "Public", createdBy: "admin" });
  // Make it public (empty members after creation by removing admin from members)
  mgr.update("pub", { members: [] });

  mgr.create({ projectId: "priv", displayName: "Private", createdBy: "admin" });

  const forAlice = mgr.listForAccount("alice");
  assert(forAlice.some(p => p.projectId === "pub"), "alice can see public project");
  assert(!forAlice.some(p => p.projectId === "priv"), "alice cannot see private project");

  const forAdmin = mgr.listForAccount("admin");
  assert(forAdmin.some(p => p.projectId === "priv"), "admin can see private project");
  rmSync(tmpDir, { recursive: true });
});

test("ProjectManager: addMember + removeMember", async () => {
  const { ProjectManager } = await import("../dist/projects/manager.js");
  const tmpDir = mkdtempSync(join(tmpdir(), "s10-pm5-"));
  const mgr = new ProjectManager(tmpDir);
  mgr.init();

  mgr.create({ projectId: "team", displayName: "Team", createdBy: "owner" });
  mgr.addMember("team", "alice");

  const p = mgr.get("team");
  assert(p.members.includes("alice"));

  mgr.removeMember("team", "alice");
  const p2 = mgr.get("team");
  assert(!p2.members.includes("alice"));
  rmSync(tmpDir, { recursive: true });
});

test("ProjectManager: resolveMemoryDir", async () => {
  const { ProjectManager } = await import("../dist/projects/manager.js");
  const tmpDir = mkdtempSync(join(tmpdir(), "s10-pm6-"));
  const mgr = new ProjectManager(tmpDir);
  mgr.init();

  mgr.create({ projectId: "foo", displayName: "Foo", createdBy: "a" });
  const dir = mgr.resolveMemoryDir("foo", "/global/memory/root");
  assert(dir.includes("foo"), `memory dir should include project id: ${dir}`);
  rmSync(tmpDir, { recursive: true });
});

// ── 2. Singleton ──────────────────────────────────────────────────────────────

test("initProjectManager / getProjectManager singleton", async () => {
  const { initProjectManager, getProjectManager, resetProjectManager } = await import("../dist/projects/manager.js");
  const tmpDir = mkdtempSync(join(tmpdir(), "s10-s-"));

  resetProjectManager();
  let threw = false;
  try { getProjectManager(); } catch { threw = true; }
  assertEqual(threw, true, "should throw before init");

  initProjectManager(tmpDir);
  const mgr = getProjectManager();
  assert(mgr !== null);

  resetProjectManager();
  rmSync(tmpDir, { recursive: true });
});

// ── 3. MemoryEngine — init + recall（MEMORY.md なし → 空結果）────────────────

test("MemoryEngine: init succeeds (no MEMORY.md → empty recall)", async () => {
  const { MemoryEngine } = await import("../dist/memory/engine.js");
  const tmpDir = mkdtempSync(join(tmpdir(), "s10-me-"));
  const globalPath = join(tmpDir, "global");

  const engine = new MemoryEngine({
    enabled: true,
    globalPath,
    vectorDbPath: join(tmpDir, "_vectordb"),
    contextBudget: 3000,
    contextBudgetRatio: { global: 0.3, project: 0.4, account: 0.3 },
    writeGate: { enabled: false, dedupThreshold: 0.80 },
    recall: { triggerMatch: true, vectorSearch: false, relatedEdgeSpreading: false, vectorMinScore: 0.65, vectorTopK: 5 },
    extract: { enabled: false, perTurn: false, onSessionEnd: false, maxItemsPerTurn: 3, maxItemsSessionEnd: 5, minNewChars: 500 },
    consolidate: { autoPromoteThreshold: 20, suggestPromoteThreshold: 8, decay: { enabled: false, halfLifeDays: 30, archiveThreshold: 0.1 } },
    episodic: { enabled: false, ttlDays: 24 },
    rutDetection: { enabled: false, windowSize: 14, minOccurrences: 2 },
    oscillation: { enabled: false },
  });

  await engine.init();

  const result = await engine.recall("test prompt", { accountId: "user1" });
  assertEqual(result.fragments.length, 0);
  assertEqual(result.blindSpot, true);

  rmSync(tmpDir, { recursive: true });
});

// ── 4. MemoryEngine — recall with MEMORY.md ────────────────────────────────

test("MemoryEngine: trigger match returns atom fragment", async () => {
  const { MemoryEngine } = await import("../dist/memory/engine.js");
  const tmpDir = mkdtempSync(join(tmpdir(), "s10-me2-"));
  const globalPath = join(tmpDir, "global");
  mkdirSync(globalPath, { recursive: true });

  // 建立 MEMORY.md
  writeFileSync(join(globalPath, "MEMORY.md"), [
    "# Atom Index",
    "",
    "| Atom | Path | Trigger | Confidence |",
    "|------|------|---------|------------|",
    "| preferences | memory/preferences.md | 偏好, 設定, 風格 | [固] |",
  ].join("\n"));

  // 建立 atom 檔案
  const memDir = join(globalPath, "memory");
  mkdirSync(memDir, { recursive: true });
  writeFileSync(join(memDir, "preferences.md"), [
    "# preferences",
    "",
    "- Scope: global",
    "- Confidence: [固]",
    "- Trigger: 偏好, 設定, 風格",
    "- Last-used: 2026-01-01",
    "- Confirmations: 5",
    "",
    "## 知識",
    "",
    "- [固] 用繁體中文回覆",
  ].join("\n"));

  const engine = new MemoryEngine({
    enabled: true,
    globalPath,
    vectorDbPath: join(tmpDir, "_vectordb"),
    contextBudget: 3000,
    contextBudgetRatio: { global: 0.3, project: 0.4, account: 0.3 },
    writeGate: { enabled: false, dedupThreshold: 0.80 },
    recall: { triggerMatch: true, vectorSearch: false, relatedEdgeSpreading: false, vectorMinScore: 0.65, vectorTopK: 5 },
    extract: { enabled: false, perTurn: false, onSessionEnd: false, maxItemsPerTurn: 3, maxItemsSessionEnd: 5, minNewChars: 500 },
    consolidate: { autoPromoteThreshold: 20, suggestPromoteThreshold: 8, decay: { enabled: false, halfLifeDays: 30, archiveThreshold: 0.1 } },
    episodic: { enabled: false, ttlDays: 24 },
    rutDetection: { enabled: false, windowSize: 14, minOccurrences: 2 },
    oscillation: { enabled: false },
  });

  await engine.init();

  const result = await engine.recall("我的偏好設定是什麼", { accountId: "user1", skipCache: true });
  assert(result.fragments.length > 0, "should find atom via trigger match");
  assertEqual(result.fragments[0].matchedBy, "trigger");
  assertEqual(result.fragments[0].layer, "global");

  // buildContext 應輸出 text
  const ctx = engine.buildContext(result.fragments, "偏好設定");
  assert(ctx.text.length > 0, "context text should be non-empty");
  assert(ctx.tokenCount > 0);

  rmSync(tmpDir, { recursive: true });
});

// ── 5. 三層 recall：global + project + account ────────────────────────────────

test("MemoryEngine: three-layer recall merges fragments", async () => {
  const { MemoryEngine } = await import("../dist/memory/engine.js");
  const tmpDir = mkdtempSync(join(tmpdir(), "s10-3layer-"));
  const globalPath = join(tmpDir, "global");

  // 建立全域記憶
  mkdirSync(join(globalPath, "memory"), { recursive: true });
  writeFileSync(join(globalPath, "MEMORY.md"), [
    "# Atom Index",
    "| Atom | Path | Trigger | Confidence |",
    "|------|------|---------|------------|",
    "| global-atom | memory/global-atom.md | global | [固] |",
  ].join("\n"));
  writeFileSync(join(globalPath, "memory", "global-atom.md"), [
    "# global-atom",
    "- Scope: global",
    "- Confidence: [固]",
    "- Trigger: global",
    "- Last-used: 2026-01-01",
    "- Confirmations: 1",
    "## 知識",
    "- [固] 全域知識",
  ].join("\n"));

  // 建立專案記憶（projectDir = dirname(globalPath)/projects/{id} = tmpDir/projects/{id}）
  const projPath = join(tmpDir, "projects", "test-proj");
  mkdirSync(join(projPath, "memory"), { recursive: true });
  writeFileSync(join(projPath, "MEMORY.md"), [
    "# Atom Index",
    "| Atom | Path | Trigger | Confidence |",
    "|------|------|---------|------------|",
    "| proj-atom | memory/proj-atom.md | project | [固] |",
  ].join("\n"));
  writeFileSync(join(projPath, "memory", "proj-atom.md"), [
    "# proj-atom",
    "- Scope: project",
    "- Confidence: [固]",
    "- Trigger: project",
    "- Last-used: 2026-01-01",
    "- Confirmations: 1",
    "## 知識",
    "- [固] 專案知識",
  ].join("\n"));

  const engine = new MemoryEngine({
    enabled: true,
    globalPath,
    vectorDbPath: join(tmpDir, "_vectordb"),
    contextBudget: 3000,
    contextBudgetRatio: { global: 0.3, project: 0.4, account: 0.3 },
    writeGate: { enabled: false, dedupThreshold: 0.80 },
    recall: { triggerMatch: true, vectorSearch: false, relatedEdgeSpreading: false, vectorMinScore: 0.65, vectorTopK: 5 },
    extract: { enabled: false, perTurn: false, onSessionEnd: false, maxItemsPerTurn: 3, maxItemsSessionEnd: 5, minNewChars: 500 },
    consolidate: { autoPromoteThreshold: 20, suggestPromoteThreshold: 8, decay: { enabled: false, halfLifeDays: 30, archiveThreshold: 0.1 } },
    episodic: { enabled: false, ttlDays: 24 },
    rutDetection: { enabled: false, windowSize: 14, minOccurrences: 2 },
    oscillation: { enabled: false },
  });

  await engine.init();

  // global + project recall
  const result = await engine.recall("global project query", {
    accountId: "user1",
    projectId: "test-proj",
    skipCache: true,
  });

  const layers = new Set(result.fragments.map(f => f.layer));
  assert(layers.has("global"), "should have global fragments");
  assert(layers.has("project"), "should have project fragments");

  rmSync(tmpDir, { recursive: true });
});

// ── 執行 ──────────────────────────────────────────────────────────────────────

console.log("\nSmoke Test — S10 專案管理 + 三層記憶\n");
await runAll();
console.log(`\n結果：${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
