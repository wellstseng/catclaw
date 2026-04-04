/**
 * @file hooks/index.ts
 * @description Hook 系統公開介面
 */

export type { HookEvent, HookInput, HookAction, HookDefinition } from "./types.js";
export type { PreToolUseInput, PostToolUseInput, SessionStartInput, SessionEndInput } from "./types.js";
export { runHook } from "./hook-runner.js";
export { HookRegistry, initHookRegistry, getHookRegistry } from "./hook-registry.js";
