/**
 * @file core/tool-output-store.ts
 * @description Tool result 外部化 store（項目 6）
 *
 * 大型 tool result（≥ threshold）寫入 ~/.catclaw/workspace/data/tool-outputs/
 * 並在 prompt 中只塞 stub（含絕對路徑）。LLM 想看完整內容用 read_file 即可。
 *
 * 設計參考：
 * - 既有 subagent 外部化（agent-loop.ts:1381-1406）：≤8000 字 inline / 超過寫檔
 * - 既有 CE 外部化（context-engine.ts:356-396 externalizeMessage）：safeKey 沿用
 *
 * 與既有兩套並列：
 *   data/subagent-results/{runId}.md     — subagent 結果（既有）
 *   data/externalized/{sessionKey}/...   — CE Level 2 外部化（既有）
 *   data/tool-outputs/{sessionKey}/...   — 本檔（新）
 */

import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { log } from "../logger.js";

export interface ExternalizedToolOutput {
  /** Stub 字串，會塞回 tool_result 的 content */
  stub: string;
  /** 寫檔絕對路徑 */
  filePath: string;
  /** 原始內容 token 估算 */
  originalTokens: number;
}

export interface ExternalizeToolOpts {
  toolName: string;
  /** 原始 tool result 文字 */
  text: string;
  /** Session key（用於目錄分組） */
  sessionKey: string;
  /** 當前 turn / iter 索引（檔名用，不需嚴格對應 session.turnCount） */
  turnIndex: number;
  /** Tool args（用於 stub metadata 與檔名生成） */
  args?: unknown;
}

/** Stub 識別前綴。CE Decay 用此 prefix 跳過已外部化內容。 */
export const TOOL_OUTPUT_STUB_PREFIX = "[tool_result_externalized:";

/** Per-tool 觸發閾值（chars，approximate ×4 估算 tokens）。mcp_* 自動跳過。 */
const EXTERNALIZE_THRESHOLD_DEFAULT_CHARS = 2000 * 4;
const EXTERNALIZE_THRESHOLD_CHARS: Record<string, number> = {
  read_file: 2000 * 4,
  grep: 1500 * 4,
  glob: 1500 * 4,
  run_command: 3000 * 4,
  web_search: 2000 * 4,
};

/** 判斷是否該外部化（不外部化 mcp_* / 小 result / 讀已外部化檔 stub-chain） */
export function shouldExternalizeToolOutput(toolName: string, text: string, args?: unknown): boolean {
  if (!toolName) return false;
  if (toolName.startsWith("mcp_")) return false;
  // 防 stub-chain 連環包：read_file 讀 tool-outputs/ 內已外部化檔 → 跳過再外部化
  // 露米 trace 5b4d8634 / f52fdafa 子 agent 撞過：read_file <path> → 外部化 stub → LLM 看 stub
  // 內容含 tool-outputs/X.txt 路徑 → 又 read_file X.txt → 又被外部化 → 第二層 stub → 重複死循環。
  if (toolName === "read_file" && args && typeof args === "object") {
    const path = String((args as Record<string, unknown>)["path"] ?? (args as Record<string, unknown>)["file_path"] ?? "");
    if (path.includes("tool-outputs")) return false;
  }
  const threshold = EXTERNALIZE_THRESHOLD_CHARS[toolName] ?? EXTERNALIZE_THRESHOLD_DEFAULT_CHARS;
  return text.length >= threshold;
}

function getToolOutputsDir(): string {
  return join(
    process.env["CATCLAW_HOME"] ?? join(homedir(), ".catclaw"),
    "workspace",
    "data",
    "tool-outputs",
  );
}

function safeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function buildStubMetadata(toolName: string, text: string, args: unknown): string {
  const lines = text.split("\n").length;
  const chars = text.length;
  const argsObj = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const sizeKB = (chars / 1024).toFixed(1);

  switch (toolName) {
    case "read_file": {
      const path = String(argsObj["path"] ?? argsObj["file_path"] ?? "");
      return path ? `${path} | ${lines} 行 / ${sizeKB} KB` : `${lines} 行 / ${sizeKB} KB`;
    }
    case "grep": {
      const pattern = String(argsObj["pattern"] ?? "");
      const patternShort = pattern.length > 60 ? pattern.slice(0, 60) + "..." : pattern;
      return patternShort
        ? `"${patternShort}" | ${lines} 行 / ${sizeKB} KB`
        : `${lines} 行 / ${sizeKB} KB`;
    }
    case "glob": {
      const pattern = String(argsObj["pattern"] ?? "");
      return pattern ? `${pattern} | ${lines} files` : `${lines} files`;
    }
    case "run_command": {
      const cmd = String(argsObj["command"] ?? argsObj["cmd"] ?? "");
      const cmdShort = cmd.length > 80 ? cmd.slice(0, 80) + "..." : cmd;
      const exitMatch = text.match(/exit(?:\s*code)?\s*[:=]\s*(-?\d+)/i);
      const exit = exitMatch ? `exit=${exitMatch[1]}, ` : "";
      return cmdShort
        ? `${cmdShort} | ${exit}${lines} 行 / ${sizeKB} KB`
        : `${exit}${lines} 行 / ${sizeKB} KB`;
    }
    case "web_search": {
      const query = String(argsObj["query"] ?? "");
      const queryShort = query.length > 60 ? query.slice(0, 60) + "..." : query;
      return queryShort
        ? `"${queryShort}" | ${lines} 行 / ${sizeKB} KB`
        : `${lines} 行 / ${sizeKB} KB`;
    }
    default:
      return `${lines} 行 / ${sizeKB} KB`;
  }
}

