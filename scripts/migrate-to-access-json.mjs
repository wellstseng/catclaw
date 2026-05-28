#!/usr/bin/env node
/**
 * V5 P3 — 一次性遷移：從 atom .md 抽 Last-used/Confirmations → 建 <atom>.access.json
 *
 * 掃描範圍：
 *   1. CLI --dir <path>（可重複）→ 指定目錄
 *   2. 預設掃 ~/.catclaw 下所有 atom .md（recurse，套 shouldSkip 規則）
 *
 * 行為：
 *   - 對每個 atom .md：parse Last-used/Confirmations/Created-at → migrateFromMd 寫 access.json
 *   - idempotent（已存在 .access.json 且 confirmations >= md 值時跳過覆寫）
 *   - --overwrite：強制以 .md 值覆寫
 *   - --clean-md：完成後從 .md 移除 Last-used / Confirmations 欄位（**有損變更**，預設關閉）
 *   - --dry-run：只列不寫
 *
 * 用法：
 *   node scripts/migrate-to-access-json.mjs --dry-run
 *   node scripts/migrate-to-access-json.mjs --dir /path/to/memory
 *   node scripts/migrate-to-access-json.mjs --clean-md
 */

import { existsSync, readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import { migrateFromMd, readAccess } from "../dist/memory/atom-access.js";
import { shouldSkip } from "../dist/memory/atom-spec.js";

// ── 參數解析 ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const dirArgs = [];
let overwrite = false;
let cleanMd = false;
let dryRun = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--dir") {
    const v = args[++i];
    if (v) dirArgs.push(v);
  } else if (a === "--overwrite") {
    overwrite = true;
  } else if (a === "--clean-md") {
    cleanMd = true;
  } else if (a === "--dry-run") {
    dryRun = true;
  } else if (a === "--help" || a === "-h") {
    console.log(`Usage: node scripts/migrate-to-access-json.mjs [options]

Options:
  --dir <path>     指定要遷移的目錄（可重複）。預設掃 ~/.catclaw
  --overwrite      已存在 .access.json 仍以 .md 值覆寫
  --clean-md       完成後從 .md 移除 Last-used / Confirmations 欄位（有損）
  --dry-run        只列不寫
  -h, --help       顯示此說明
`);
    process.exit(0);
  } else {
    console.error(`unknown argument: ${a}`);
    process.exit(2);
  }
}

// ── atom .md 掃描 ─────────────────────────────────────────────────────────────

/**
 * 額外排除路徑（即使含 MEMORY.md 也不視為 catclaw atom memory root）：
 * - runtime/bridges/ → codex 私有 memory，YAML frontmatter 格式，非 catclaw atom
 */
const EXCLUDE_SUBPATHS = ["runtime/bridges/", "/.codex/", "/codex/memories/"];

function isMemoryRoot(dir) {
  for (const ex of EXCLUDE_SUBPATHS) {
    if (dir.includes(ex)) return false;
  }
  return existsSync(join(dir, "MEMORY.md")) || existsSync(join(dir, "_atom_index.json"));
}

function findMemoryRoots(root, acc = []) {
  let entries;
  try {
    entries = readdirSync(root);
  } catch {
    return acc;
  }
  if (isMemoryRoot(root)) acc.push(root);
  for (const name of entries) {
    if (shouldSkip(name)) continue;
    if (name.startsWith(".")) continue;
    const full = join(root, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) findMemoryRoots(full, acc);
  }
  return acc;
}

function findAtomMdsInMemDir(dir, acc = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const name of entries) {
    if (shouldSkip(name)) continue;
    if (name.startsWith(".")) continue;
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      findAtomMdsInMemDir(full, acc);
    } else if (name.endsWith(".md")) {
      acc.push(full);
    }
  }
  return acc;
}

const scanRoots = dirArgs.length > 0
  ? dirArgs.filter(d => existsSync(d) || (console.error(`[skip] ${d} 不存在`), false))
  : [join(homedir(), ".catclaw")];

const memoryRoots = [];
for (const root of scanRoots) memoryRoots.push(...findMemoryRoots(root));

const allAtoms = [];
for (const memDir of memoryRoots) allAtoms.push(...findAtomMdsInMemDir(memDir));

console.log(`memory roots: ${memoryRoots.length}`);
for (const m of memoryRoots) console.log(`  - ${m}`);
console.log("");

if (allAtoms.length === 0) {
  console.error("沒有找到任何 atom .md");
  process.exit(1);
}

console.log(`掃描到 ${allAtoms.length} 個 atom .md${dryRun ? "（dry-run）" : ""}`);
console.log("");

// ── 從 .md raw 抽 metadata ──────────────────────────────────────────────────

function parseMdMeta(raw) {
  const meta = { lastUsed: undefined, confirmations: undefined, createdAt: undefined };
  const lines = raw.split("\n");
  const contentStartIdx = lines.findIndex((l, i) => i > 0 && l.startsWith("## "));
  const metaLines = contentStartIdx > 0 ? lines.slice(0, contentStartIdx) : lines;
  for (const line of metaLines) {
    const m = line.match(/^-\s+(\w[\w-]*):\s+(.+)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === "last-used") meta.lastUsed = val;
    else if (key === "confirmations") meta.confirmations = parseInt(val, 10) || 0;
    else if (key === "created-at") meta.createdAt = parseInt(val, 10) || undefined;
  }
  return meta;
}

function cleanMdFile(path, raw) {
  const updated = raw
    .replace(/^-\s+Last-used:.*\n?/gm, "")
    .replace(/^-\s+Confirmations:.*\n?/gm, "");
  if (updated !== raw) writeFileSync(path, updated, "utf-8");
  return updated !== raw;
}

// ── 執行 ─────────────────────────────────────────────────────────────────────

let migrated = 0, skipped = 0, cleaned = 0, errored = 0;

for (const atomPath of allAtoms) {
  try {
    const raw = readFileSync(atomPath, "utf-8");
    const meta = parseMdMeta(raw);
    const existing = readAccess(atomPath);

    const shouldWrite =
      !existing ||
      overwrite ||
      (meta.confirmations !== undefined && meta.confirmations > existing.confirmations);

    if (dryRun) {
      const action = !existing ? "create" : shouldWrite ? "overwrite" : "skip";
      console.log(`[dry] ${action}: ${atomPath} (md_confirmations=${meta.confirmations ?? 0})`);
      if (action === "skip") skipped++; else migrated++;
      continue;
    }

    if (shouldWrite) {
      migrateFromMd(atomPath, meta);
      migrated++;
    } else {
      skipped++;
    }

    if (cleanMd) {
      if (cleanMdFile(atomPath, raw)) cleaned++;
    }
  } catch (e) {
    console.error(`[error] ${atomPath}: ${e.message}`);
    errored++;
  }
}

console.log("");
console.log(`═══ 結果：migrated=${migrated}, skipped=${skipped}, cleaned-md=${cleaned}, errored=${errored} ═══`);
process.exit(errored > 0 ? 1 : 0);
