/**
 * @file skills/builtin/usage.ts
 * @description /usage skill — token 消耗統計（讀 TraceStore）
 *
 * 用法：
 *   /usage              → 今日統計（含 CE 效果）
 *   /usage --days 7     → 最近 7 天
 *   /usage --session    → 依 session 分組
 */

import type { Skill } from "../types.js";
import { getTraceStore, type MessageTraceEntry } from "../../core/message-trace.js";

export const skill: Skill = {
  name: "usage",
  description: "查詢 token 消耗統計與 CE 壓縮效果",
  tier: "standard",
  trigger: ["/usage"],

  async execute({ args }) {
    const traceStore = getTraceStore();
    if (!traceStore) return { text: "❌ TraceStore 尚未初始化", isError: true };

    // 解析 flags
    const daysMatch = args.match(/--days\s+(\d+)/);
    const days = daysMatch ? parseInt(daysMatch[1]!, 10) : 1;
    const bySession = args.includes("--session");

    // 取資料
    const cutoff = Date.now() - days * 86400_000;
    const entries = traceStore.recent(10000, (e) => new Date(e.ts).getTime() >= cutoff);

    if (entries.length === 0) {
      return { text: `📊 最近 ${days} 天無 trace 記錄` };
    }

    const totalInput = entries.reduce((s, e) => s + (e.totalInputTokens ?? 0), 0);
    const totalOutput = entries.reduce((s, e) => s + (e.totalOutputTokens ?? 0), 0);
    const totalTurns = entries.length;
    const ceEntries = entries.filter(e => (e.contextEngineering?.strategiesApplied?.length ?? 0) > 0);
    const avgTokensSaved = ceEntries.length > 0
      ? Math.round(ceEntries.reduce((s, e) =>
          s + ((e.contextEngineering?.tokensBeforeCE ?? 0) - (e.contextEngineering?.tokensAfterCE ?? 0)), 0) / ceEntries.length)
      : 0;

    // 費用統計
    const totalCost = entries.reduce((s, e) => s + (e.estimatedCostUsd ?? 0), 0);

    const lines: string[] = [
      `📊 Token 統計（最近 ${days} 天，共 ${totalTurns} turns）`,
      `  輸入：${totalInput.toLocaleString()} tokens`,
      `  輸出：${totalOutput.toLocaleString()} tokens`,
      `  合計：${(totalInput + totalOutput).toLocaleString()} tokens`,
      `  預估費用：$${totalCost.toFixed(4)} USD`,
      ``,
      `📉 CE 壓縮（${ceEntries.length} turns 觸發）`,
    ];

    if (ceEntries.length > 0) {
      lines.push(`  平均每次省 ${avgTokensSaved.toLocaleString()} tokens`);

      // CE strategy 觸發頻率
      const strategyCounts = new Map<string, number>();
      for (const e of ceEntries) {
        for (const s of e.contextEngineering!.strategiesApplied) {
          strategyCounts.set(s, (strategyCounts.get(s) ?? 0) + 1);
        }
      }
      for (const [name, count] of strategyCounts.entries()) {
        lines.push(`  ${name}: ${count} 次`);
      }
    } else {
      lines.push(`  （未觸發）`);
    }

    // 分類統計
    const categoryCounts = new Map<string, number>();
    for (const e of entries) {
      const cat = e.category ?? "unknown";
      categoryCounts.set(cat, (categoryCounts.get(cat) ?? 0) + 1);
    }
    if (categoryCounts.size > 1) {
      lines.push(``, `📂 分類`);
      for (const [cat, count] of categoryCounts.entries()) {
        lines.push(`  ${cat}: ${count} turns`);
      }
    }

    // 依 session 分組
    if (bySession) {
      lines.push(``, `📋 依 Session`);
      const sessionMap = new Map<string, MessageTraceEntry[]>();
      for (const e of entries) {
        const key = e.sessionKey ?? e.channelId;
        const grp = sessionMap.get(key) ?? [];
        grp.push(e);
        sessionMap.set(key, grp);
      }
      for (const [key, ses] of sessionMap.entries()) {
        const inTok = ses.reduce((s, e) => s + (e.totalInputTokens ?? 0), 0);
        const outTok = ses.reduce((s, e) => s + (e.totalOutputTokens ?? 0), 0);
        const shortKey = key.length > 30 ? `…${key.slice(-27)}` : key;
        lines.push(`  ${shortKey}: ${ses.length} turns | ↑${inTok} ↓${outTok}`);
      }
    }

    return { text: `\`\`\`\n${lines.join("\n")}\n\`\`\`` };
  },
};
