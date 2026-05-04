/**
 * @file skills/builtin/insights.ts
 * @description /insights skill — CatClaw 使用統計報告（項目 9 Phase 3）
 *
 * 從 trace + NDJSON 訊息索引算：
 *   - Token 消耗（input/output/cache 比例 + 估算成本）
 *   - 最活躍時段（hour histogram）
 *   - Tool top 5
 *   - Session 統計（總數 / 平均 turn / 最長）
 *   - Compaction 觸發頻率
 *   - 熱門 channel
 */

import type { Skill } from "../types.js";

function parseFlags(args: string): { days: number } {
  let days = 7;
  const tokens = args.split(/\s+/);
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === "--days" && tokens[i + 1]) {
      days = Math.max(1, parseInt(tokens[++i]!, 10) || 7);
    }
  }
  return { days };
}

function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

export const skill: Skill = {
  name: "insights",
  description: "CatClaw 使用統計報告（項目 9 Phase 3）— /insights [--days N]",
  tier: "standard",
  trigger: ["/insights"],

  async execute({ args }) {
    const { days } = parseFlags(args);

    const { aggregateMessages } = await import("../../memory/fts-query.js");
    const { getTraceStore } = await import("../../core/message-trace.js");

    const since = Date.now() - days * 86_400_000;
    const traces = getTraceStore()?.recent(5000, e => {
      const tsMs = new Date(e.ts).getTime();
      return tsMs >= since;
    }) ?? [];
    const agg = aggregateMessages({ days });

    if (traces.length === 0 && agg.total === 0) {
      return { text: `📊 最近 ${days} 天無資料（trace + 訊息索引都空）` };
    }

    let totalInput = 0;
    let totalOutput = 0;
    let totalCacheRead = 0;
    let totalCacheWrite = 0;
    let totalCost = 0;
    let totalToolCalls = 0;
    let compactionCount = 0;
    const sessionTurns: Record<string, number> = {};
    const toolCount: Record<string, number> = {};

    for (const t of traces) {
      totalInput += t.totalInputTokens ?? 0;
      totalOutput += t.totalOutputTokens ?? 0;
      totalCacheRead += t.totalCacheRead ?? 0;
      totalCacheWrite += t.totalCacheWrite ?? 0;
      totalCost += t.estimatedCostUsd ?? 0;
      totalToolCalls += t.totalToolCalls ?? 0;
      if (t.sessionKey) {
        sessionTurns[t.sessionKey] = (sessionTurns[t.sessionKey] ?? 0) + 1;
      }
      for (const llm of t.llmCalls ?? []) {
        for (const tc of llm.toolCalls ?? []) {
          toolCount[tc.name] = (toolCount[tc.name] ?? 0) + 1;
        }
      }
      if (t.contextEngineering?.strategiesApplied?.includes("compaction")) {
        compactionCount++;
      }
    }

    const cacheTotal = totalInput + totalCacheRead;
    const cacheHitRate = cacheTotal > 0 ? ((totalCacheRead / cacheTotal) * 100).toFixed(1) : "0.0";
    const sessionCount = Object.keys(sessionTurns).length;
    const avgTurn = sessionCount > 0
      ? (Object.values(sessionTurns).reduce((a, b) => a + b, 0) / sessionCount).toFixed(1)
      : "0";
    const maxTurn = sessionCount > 0 ? Math.max(...Object.values(sessionTurns)) : 0;

    const topTools = Object.entries(toolCount)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    // 最活躍時段（hour histogram → top 1 + 該段佔比）
    let peakHour = -1;
    let peakCount = 0;
    let totalMessages = 0;
    for (let h = 0; h < 24; h++) {
      totalMessages += agg.hourHistogram[h];
      if (agg.hourHistogram[h] > peakCount) {
        peakCount = agg.hourHistogram[h];
        peakHour = h;
      }
    }
    const peakRatio = totalMessages > 0 ? ((peakCount / totalMessages) * 100).toFixed(0) : "0";

    let text = `📊 **CatClaw 使用洞察**（最近 ${days} 天）\n\n`;

    text += `## Token 消耗\n`;
    text += `- 輸入：${formatNumber(totalInput)}（cache hit: ${cacheHitRate}%）\n`;
    text += `- 輸出：${formatNumber(totalOutput)}\n`;
    text += `- Cache R/W：${formatNumber(totalCacheRead)} / ${formatNumber(totalCacheWrite)}\n`;
    text += `- 估算成本：~$${totalCost.toFixed(4)}\n\n`;

    text += `## 最活躍時段\n`;
    if (peakHour >= 0) {
      text += `- ${peakHour.toString().padStart(2, "0")}:00–${(peakHour + 1).toString().padStart(2, "0")}:00 佔 ${peakRatio}% 訊息\n\n`;
    } else {
      text += `- 無資料\n\n`;
    }

    text += `## Tool 使用 Top ${topTools.length}\n`;
    for (let i = 0; i < topTools.length; i++) {
      const t = topTools[i]!;
      const pct = totalToolCalls > 0 ? ((t.count / totalToolCalls) * 100).toFixed(0) : "0";
      text += `${i + 1}. \`${t.name}\` (${t.count}, ${pct}%)\n`;
    }
    text += `\n`;

    text += `## Session 統計\n`;
    text += `- 總 session 數：${sessionCount}\n`;
    text += `- 平均 trace 數：${avgTurn}\n`;
    text += `- 最多 trace 的 session：${maxTurn}\n\n`;

    text += `## Compaction 觸發\n`;
    text += `- 總計：${compactionCount} 次 / ${traces.length} traces（${traces.length > 0 ? ((compactionCount / traces.length) * 100).toFixed(0) : "0"}%）\n\n`;

    text += `## 熱門 Channel Top ${Math.min(5, agg.topChannels.length)}\n`;
    for (let i = 0; i < Math.min(5, agg.topChannels.length); i++) {
      const c = agg.topChannels[i]!;
      text += `${i + 1}. \`…${c.channelId.slice(-16)}\`（${c.count} 訊息）\n`;
    }

    return { text: text.trim() };
  },
};
