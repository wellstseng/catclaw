/**
 * @file hooks/types.ts
 * @description Hook 系統型別定義
 *
 * Hook = 外部 shell command，在 agent-loop 的關鍵時機點執行。
 * 設計參考 Claude Code 的 PreToolUse / PostToolUse hooks。
 *
 * 四個事件點：
 * - PreToolUse：tool 執行前，可 allow/block/modify
 * - PostToolUse：tool 執行後，可 modify result 或觸發副作用
 * - SessionStart：session 建立時
 * - SessionEnd：session 結束時
 */

// ── Hook Event 類型 ─────────────────────────────────────────────────────────

export type HookEvent = "PreToolUse" | "PostToolUse" | "SessionStart" | "SessionEnd";

// ── Hook 輸入（寫入 stdin 的 JSON）─────────────────────────────────────────

export interface PreToolUseInput {
  event: "PreToolUse";
  toolName: string;
  toolParams: Record<string, unknown>;
  accountId: string;
  sessionKey: string;
  channelId: string;
  toolTier: string;
}

export interface PostToolUseInput {
  event: "PostToolUse";
  toolName: string;
  toolParams: Record<string, unknown>;
  toolResult: { result?: unknown; error?: string };
  durationMs: number;
  accountId: string;
  sessionKey: string;
  channelId: string;
}

export interface SessionStartInput {
  event: "SessionStart";
  sessionKey: string;
  accountId: string;
  channelId: string;
}

export interface SessionEndInput {
  event: "SessionEnd";
  sessionKey: string;
  accountId: string;
  channelId: string;
  turnCount: number;
}

export type HookInput = PreToolUseInput | PostToolUseInput | SessionStartInput | SessionEndInput;

// ── Hook 輸出（從 stdout 讀取的 JSON）──────────────────────────────────────

export type HookAction =
  | { action: "allow" }
  | { action: "block"; reason: string }
  | { action: "modify"; params?: Record<string, unknown>; result?: unknown }
  | { action: "passthrough" };

// ── Hook 定義（config 設定）──────────────────────────────────────────────────

export interface HookDefinition {
  /** Hook 名稱（用於 log 識別） */
  name: string;
  /** 觸發事件 */
  event: HookEvent;
  /** Shell command（接收 stdin JSON，回傳 stdout JSON） */
  command: string;
  /** 超時毫秒（預設 5000） */
  timeoutMs?: number;
  /** 只在指定 tool 時觸發（PreToolUse / PostToolUse 專用） */
  toolFilter?: string[];
  /** 是否啟用（預設 true） */
  enabled?: boolean;
}
