/**
 * @file hooks/sdk.ts
 * @description Hook 開發 SDK — defineHook 型別安全 helper
 *
 * Agent 寫 TS hook 時匯入此 module：
 *
 * ```ts
 * import { defineHook } from "../../sdk.js";
 *
 * export default defineHook({
 *   event: "PreToolUse",
 *   toolFilter: ["run_command"],
 * }, async (input) => {
 *   if (String(input.toolParams.command).includes("rm -rf")) {
 *     return { action: "block", reason: "dangerous" };
 *   }
 *   return { action: "allow" };
 * });
 * ```
 *
 * Scanner 載入時讀 default export 的 metadata；
 * hook-runtime.ts 觸發時呼叫 handler。
 */

import type { HookEvent, HookInputMap, HookAction } from "./types.js";

/** Hook 檔內 metadata（不含 name；name 由 scanner 取自檔名） */
export interface HookMetadata<E extends HookEvent = HookEvent> {
  event: E;
  toolFilter?: string[];
  timeoutMs?: number;
  enabled?: boolean;
}

/** Hook handler 簽名（依 event 推導 input 型別） */
export type HookHandler<E extends HookEvent> = (
  input: HookInputMap[E],
) => Promise<HookAction> | HookAction;

/** 已定義的 hook（default export 結構） */
export interface DefinedHook<E extends HookEvent = HookEvent> {
  __catclawHook: true;
  metadata: HookMetadata<E>;
  handler: HookHandler<E>;
}

/**
 * 定義一個 hook
 *
 * @param metadata 事件 + filter + timeout
 * @param handler 處理函式（input → HookAction）
 * @returns Default export 結構
 */
export function defineHook<E extends HookEvent>(
  metadata: HookMetadata<E>,
  handler: HookHandler<E>,
): DefinedHook<E> {
  return {
    __catclawHook: true,
    metadata,
    handler,
  };
}

/** Type guard：檢查 default export 是否為合法 DefinedHook */
export function isDefinedHook(value: unknown): value is DefinedHook {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { __catclawHook?: unknown }).__catclawHook === true &&
    typeof (value as { metadata?: unknown }).metadata === "object" &&
    typeof (value as { handler?: unknown }).handler === "function"
  );
}
