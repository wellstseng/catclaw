/**
 * @file core/agent-types.ts
 * @description Typed Agent 定義 — 為不同用途的 subagent 預設 tool 白名單、system prompt、model 覆寫
 *
 * 參考 Claude Code 的 Agent types：general-purpose, Explore, Plan
 * CatClaw 版本：explore, plan, build, review + 既有 default/coding/acp
 */

// ── Agent Type 介面 ──────────────────────────────────────────────────────────

export interface AgentTypeConfig {
  /** 顯示名稱 */
  label: string;
  /** 可用 tool 白名單（null = 不限制，使用全部） */
  allowedTools: string[] | null;
  /** System prompt 前置區塊 */
  systemPrompt: string;
  /** Model 覆寫（null = 繼承 parent） */
  modelOverride?: string;
  /** 預設 maxTurns */
  defaultMaxTurns: number;
  /** 預設 timeoutMs */
  defaultTimeoutMs: number;
}

// ── 預定義 Agent Types ──────────────────────────────────────────────────────

export const AGENT_TYPES: Record<string, AgentTypeConfig> = {
  // 保留既有 runtime
  default: {
    label: "General Purpose",
    allowedTools: null,
    systemPrompt: "你是一個專門執行子任務的 agent。完成以下任務後請直接回傳結果。",
    defaultMaxTurns: 10,
    defaultTimeoutMs: 120_000,
  },

  coding: {
    label: "Coding",
    allowedTools: ["read_file", "write_file", "edit_file", "run_command", "glob", "grep"],
    systemPrompt: "你是一個程式碼執行 agent。只使用 read/write/edit/bash/glob/grep 工具。不要做社交互動，只做技術任務。",
    defaultMaxTurns: 15,
    defaultTimeoutMs: 180_000,
  },

  // 新增 typed agents
  explore: {
    label: "Explore",
    allowedTools: ["read_file", "glob", "grep"],
    systemPrompt: [
      "你是一個快速探索 codebase 的專用 agent。",
      "目標：找到檔案、搜尋程式碼、回答關於 codebase 的問題。",
      "只使用 read_file / glob / grep 工具。不修改任何檔案。",
      "回報你找到的結果，包含完整檔案路徑和行號。",
    ].join("\n"),
    defaultMaxTurns: 8,
    defaultTimeoutMs: 60_000,
  },

  plan: {
    label: "Plan",
    allowedTools: ["read_file", "glob", "grep"],
    systemPrompt: [
      "你是一個軟體架構規劃 agent。",
      "目標：設計實作計畫、辨識關鍵檔案、考慮架構取捨。",
      "只使用 read_file / glob / grep 工具來理解現有程式碼。不修改任何檔案。",
      "回傳：分步驟的實作計畫 + 需修改的檔案清單 + 風險評估。",
    ].join("\n"),
    defaultMaxTurns: 8,
    defaultTimeoutMs: 90_000,
  },

  build: {
    label: "Build",
    allowedTools: ["read_file", "write_file", "edit_file", "run_command", "glob", "grep"],
    systemPrompt: [
      "你是一個程式碼建構 agent。",
      "目標：根據指定的計畫或需求，實作程式碼變更。",
      "遵守最小變動原則：只改需要改的，不主動重構周圍程式碼。",
      "修改檔案前必須先讀取確認。完成後執行編譯檢查。",
    ].join("\n"),
    defaultMaxTurns: 20,
    defaultTimeoutMs: 300_000,
  },

  review: {
    label: "Review",
    allowedTools: ["read_file", "glob", "grep", "run_command"],
    systemPrompt: [
      "你是一個程式碼審查 agent。",
      "目標：檢查程式碼品質、安全性、正確性。",
      "只使用 read_file / glob / grep / run_command（用於執行測試）。不修改檔案。",
      "回傳：發現的問題清單 + 嚴重性 + 建議修正方式。",
    ].join("\n"),
    defaultMaxTurns: 10,
    defaultTimeoutMs: 120_000,
  },
};

/** 取得 agent type config（fallback to default） */
export function getAgentType(type: string): AgentTypeConfig {
  return AGENT_TYPES[type] ?? AGENT_TYPES["default"]!;
}

/** 列出所有可用 agent types（供 tool_search 或 system prompt 使用） */
export function listAgentTypes(): Array<{ type: string; label: string; description: string }> {
  return Object.entries(AGENT_TYPES).map(([type, cfg]) => ({
    type,
    label: cfg.label,
    description: cfg.systemPrompt.split("\n")[0] ?? "",
  }));
}
