/**
 * @file tools/builtin/grep.ts
 * @description grep 工具 — 在檔案內容中搜尋正規表達式（tier=elevated）
 *
 * 支援：pattern（正規表達式）、path（根目錄）、glob（檔案過濾）、-i（大小寫不敏感）
 * 輸出：含行號的匹配行（最多 200 筆），按檔案排序
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { log } from "../../logger.js";
import type { Tool, ToolContext, ToolResult } from "../types.js";

// ── 工具函式 ──────────────────────────────────────────────────────────────────

function globToRegex(pattern: string): RegExp {
  const regexStr = pattern
    .replace(/[.+^$|[\]\\]/g, "\\$&")
    .replace(/\{([^}]+)\}/g, (_, g) => `(${g.split(",").map((s: string) => s.trim()).join("|")})`)
    .replace(/\*\*/g, "__DS__")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/__DS__/g, ".*");
  return new RegExp(`^${regexStr}$`);
}

const SKIP_DIRS = new Set(["node_modules", ".git", ".svn", "dist", ".cache"]);
const MAX_RESULTS = 200;
const MAX_FILE_SIZE = 1024 * 1024; // 1MB

async function collectFiles(dir: string, fileRe: RegExp | null, files: string[]): Promise<void> {
  let entries: string[];
  try { entries = await readdir(dir); } catch { return; }

  for (const entry of entries) {
    if (files.length > MAX_RESULTS * 10) break;
    const fullPath = join(dir, entry);
    let st;
    try { st = await stat(fullPath); } catch { continue; }
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(entry)) await collectFiles(fullPath, fileRe, files);
    } else if (!fileRe || fileRe.test(entry)) {
      if (st.size <= MAX_FILE_SIZE) files.push(fullPath);
    }
  }
}

interface GrepMatch {
  file: string;
  line: number;
  text: string;
}

// ── Tool 定義 ─────────────────────────────────────────────────────────────────

export const tool: Tool = {
  name: "grep",
  description: "在檔案內容中搜尋正規表達式。支援 -i（大小寫不敏感）、glob 檔案過濾、offset/head_limit 分頁。",
  tier: "elevated",
  resultTokenCap: 2000,
  concurrencySafe: true,
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "要搜尋的正規表達式（例如 class\\s+Foo 或 import.*from）",
      },
      path: {
        type: "string",
        description: "搜尋根目錄（預設為當前工作目錄）",
      },
      glob: {
        type: "string",
        description: "過濾檔名的 glob 模式（例如 *.ts 或 *.{ts,js}）",
      },
      "-i": {
        type: "boolean",
        description: "大小寫不敏感（預設 false）",
      },
      offset: {
        type: "number",
        description: "跳過前 N 筆匹配（預設 0）。分頁用。",
      },
      head_limit: {
        type: "number",
        description: `本次回傳的匹配上限（預設 ${MAX_RESULTS}；0 = 不限但仍受硬上限 ${MAX_RESULTS} 保護）`,
      },
    },
    required: ["pattern"],
  },

  async execute(params: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const pattern = String(params["pattern"] ?? "");
    const baseDir = String(params["path"] ?? process.cwd());
    const globPattern = params["glob"] ? String(params["glob"]) : null;
    const caseInsensitive = Boolean(params["-i"] ?? false);
    const offsetRaw = Number(params["offset"] ?? 0);
    const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? Math.floor(offsetRaw) : 0;
    const headLimitRaw = Number(params["head_limit"] ?? MAX_RESULTS);
    const headLimit = Number.isFinite(headLimitRaw) && headLimitRaw > 0
      ? Math.min(Math.floor(headLimitRaw), MAX_RESULTS)
      : MAX_RESULTS;

    if (!pattern) return { error: "pattern 不能為空" };

    let searchRe: RegExp;
    try {
      searchRe = new RegExp(pattern, caseInsensitive ? "i" : undefined);
    } catch (err) {
      return { error: `無效的正規表達式：${err instanceof Error ? err.message : String(err)}` };
    }

    const fileRe = globPattern ? globToRegex(globPattern) : null;
    const files: string[] = [];

    try {
      await collectFiles(baseDir, fileRe, files);
    } catch (err) {
      return { error: `掃描失敗：${err instanceof Error ? err.message : String(err)}` };
    }

    // 收集到 offset+headLimit+1 就可以停（+1 用於判定 hasMore），但仍受 MAX_RESULTS 硬上限
    const collectTarget = Math.min(offset + headLimit + 1, MAX_RESULTS);
    const allMatches: GrepMatch[] = [];

    for (const filePath of files) {
      if (allMatches.length >= collectTarget) break;
      let content: string;
      try { content = await readFile(filePath, "utf-8"); } catch { continue; }

      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (allMatches.length >= collectTarget) break;
        if (searchRe.test(lines[i]!)) {
          allMatches.push({ file: filePath, line: i + 1, text: lines[i]!.slice(0, 300) });
        }
      }
    }

    const paged = allMatches.slice(offset, offset + headLimit);
    const hasMore = allMatches.length > offset + headLimit;
    const scannedCapHit = allMatches.length >= MAX_RESULTS;

    log.debug(`[grep] pattern=${pattern} offset=${offset} head_limit=${headLimit} → ${paged.length} 筆 (hasMore=${hasMore})`);

    return {
      result: {
        matches: paged,
        offset,
        returned: paged.length,
        hasMore,
        scannedCapHit,
        nextOffset: hasMore ? offset + paged.length : null,
        hint: hasMore
          ? `仍有更多匹配。續讀請帶 offset=${offset + paged.length}；縮小結果請用更精確的 pattern 或 glob 過濾。${scannedCapHit ? `（已觸及硬上限 ${MAX_RESULTS} 筆，需縮小 pattern 才能探得尾段）` : ""}`
          : undefined,
      },
    };
  },
};
