/**
 * @file tools/builtin/glob.ts
 * @description glob 工具 — 按模式搜尋檔案路徑（tier=elevated）
 *
 * 支援：** (任意層級)、* (單層萬用)、? (單字元)、{a,b} (選擇)
 * 結果按修改時間降序排列（最新在前）
 */

import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { log } from "../../logger.js";
import type { Tool, ToolContext, ToolResult } from "../types.js";

// ── 模式轉換 ──────────────────────────────────────────────────────────────────

function globToRegex(pattern: string): RegExp {
  let regexStr = pattern
    .replace(/[.+^$|[\]\\]/g, "\\$&")              // escape 特殊 regex 字元（保留 {}?*）
    .replace(/\{([^}]+)\}/g, (_, g) => `(${(g as string).split(",").map((s: string) => s.trim().replace(/[.+^$|[\]\\]/g, "\\$&")).join("|")})`)
    .replace(/\*\*\//g, "__DS_SLASH__")              // **/ 暫存（可對應零個目錄層）
    .replace(/\*\*/g, "__DS__")                      // ** 暫存（任意字串）
    .replace(/\*/g, "[^/]*")                         // * = 不含 /
    .replace(/\?/g, "[^/]")                          // ? = 不含 /
    .replace(/__DS_SLASH__/g, "(.*/)?")              // **/ = 零到多層目錄
    .replace(/__DS__/g, ".*");                       // ** = 任意字串

  return new RegExp(`^${regexStr}$`);
}

// ── 遞迴掃描 ─────────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set(["node_modules", ".git", ".svn", "dist", ".cache"]);
const MAX_FILES = 1000;

async function scanDir(
  dir: string,
  baseDir: string,
  re: RegExp,
  results: Array<{ path: string; mtimeMs: number }>,
): Promise<void> {
  if (results.length >= MAX_FILES) return;

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (results.length >= MAX_FILES) break;

    const fullPath = join(dir, entry);
    const relPath = relative(baseDir, fullPath);

    let st;
    try { st = await stat(fullPath); } catch { continue; }

    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(entry)) await scanDir(fullPath, baseDir, re, results);
    } else if (re.test(relPath)) {
      results.push({ path: fullPath, mtimeMs: st.mtimeMs });
    }
  }
}

// ── Tool 定義 ─────────────────────────────────────────────────────────────────

export const tool: Tool = {
  name: "glob",
  description: "按 glob 模式搜尋檔案路徑。支援 **、*、?、{a,b}。結果按修改時間降序排列，上限 1000 筆。",
  tier: "elevated",
  resultTokenCap: 500,
  concurrencySafe: true,
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "glob 模式，例如 **/*.ts 或 src/**/*.{ts,js}",
      },
      path: {
        type: "string",
        description: "搜尋的根目錄（絕對路徑，預設為當前工作目錄）",
      },
      offset: {
        type: "number",
        description: "跳過前 N 筆結果（預設 0）。分頁用。",
      },
      limit: {
        type: "number",
        description: `本次回傳筆數上限（預設 ${MAX_FILES}；0 = 不限但仍受硬上限 ${MAX_FILES} 保護）`,
      },
    },
    required: ["pattern"],
  },

  async execute(params: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const pattern = String(params["pattern"] ?? "");
    const baseDir = String(params["path"] ?? process.cwd());
    const offsetRaw = Number(params["offset"] ?? 0);
    const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? Math.floor(offsetRaw) : 0;
    const limitRaw = Number(params["limit"] ?? MAX_FILES);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0
      ? Math.min(Math.floor(limitRaw), MAX_FILES)
      : MAX_FILES;

    if (!pattern) return { error: "pattern 不能為空" };

    const re = globToRegex(pattern);
    const results: Array<{ path: string; mtimeMs: number }> = [];

    try {
      await scanDir(baseDir, baseDir, re, results);
    } catch (err) {
      return { error: `掃描失敗：${err instanceof Error ? err.message : String(err)}` };
    }

    // 按修改時間降序
    results.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const allPaths = results.map(r => r.path);
    const paged = allPaths.slice(offset, offset + limit);
    const hasMore = allPaths.length > offset + limit;
    const scannedCapHit = allPaths.length >= MAX_FILES;

    log.debug(`[glob] pattern=${pattern} base=${baseDir} offset=${offset} limit=${limit} → ${paged.length} 筆 (total=${allPaths.length}, hasMore=${hasMore})`);

    return {
      result: {
        paths: paged,
        offset,
        returned: paged.length,
        total: allPaths.length,
        hasMore,
        scannedCapHit,
        nextOffset: hasMore ? offset + paged.length : null,
        hint: hasMore
          ? `仍有 ${allPaths.length - offset - paged.length} 筆結果未顯示。續讀請帶 offset=${offset + paged.length}；縮小結果請用更精確的 pattern。${scannedCapHit ? `（已觸及硬上限 ${MAX_FILES} 筆，需縮小 pattern 才能探得尾段）` : ""}`
          : undefined,
      },
    };
  },
};
