/**
 * @file skills/builtin/recall.ts
 * @description /recall skill — 跨 session 訊息全文搜尋（項目 9 Phase 2）
 *
 * 用法：
 *   /recall <query>                  → 預設搜近 30 天，限 20 筆
 *   /recall <query> --days 7         → 限近 7 天
 *   /recall <query> --limit 50       → 限 50 筆
 *   /recall <query> --role user      → 只搜 user 訊息
 *   /recall <query> --here           → 只搜當前 channel
 */

import type { Skill } from "../types.js";

function parseFlags(args: string): { query: string; days: number; limit: number; role?: "user" | "assistant" | "tool_result"; here: boolean } {
  let days = 30;
  let limit = 20;
  let role: "user" | "assistant" | "tool_result" | undefined;
  let here = false;
  const tokens = args.split(/\s+/);
  const queryParts: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t === "--days" && tokens[i + 1]) {
      days = Math.max(1, parseInt(tokens[++i]!, 10) || 30);
    } else if (t === "--limit" && tokens[i + 1]) {
      limit = Math.min(200, Math.max(1, parseInt(tokens[++i]!, 10) || 20));
    } else if (t === "--role" && tokens[i + 1]) {
      const r = tokens[++i];
      if (r === "user" || r === "assistant" || r === "tool_result") role = r;
    } else if (t === "--here") {
      here = true;
    } else if (t) {
      queryParts.push(t);
    }
  }
  return { query: queryParts.join(" ").trim(), days, limit, role, here };
}

export const skill: Skill = {
  name: "recall",
  description:
    "跨 session 訊息全文搜尋（項目 9 Phase 2）— /recall <query> [--days N] [--limit N] [--role user|assistant|tool_result] [--here]",
  tier: "standard",
  trigger: ["/recall"],

  async execute({ args, channelId }) {
    const opts = parseFlags(args);
    if (!opts.query) {
      return {
        text:
          "🔍 **跨 session 訊息全文搜尋**\n" +
          "用法：`/recall <query> [--days N] [--limit N] [--role user|assistant|tool_result] [--here]`\n\n" +
          "例：\n" +
          "• `/recall \"prompt cache\"` — 近 30 天\n" +
          "• `/recall hermes --days 7 --here` — 限近 7 天 + 只搜當前 channel\n" +
          "• `/recall 結論 --role assistant` — 只搜助手訊息",
      };
    }

    const { searchMessages } = await import("../../memory/fts-query.js");
    const hits = searchMessages({
      query: opts.query,
      days: opts.days,
      limit: opts.limit,
      role: opts.role,
      channelId: opts.here ? channelId : undefined,
    });

    if (hits.length === 0) {
      return {
        text: `🔍 \`${opts.query}\` 在最近 ${opts.days} 天無命中${opts.here ? "（當前 channel）" : ""}。`,
      };
    }

    let out = `🔍 \`${opts.query}\` — ${hits.length} 命中（最近 ${opts.days} 天${opts.here ? " · 當前 channel" : ""}）\n\n`;
    for (const h of hits) {
      const ts = new Date(h.message.ts).toLocaleString("zh-TW", { timeZone: "Asia/Taipei" });
      const ch = h.message.channelId?.slice(-12) ?? "?";
      out +=
        `• \`${ts}\` [${h.message.role}] ch:…${ch}\n` +
        `  ${h.preview.replace(/\n/g, " ").slice(0, 200)}\n\n`;
    }
    return { text: out.trim() };
  },
};
