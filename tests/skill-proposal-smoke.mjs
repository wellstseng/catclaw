/**
 * skill-improvement / skill-candidate dedup + TTL + priority smoke
 *
 * 測試項目：
 *   1. improvement cooldown：同 skill+triggeredBy 24h 內第二次 → null
 *   2. improvement TTL sweep：mtime 超過 ttlDays → 刪除
 *   3. candidate priority/urgencyScore frontmatter round-trip
 *   4. candidate sweep
 *
 * 用法：node tests/skill-proposal-smoke.mjs
 */

import { mkdirSync, rmSync, existsSync, writeFileSync, utimesSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let passed = 0, failed = 0;
function assert(c, n) { if (c) { console.log(`  ✓ ${n}`); passed++; } else { console.error(`  ✗ ${n}`); failed++; } }
function assertEq(a, b, n) { assert(a === b, `${n} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`); }

const tmpHome = join(tmpdir(), `catclaw-proposal-${process.pid}-${Date.now()}`);
mkdirSync(tmpHome, { recursive: true });
process.env["CATCLAW_HOME"] = tmpHome;
process.env["CATCLAW_CONFIG_DIR"] = tmpHome;
// 構造最簡 catclaw.json 滿足 config loader
writeFileSync(join(tmpHome, "catclaw.json"), JSON.stringify({
  discord: { token: "stub" },
  agents: { default: { provider: "claude-oauth" } },
  cron: { enabled: false },
}), "utf-8");

process.on("exit", () => { try { rmSync(tmpHome, { recursive: true, force: true }); } catch {} });

// ── Test 1: improvement cooldown ────────────────────────────────────────

console.log("\n═══ Test 1: improvement cooldown ═══");
{
  const { proposeSkillImprovement, isInCooldown } = await import("../dist/memory/skill-improvement-store.js");
  const ctx = { args: "test args", channelId: "ch1", authorId: "u1" };

  const p1 = proposeSkillImprovement({ skillName: "test-skill", triggeredBy: "self-reflection", ctx });
  assert(p1 !== null, "首次提案成功");

  assertEq(isInCooldown("test-skill", "self-reflection", 24), true, "立刻 isInCooldown=true");

  const p2 = proposeSkillImprovement({ skillName: "test-skill", triggeredBy: "self-reflection", ctx });
  assertEq(p2, null, "24h 內第二次提案 → null（cooldown 命中）");

  // 不同 triggeredBy 不受 cooldown
  const p3 = proposeSkillImprovement({ skillName: "test-skill", triggeredBy: "exception", ctx });
  assert(p3 !== null, "不同 triggeredBy 不受 cooldown");
}

// ── Test 2: improvement TTL sweep ───────────────────────────────────────

console.log("\n═══ Test 2: improvement TTL sweep ═══");
{
  const { sweepExpiredImprovements } = await import("../dist/memory/skill-improvement-store.js");
  const stagingDir = join(tmpHome, "workspace", "_staging", "skill-improvements");
  // 至少有上面 Test 1 的提案；造一個假的「20 天前」.md
  const oldPath = join(stagingDir, "ancient-skill-old.md");
  writeFileSync(oldPath, "old content", "utf-8");
  const past = (Date.now() - 20 * 86_400_000) / 1000;
  utimesSync(oldPath, past, past);

  const removed = sweepExpiredImprovements(14); // 14 天 TTL
  assert(removed >= 1, `sweep 移除 ≥ 1 個過期檔（actual=${removed}）`);
  assert(!existsSync(oldPath), "20 天前的檔被 sweep 掉");
}

// ── Test 3: candidate priority round-trip ──────────────────────────────

console.log("\n═══ Test 3: candidate priority + urgencyScore round-trip ═══");
{
  const { proposeSkillCandidate, listSkillCandidates } = await import("../dist/memory/skill-candidate-store.js");

  const filePath = proposeSkillCandidate({
    slug: "test-slug",
    description: "test desc",
    whenToUse: "when",
    sampleWorkflow: "sw",
    reason: "r",
    triggeredBy: "turn",
    channelId: "ch", agentId: "a", sessionKey: "sk",
    priority: "high",
    urgencyScore: 9,
  });
  assert(filePath !== null, "candidate 寫入成功");

  const entries = listSkillCandidates();
  const found = entries.find(e => e.slug === "test-slug");
  assert(found != null, "list 找得到");
  assertEq(found.priority, "high", "priority=high");
  assertEq(found.urgencyScore, 9, "urgencyScore=9");
}

// ── Test 4: candidate sweep ────────────────────────────────────────────

console.log("\n═══ Test 4: candidate TTL sweep ═══");
{
  const { sweepExpiredCandidates } = await import("../dist/memory/skill-candidate-store.js");
  const stagingDir = join(tmpHome, "workspace", "_staging", "skill-candidates");
  const oldPath = join(stagingDir, "ancient-cand-old.md");
  writeFileSync(oldPath, "old", "utf-8");
  const past = (Date.now() - 40 * 86_400_000) / 1000;
  utimesSync(oldPath, past, past);

  const removed = sweepExpiredCandidates(30);
  assert(removed >= 1, `candidate sweep 移除 ≥ 1（actual=${removed}）`);
  assert(!existsSync(oldPath), "40 天前的檔被 sweep 掉");
}

console.log(`\n═══ 結果：${passed} passed, ${failed} failed ═══`);
process.exit(failed > 0 ? 1 : 0);