/**
 * 寫檔 + 回傳 stub。
 * 失敗時 throw（caller 可 fallback 到既有 truncation 邏輯）。
 */
export function externalizeToolOutput(opts: ExternalizeToolOpts): ExternalizedToolOutput {
  const dataDir = getToolOutputsDir();
  const sk = safeKey(opts.sessionKey);
  const dir = join(dataDir, sk);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const nonce = randomBytes(2).toString("hex");
  const safeName = opts.toolName.replace(/[^a-zA-Z0-9_-]/g, "_");
  const fileName = `t${opts.turnIndex}-${safeName}-${nonce}.txt`;
  const filePath = join(dir, fileName);

  writeFileSync(filePath, opts.text, "utf-8");

  const meta = buildStubMetadata(opts.toolName, opts.text, opts.args);
  const sizeKB = opts.text.length / 1024;
  const isLargeFile = sizeKB >= 100;
  const guidance = isLargeFile
    ? `如需檢視請呼叫 read_file 讀取——**檔案 ${sizeKB.toFixed(1)} KB 偏大，建議帶 offset/limit 分段讀**（如 offset:1, limit:200），整檔讀會再次被外部化形成 stub 鏈。先用 grep 找關鍵字定位行號，再用 offset/limit 精準取段，最有效率。`
    : `如需檢視請呼叫 read_file 讀取。`;
  const stub =
    `${TOOL_OUTPUT_STUB_PREFIX} ${opts.toolName} | ${meta} | 完整內容 @ ${filePath}]\n` +
    `↑ 上方為 tool_result 的外部化指標（CatClaw 自動截斷）。完整原始輸出已寫入該絕對路徑，` +
    `${guidance}Stub 不含原文，勿從 stub 推測缺失內容。`;

  return {
    stub,
    filePath,
    originalTokens: Math.ceil(opts.text.length / 4),
  };
}

/** 識別字串是否為已外部化 stub（CE Decay 判斷用） */
export function isExternalizedStub(text: string): boolean {
  return typeof text === "string" && text.startsWith(TOOL_OUTPUT_STUB_PREFIX);
}

/**
 * 清理特定 session 的 tool-outputs（session.delete 觸發，項目 6 補洞）。
 * 不管 TTL，整個 session 目錄底下的檔全刪。
 */
export function cleanupToolOutputsForSession(sessionKey: string): { cleaned: number; freedBytes: number } {
  const dataDir = getToolOutputsDir();
  const sk = safeKey(sessionKey);
  const sessionPath = join(dataDir, sk);
  if (!existsSync(sessionPath)) return { cleaned: 0, freedBytes: 0 };
  let cleaned = 0;
  let freedBytes = 0;
  try {
    for (const file of readdirSync(sessionPath)) {
      const filePath = join(sessionPath, file);
      try {
        const stat = statSync(filePath);
        freedBytes += stat.size;
        unlinkSync(filePath);
        cleaned++;
      } catch {
        /* 靜默 */
      }
    }
  } catch (err) {
    log.warn(`[tool-output-store] session cleanup 失敗 ${sessionKey}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (cleaned > 0) {
    log.debug(
      `[tool-output-store] session ${sessionKey} 清 ${cleaned} 個 tool-output，釋放 ${(freedBytes / 1024).toFixed(1)} KB`,
    );
  }
  return { cleaned, freedBytes };
}

/** 清理過期 tool-output 檔。預設 14 天。回傳清理數量與釋放位元組。 */
export function cleanupToolOutputs(ttlDays = 14): { cleaned: number; freedBytes: number } {
  const dataDir = getToolOutputsDir();
  if (!existsSync(dataDir)) return { cleaned: 0, freedBytes: 0 };

  const cutoff = Date.now() - ttlDays * 86_400_000;
  let cleaned = 0;
  let freedBytes = 0;

  for (const sessionDir of readdirSync(dataDir)) {
    const sessionPath = join(dataDir, sessionDir);
    try {
      const stat = statSync(sessionPath);
      if (!stat.isDirectory()) continue;
    } catch {
      continue;
    }

    for (const file of readdirSync(sessionPath)) {
      const filePath = join(sessionPath, file);
      try {
        const stat = statSync(filePath);
        if (stat.mtimeMs < cutoff) {
          freedBytes += stat.size;
          unlinkSync(filePath);
          cleaned++;
        }
      } catch (err) {
        log.warn(
          `[tool-output-store] cleanup 跳過 ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  if (cleaned > 0) {
    log.info(
      `[tool-output-store] 清理 ${cleaned} 個過期 tool-output 檔，釋放 ${(freedBytes / 1024).toFixed(1)} KB`,
    );
  }
  return { cleaned, freedBytes };
}
