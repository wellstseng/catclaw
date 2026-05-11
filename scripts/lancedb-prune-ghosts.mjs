#!/usr/bin/env node
/**
 * @file scripts/lancedb-prune-ghosts.mjs
 * @description 清理 LanceDB 幽靈索引 — record.path 指向的 atom 檔已不存在則刪除。
 *
 * 使用：
 *   node scripts/lancedb-prune-ghosts.mjs [--dry-run] [--db <path>]
 *
 * Default --db: agent 啟動時的 vectorDbPath，預設掃下列幾個常用位置。
 * --dry-run: 只列出不刪除。
 */

import { connect } from "@lancedb/lancedb";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const dbArgIdx = args.indexOf("--db");
const dbArg = dbArgIdx >= 0 ? args[dbArgIdx + 1] : undefined;

const DEFAULT_DB_PATHS = [
  join(homedir(), ".catclaw/memory/_vectordb"),
  join(homedir(), ".catclaw/_vectordb"),
  join(homedir(), ".catclaw/workspace/_vectordb"),
];

const targets = dbArg ? [dbArg] : DEFAULT_DB_PATHS.filter(p => existsSync(p));

if (targets.length === 0) {
  console.error("找不到 LanceDB 路徑。請傳 --db <path>");
  process.exit(1);
}

let grandTotal = 0;
let grandPruned = 0;

for (const dbPath of targets) {
  console.log(`\n=== ${dbPath} ===`);
  const db = await connect(dbPath);
  const tableNames = await db.tableNames();

  for (const tableName of tableNames) {
    const table = await db.openTable(tableName);
    const total = await table.countRows();
    if (total === 0) continue;

    // 列所有 record 的 id + path（不需 vector）
    const records = await table.query().select(["id", "path"]).limit(total).toArray();
    const ghosts = records.filter(r => {
      const p = r.path;
      return p && typeof p === "string" && !existsSync(p);
    });

    grandTotal += total;
    grandPruned += ghosts.length;

    if (ghosts.length === 0) {
      console.log(`  ${tableName}: ${total} rows, no ghosts`);
      continue;
    }

    console.log(`  ${tableName}: ${total} rows, ${ghosts.length} ghosts ${dryRun ? "(dry-run)" : "→ deleting"}`);

    if (!dryRun) {
      // 批次刪：以 id IN (...) 一次刪
      const ids = ghosts.map(g => `'${String(g.id).replace(/'/g, "''")}'`);
      // LanceDB IN 子句長度需保守，每 200 筆切批
      for (let i = 0; i < ids.length; i += 200) {
        const chunk = ids.slice(i, i + 200);
        await table.delete(`id IN (${chunk.join(",")})`);
      }
    }
  }
}

console.log(`\n總計：${grandTotal} rows，${grandPruned} ghosts ${dryRun ? "(dry-run, 未刪除)" : "已刪除"}`);
