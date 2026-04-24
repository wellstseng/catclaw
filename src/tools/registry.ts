/**
 * @file tools/registry.ts
 * @description Tool 註冊表 — 自動掃描目錄、register/execute、hot-reload
 *
 * 啟動時掃描目錄，找到 export `tool` 的檔案自動註冊。
 * fs.watch 監聽目錄，檔案新增/修改後重新載入（hot-reload）。
 */

import { readdirSync, watch } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { log } from "../logger.js";
import type { Tool, ToolDefinition, ToolContext, ToolResult } from "./types.js";
import { toDefinition } from "./types.js";

// ── ToolRegistry ──────────────────────────────────────────────────────────────

/** tool 執行超過此時間時發軟警告 log */
const SOFT_WARN_MS = 60_000;
/** 絕對安全閥：即使 tool 自己宣告無逾時，也強制在此時間後中斷（10 分鐘） */
const ABSOLUTE_HARD_LIMIT_MS = 600_000;

export class ToolRegistry {
  private tools = new Map<string, Tool>();
  private watchers: ReturnType<typeof watch>[] = [];
  private defaultTimeoutMs: number;

  constructor(opts?: { defaultTimeoutMs?: number }) {
    // 0 = 不逾時（預設），tool 內部自己決定中斷時機
    this.defaultTimeoutMs = opts?.defaultTimeoutMs ?? 0;
  }

  // ── 註冊 ────────────────────────────────────────────────────────────────────

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
    log.debug(`[tool-registry] 已註冊 ${tool.name} (tier=${tool.tier})`);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  all(): Tool[] {
    return Array.from(this.tools.values());
  }

  // ── 自動掃描目錄 ──────────────────────────────────────────────────────────

  /**
   * 掃描目錄下所有 .js 檔，載入 export `tool` 的模組
   * （dist/ 目錄，tsc 已編譯）
   */
  async loadFromDirectory(dir: string): Promise<void> {
    const absDir = resolve(dir);
    let files: string[];
    try {
      files = readdirSync(absDir).filter(f => f.endsWith(".js"));
    } catch {
      log.debug(`[tool-registry] 目錄不存在，跳過：${absDir}`);
      return;
    }

    let registered = 0;
    for (const file of files) {
      if (await this.loadFile(join(absDir, file))) registered++;
    }
    log.info(`[tool-registry] 從 ${absDir} 載入 ${registered}/${files.length} 個 tool`);
  }

  private async loadFile(filePath: string): Promise<boolean> {
    try {
      // ESM dynamic import — 用 pathToFileURL 確保 Windows 路徑正確
      const fileUrl = pathToFileURL(filePath);
      fileUrl.searchParams.set("t", String(Date.now()));
      const mod = await import(fileUrl.href);
      if (mod.tool && typeof mod.tool.execute === "function") {
        this.register(mod.tool as Tool);
        return true;
      }
      return false;
    } catch (err) {
      log.warn(`[tool-registry] 載入 ${filePath} 失敗：${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  // ── Hot-reload ─────────────────────────────────────────────────────────────

  watchDirectory(dir: string): void {
    const absDir = resolve(dir);
    try {
      const watcher = watch(absDir, async (eventType, filename) => {
        if (!filename?.endsWith(".js")) return;
        log.debug(`[tool-registry] 偵測到變更：${filename}，重新載入`);
        await this.loadFile(join(absDir, filename));
      });
      this.watchers.push(watcher);
    } catch {
      log.debug(`[tool-registry] 無法監聽 ${absDir}`);
    }
  }

  stopWatching(): void {
    for (const w of this.watchers) w.close();
    this.watchers = [];
  }

  // ── 執行 ────────────────────────────────────────────────────────────────────

  async execute(toolName: string, params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(toolName);
    if (!tool) return { error: `找不到 tool: ${toolName}` };

    // 計算 effective timeout（per-tool 優先，0 = 無限制）
    const effectiveMs = tool.timeoutMs ?? this.defaultTimeoutMs;

    // 絕對上限：effectiveMs<=0 或過大時，fallback 到 ABSOLUTE_HARD_LIMIT_MS
    // 防止 tool 誤設 timeoutMs=0 導致 turn 卡死無法回復
    const guardedMs = (effectiveMs > 0 && effectiveMs <= ABSOLUTE_HARD_LIMIT_MS)
      ? effectiveMs
      : ABSOLUTE_HARD_LIMIT_MS;

    try {
      let warnTimer: ReturnType<typeof setTimeout> | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      warnTimer = setTimeout(() => {
        log.warn(`[tool-registry] 工具執行時間過長 tool=${toolName} 已超過 ${SOFT_WARN_MS}ms（仍在執行，將在 ${guardedMs}ms 硬中斷）`);
      }, SOFT_WARN_MS);

      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          // 安全：不在 error 訊息中暴露 toolName 或 params
          reject(new Error(`工具執行逾時（${guardedMs}ms）`));
        }, guardedMs);
      });

      try {
        const result = await Promise.race([tool.execute(params, ctx), timeoutPromise]);
        return result;
      } finally {
        clearTimeout(timer);
        clearTimeout(warnTimer);
      }
    } catch (err) {
      // timeout 或執行錯誤統一由此 catch 轉換
      const msg = err instanceof Error ? err.message : String(err);
      // server log 記錄詳細資訊（不外洩）
      log.warn(`[tool-registry] execute 失敗 tool=${toolName}：${msg}`);

      // ToolTimeout hook（observer）
      if (msg.includes("逾時")) {
        try {
          const { getHookRegistry } = await import("../hooks/hook-registry.js");
          const hookReg = getHookRegistry();
          if (hookReg && hookReg.count("ToolTimeout", ctx.agentId) > 0) {
            await hookReg.runToolTimeout({
              event: "ToolTimeout",
              toolName,
              toolParams: params,
              timeoutMs: guardedMs,
              agentId: ctx.agentId,
              accountId: ctx.accountId,
            });
          }
        } catch { /* ignore */ }
      }

      return { error: msg };
    }
  }

  // ── ToolDefinition 清單（傳給 LLM）────────────────────────────────────────

  definitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map(toDefinition);
  }
}

// ── 全域單例 ──────────────────────────────────────────────────────────────────

let _registry: ToolRegistry | null = null;

export function initToolRegistry(opts?: { defaultTimeoutMs?: number }): ToolRegistry {
  _registry = new ToolRegistry(opts);
  return _registry;
}

export function getToolRegistry(): ToolRegistry {
  if (!_registry) throw new Error("[tool-registry] 尚未初始化，請先呼叫 initToolRegistry()");
  return _registry;
}

export function resetToolRegistry(): void {
  _registry?.stopWatching();
  _registry = null;
}
