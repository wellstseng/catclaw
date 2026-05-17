#!/usr/bin/env node
/**
 * @file scripts/memory-cleanup.mjs
 * @description ext_*.md atom 階段性 cleanup CLI（議題 #記憶萃取品質 Sprint 3）
 *
 * 使用：
 *   node scripts/memory-cleanup.mjs --dir <path> --namespace <ns> [--dry-run] [--threshold 0.85]
 *
 * 範例（wendy bot 單一 account 清理）：
 *   node scripts/memory-cleanup.mjs \
 *     --dir ~/.catclaw/workspace/agents/wendy/memory/accounts/discord-owner-480042204346449920 \
 *     --namespace account/discord-owner-480042204346449920 \
 *     --dry-run
 *
 * 流程：掃 ext_*.md → embed → 兩兩 cosine 比對 ≥ threshold 視為同 cluster
 *       → 每 cluster 保留 confirmations 最高、其他 deleteAtom（同時清向量 DB）
 *
 * 需要 catclaw 已 build（dist/workflow/memory-cleanup.js 存在）。
 */

import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");

function getArg(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

const dirArg = getArg("--dir");
const nsArg = getArg("--namespace");
const thresholdArg = getArg("--threshold");

if (!dirArg || !nsArg) {
  console.error("用法：node scripts/memory-cleanup.mjs --dir <path> --namespace <ns> [--dry-run] [--threshold 0.85]");
  process.exit(2);
}

const dir = dirArg.startsWith("~") ? join(homedir(), dirArg.slice(1)) : resolve(dirArg);
const threshold = thresholdArg ? parseFloat(thresholdArg) : 0.85;

if (!existsSync(dir)) {
  console.error(`目錄不存在：${dir}`);
  process.exit(2);
}

const distPath = resolve(__dirname, "..", "dist", "workflow", "memory-cleanup.js");
if (!existsSync(distPath)) {
  console.error(`找不到 dist 編譯產物：${distPath}\n請先跑 pnpm build`);
  process.exit(2);
}

const { runMemoryCleanup } = await import(distPath);

console.log(`[memory-cleanup] dir=${dir}`);
console.log(`[memory-cleanup] namespace=${nsArg}`);
console.log(`[memory-cleanup] threshold=${threshold} dryRun=${dryRun}`);

const result = await runMemoryCleanup({
  dirs: [dir],
  namespace: nsArg,
  threshold,
  dryRun,
});

console.log("\n=== Summary ===");
console.log(JSON.stringify({
  scanned: result.scanned,
  clusters: result.clusters,
  [dryRun ? "would_delete" : "deleted"]: result.duplicates,
  embedFailed: result.embedFailed,
  errors: result.errors,
}, null, 2));

if (result.details.length > 0) {
  console.log("\n=== Clusters (kept → removed) ===");
  for (const d of result.details) {
    console.log(`\n[keep] ${d.keptAtom} (confirmations=${d.keptConfirmations})`);
    for (const r of d.removed) {
      console.log(`  ${dryRun ? "would-delete" : "deleted"} ${r.name} (cos=${r.cosine}, confirmations=${r.confirmations})`);
    }
  }
}
