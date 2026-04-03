/**
 * @file skills/builtin/turn-audit.ts
 * @description /turn-audit skill — 查詢 Trace Store
 *
 * 用法：
 *   /turn-audit              → 最近 10 turn 摘要
 *   /turn-audit --last 5     → 最近 5 turn 詳細
 *   /turn-audit --ce         → 只顯示 CE 有觸發的 turns
 */

import type { Skill } from "../types.js";
import { getTraceStore, type MessageTraceEntry } from "../../core/message-trace.js";

function formatTraceSummary(entries: MessageTraceEntry[]): string {
  if (entries.length === 0) return "（無記錄）";

  const lines: string[] = [];
  for (const e of entries) {
    const ts = new Date(e.ts).toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour12: false });
    const dur = e.totalDurationMs > 0 ? `${(e.totalDurationMs / 1000).toFixed(1)}s` : "-";
    const ceStrats = e.contextEngineering?.strategiesApplied ?? [];
    const ce = ceStrats.length > 0 ? `CE:${ceStrats.join("+")}` : "";
    const tok = e.totalInputTokens > 0
      ? `↑${e.totalInputTokens}${e.totalOutputTokens > 0 ? `/↓${e.totalOutputTokens}` : ""}`
      : "";
    const tools = e.totalToolCalls > 0 ? `tools:${e.totalToolCalls}` : "";
    const cost = e.estimatedCostUsd != null ? `$${e.estimatedCostUsd.toFixed(4)}` : "";
    const cat = e.category ? `[${e.category}]` : "";
    const session = e.sessionKey ?? e.channelId;
    const shortSession = session.length > 20 ? `…${session.slice(-17)}` : session;
    const err = e.error ? `❌${e.error.slice(0, 30)}` : "";
    const parts = [ts, cat, shortSession, dur, tok, cost, ce, tools, err].filter(Boolean);
    lines.push(parts.join(" | "));
  }
  return lines.join("\n");
}

export const skill: Skill = {
  name: "turn-audit",
  description: "查詢 Trace Store（token 消耗、CE 觸發、訊息流追蹤）",
  tier: "standard",
  trigger: ["/turn-audit"],

  async execute({ args }) {
    const traceStore = getTraceStore();
    if (!traceStore) return { text: "❌ TraceStore 尚未初始化", isError: true };

    // 解析 flags
    const ceOnly = args.includes("--ce");
    const lastMatch = args.match(/--last\s+(\d+)/);
    const limit = lastMatch ? parseInt(lastMatch[1]!, 10) : 10;

    const filter = ceOnly
      ? (e: MessageTraceEntry) => (e.contextEngineering?.strategiesApplied?.length ?? 0) > 0
      : undefined;

    const entries = traceStore.recent(limit, filter);
    const summary = formatTraceSummary(entries);

    const header = ceOnly
      ? `📊 Trace（CE 觸發，最近 ${limit} 筆）：`
      : `📊 Trace（最近 ${limit} 筆）：`;

    return { text: `${header}\n\`\`\`\n${summary}\n\`\`\`` };
  },
};
