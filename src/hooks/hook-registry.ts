/**
 * @file hooks/hook-registry.ts
 * @description Hook Registry — 載入、索引、鏈式執行 hooks
 *
 * 鏈式規則：
 * - PreToolUse：依序執行，第一個 block 即中止。modify 可改 params，傳遞給下一個 hook。
 * - PostToolUse：依序執行，modify 可改 result。
 * - SessionStart / SessionEnd：fire-and-await（錯誤不拋出）。
 */

import { log } from "../logger.js";
import { runHook } from "./hook-runner.js";
import type {
  HookDefinition, HookEvent, HookAction,
  PreToolUseInput, PostToolUseInput, SessionStartInput, SessionEndInput,
} from "./types.js";

export class HookRegistry {
  private hooks = new Map<HookEvent, HookDefinition[]>();

  constructor(definitions: HookDefinition[]) {
    this._index(definitions);
  }

  /** 重新載入 hook 定義（config hot-reload） */
  reload(definitions: HookDefinition[]): void {
    this._index(definitions);
    log.info(`[hook-registry] 重新載入 ${definitions.length} 個 hooks`);
  }

  private _index(definitions: HookDefinition[]): void {
    this.hooks.clear();
    for (const def of definitions) {
      if (def.enabled === false) continue;
      const list = this.hooks.get(def.event) ?? [];
      list.push(def);
      this.hooks.set(def.event, list);
    }
    const counts = Array.from(this.hooks.entries())
      .map(([event, list]) => `${event}=${list.length}`)
      .join(", ");
    if (counts) log.info(`[hook-registry] 已載入 hooks: ${counts}`);
  }

  /** 取得指定事件的 hook 數量 */
  count(event: HookEvent): number {
    return this.hooks.get(event)?.length ?? 0;
  }

  // ── PreToolUse ──────────────────────────────────────────────────────────────

  async runPreToolUse(input: PreToolUseInput): Promise<
    | { blocked: false; params: Record<string, unknown> }
    | { blocked: true; reason: string }
  > {
    const hooks = this._matchToolHooks("PreToolUse", input.toolName);
    if (hooks.length === 0) return { blocked: false, params: input.toolParams };

    let params = { ...input.toolParams };

    for (const hook of hooks) {
      const result = await runHook(
        hook.command,
        { ...input, toolParams: params },
        hook.timeoutMs,
      );

      log.debug(`[hook-registry] PreToolUse "${hook.name}" → ${result.action} (tool=${input.toolName})`);

      if (result.action === "block") {
        return { blocked: true, reason: (result as { reason: string }).reason ?? `Hook "${hook.name}" 阻擋` };
      }
      if (result.action === "modify" && (result as { params?: Record<string, unknown> }).params) {
        params = (result as { params: Record<string, unknown> }).params;
      }
      // allow / passthrough → 繼續下一個 hook
    }

    return { blocked: false, params };
  }

  // ── PostToolUse ─────────────────────────────────────────────────────────────

  async runPostToolUse(input: PostToolUseInput): Promise<{
    result?: unknown;
    error?: string;
  }> {
    const hooks = this._matchToolHooks("PostToolUse", input.toolName);
    if (hooks.length === 0) return input.toolResult;

    let result = { ...input.toolResult };

    for (const hook of hooks) {
      const action = await runHook(
        hook.command,
        { ...input, toolResult: result },
        hook.timeoutMs,
      );

      log.debug(`[hook-registry] PostToolUse "${hook.name}" → ${action.action} (tool=${input.toolName})`);

      if (action.action === "modify") {
        const mod = action as { result?: unknown; error?: string };
        if (mod.result !== undefined) result = { ...result, result: mod.result };
      }
    }

    return result;
  }

  // ── SessionStart ────────────────────────────────────────────────────────────

  async runSessionStart(input: SessionStartInput): Promise<void> {
    const hooks = this.hooks.get("SessionStart") ?? [];
    for (const hook of hooks) {
      try {
        await runHook(hook.command, input, hook.timeoutMs);
        log.debug(`[hook-registry] SessionStart "${hook.name}" 完成`);
      } catch (err) {
        log.warn(`[hook-registry] SessionStart "${hook.name}" 失敗：${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // ── SessionEnd ──────────────────────────────────────────────────────────────

  async runSessionEnd(input: SessionEndInput): Promise<void> {
    const hooks = this.hooks.get("SessionEnd") ?? [];
    for (const hook of hooks) {
      try {
        await runHook(hook.command, input, hook.timeoutMs);
        log.debug(`[hook-registry] SessionEnd "${hook.name}" 完成`);
      } catch (err) {
        log.warn(`[hook-registry] SessionEnd "${hook.name}" 失敗：${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // ── 內部：依 toolFilter 過濾匹配的 hooks ──────────────────────────────────

  private _matchToolHooks(event: "PreToolUse" | "PostToolUse", toolName: string): HookDefinition[] {
    const hooks = this.hooks.get(event) ?? [];
    return hooks.filter(h => {
      if (!h.toolFilter || h.toolFilter.length === 0) return true;
      return h.toolFilter.includes(toolName);
    });
  }
}

// ── 全域單例 ──────────────────────────────────────────────────────────────────

let _hookRegistry: HookRegistry | null = null;

export function initHookRegistry(definitions: HookDefinition[]): HookRegistry {
  _hookRegistry = new HookRegistry(definitions);
  return _hookRegistry;
}

export function getHookRegistry(): HookRegistry | null {
  return _hookRegistry;
}
