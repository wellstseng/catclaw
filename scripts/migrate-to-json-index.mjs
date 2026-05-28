#!/usr/bin/env node
/**
 * V5 P3b — 一次性遷移：所有 MEMORY.md → _atom_index.json
 *
 * 掃描範圍：
 *   1. CLI 參數 --dir <path>（可多次重複）→ 指定目錄
 *   2. 預設掃 ~/.catclaw 下所有含 MEMORY.md 的目錄（排除 node_modules / .git）
 *
 * 行為：
 *   - 對每個目錄呼叫 migrateMdToJson（idempotent，已存在 JSON 預設跳過）
 *   - --overwrite：強制重新從 MEMORY.md 產生（會覆蓋既有 JSON）
 *   - 完成後對每個 JSON 跑 validateIndex，列出錯誤
 *
 * 用法：
 *   node scripts/migrate-to-json-index.mjs                          # 預設掃 ~/.catclaw
 *   node scripts/migrate-to-json-index.mjs --dir /path/to/memory   # 指定目錄
 *   node scripts/migrate-to-json-index.mjs --overwrite             # 強制覆寫
 *   node scripts/migrate-to-json-index.mjs --dry-run               # 只列要做什麼，不寫檔
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  migrateMdToJson,
  validateIndex,
  loadAtomIndexJson,
} from "../dist/memory/atom-index-json.js";

// ── 參數解析 ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const dirArgs = [];
let overwrite = false;
let dryRun = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--dir") {
    const v = args[++i];
    if (v) dirArgs.push(v);
  } else if (a === "--overwrite") {
    overwrite = true;
  } else if (a === "--dry-run") {
    dryRun = true;
  } else if (a === "--help" || a === "-h") {
    console.log(`Usage: node scripts/migrate-to-json-index.mjs [options]

Options:
  --dir <path>     指定要遷移的目錄（可重複）。預設掃 ~/.catclaw 下所有 MEMORY.md
  --overwrite      覆寫既有 _atom_index.json（預設 idempotent skip）
  --dry-run        只列要做什麼，不寫檔
  -h, --help       顯示此說明
`);
    process.exit(0);
  } else {
    console.error(`unknown argument: ${a}`);
    process.exit(2);
  }
}

// ── 目錄掃描 ─────────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set(["node_modules", ".git", "_vectordb", "tmp", "dist"]);

function findMemoryDirs(root, acc = []) {
  let entries;
  try {
    entries = readdirSync(root);
  } catch {
    return acc;
  }
  // 若本層含 MEMORY.md，視為記憶目錄
  if (entries.includes("MEMORY.md")) acc.push(root);
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    if (name.startsWith(".")) continue;
    const full = join(root, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) findMemoryDirs(full, acc);
  }
  return acc;
}

const targets = dirArgs.length > 0
  ? dirArgs.filter(d => {
      if (!existsSync(d)) {
        console.error(`[skip] ${d} 不存在`);
        return false;
      }
      return true;
    })
  : findMemoryDirs(join(homedir(), ".catclaw"));

if (targets.length === 0) {
  console.error("沒有找到任何 MEMORY.md 目錄");
  process.exit(1);
}

console.log(`找到 ${targets.length} 個 memory 目錄${dryRun ? "（dry-run）" : ""}：`);
for (const d of targets) console.log(`  - ${d}`);
console.log("");

// ── 執行 migration ───────────────────────────────────────────────────────────

let migrated = 0;
let skipped = 0;
let errored = 0;
const validationErrors = [];

for (const dir of targets) {
  const jsonPath = join(dir, "_atom_index.json");
  const exists = existsSync(jsonPath);
  const action = exists && !overwrite ? "skip" : (exists ? "overwrite" : "create");

  if (dryRun) {
    console.log(`[dry] ${action}: ${jsonPath}`);
    if (action === "skip") skipped++; else migrated++;
    continue;
  }

  try {
    const before = exists ? loadAtomIndexJson(dir).atoms.length : 0;
    const data = migrateMdToJson(dir, { overwrite });
    const after = data.atoms.length;
    if (action === "skip") {
      console.log(`[skip] ${jsonPath}（已存在，${after} atoms）`);
      skipped++;
    } else {
      console.log(`[${action}] ${jsonPath}（${before} → ${after} atoms）`);
      migrated++;
    }

    const errs = validateIndex(dir);
    if (errs.length > 0) {
      validationErrors.push({ dir, errors: errs });
    }
  } catch (e) {
    console.error(`[error] ${dir}: ${e.message}`);
    errored++;
  }
}

console.log("");
console.log(`═══ 結果：migrated=${migrated}, skipped=${skipped}, errored=${errored} ═══`);

if (validationErrors.length > 0) {
  console.error("");
  console.error("Schema validation 錯誤：");
  for (const { dir, errors } of validationErrors) {
    console.error(`  ${dir}:`);
    for (const e of errors) console.error(`    - ${e}`);
  }
  process.exit(1);
}

process.exit(errored > 0 ? 1 : 0);
