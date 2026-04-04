/**
 * @file skills/builtin/context.ts
 * @description /context — 顯示當前頻道的 context 使用狀態
 *
 * 對標 Claude Code 的 /context 指令，顯示 token 消耗分布。
 * 包含：session 訊息數、估算 token、CE 策略狀態、context window 使用率。
 */

import type { Skill, SkillContext, SkillResult } from "../types.js";
import { getSessionManager, makeSessionKey } from "../../core/session.js";
import { getContextEngine, estimateTokens } from "../../core/context-engine.js";

export const skill: Skill = {
  name: "context",
  description: "顯示當前頻道的 context 使用狀態（token 消耗分布）",
  tier: "standard",
  trigger: ["/context"],

  async execute(ctx: SkillContext): Promise<SkillResult> {
    const sm = getSessionManager();
    const isDm = ctx.message.channel.isDMBased();
    const key = makeSessionKey(ctx.channelId, ctx.authorId, isDm);
    const session = sm.get(key);

    if (!session || session.messages.length === 0) {
      return { text: `此頻道無 session 或訊息為空。（key=\`${key}\`）` };
    }

    const ce = getContextEngine();
    const msgs = session.messages;
    const totalTokens = estimateTokens(msgs);

    // 分類統計
    let userTokens = 0;
    let assistantTokens = 0;
    let toolTokens = 0;
    let userMsgs = 0;
    let assistantMsgs = 0;

    for (const m of msgs) {
      const mTokens = m.tokens ?? Math.ceil(
        (typeof m.content === "string" ? m.content.length : JSON.stringify(m.content).length) / 4
      );

      if (m.role === "user") {
        // 檢查是否包含 tool_result blocks
        if (typeof m.content !== "string") {
          const hasToolResult = m.content.some((b: { type: string }) => b.type === "tool_result");
          if (hasToolResult) {
            toolTokens += mTokens;
          } else {
            userTokens += mTokens;
            userMsgs++;
          }
        } else {
          userTokens += mTokens;
          userMsgs++;
        }
      } else {
        // assistant: 檢查 tool_use blocks
        if (typeof m.content !== "string") {
          const hasToolUse = m.content.some((b: { type: string }) => b.type === "tool_use");
          if (hasToolUse) {
            toolTokens += mTokens;
          } else {
            assistantTokens += mTokens;
          }
        } else {
          assistantTokens += mTokens;
        }
        assistantMsgs++;
      }
    }

    // Context window 資訊
    const contextWindow = ce?.getContextWindowTokens() ?? 100_000;
    const utilization = totalTokens / contextWindow;
    const utilizationPct = (utilization * 100).toFixed(1);

    // 上次 CE 狀態
    const lastBreakdown = ce?.lastBuildBreakdown;
    const lastStrategy = ce?.lastAppliedStrategy;

    // 使用率 bar
    const barLen = 20;
    const filled = Math.round(utilization * barLen);
    const bar = "█".repeat(Math.min(filled, barLen)) + "░".repeat(Math.max(barLen - filled, 0));

    const lines = [
      `**Context 使用狀態** — \`${key}\``,
      "",
      `\`[${bar}]\` **${utilizationPct}%** (${totalTokens.toLocaleString()} / ${contextWindow.toLocaleString()} tokens)`,
      "",
      "**Token 分布**",
      `- 👤 使用者訊息：${userTokens.toLocaleString()} tokens（${userMsgs} 條）`,
      `- 🤖 助手回覆：${assistantTokens.toLocaleString()} tokens（${assistantMsgs} 條）`,
      `- 🔧 工具互動：${toolTokens.toLocaleString()} tokens`,
      `- 📊 總計：${msgs.length} 條訊息，${session.turnCount} turns`,
    ];

    if (lastBreakdown) {
      lines.push("");
      lines.push("**上次 CE 狀態**");
      if (lastBreakdown.strategiesApplied.length > 0) {
        lines.push(`- 策略：${lastBreakdown.strategiesApplied.join(", ")}`);
        if (lastBreakdown.tokensBeforeCE != null && lastBreakdown.tokensAfterCE != null) {
          const saved = lastBreakdown.tokensBeforeCE - lastBreakdown.tokensAfterCE;
          lines.push(`- 壓縮：${lastBreakdown.tokensBeforeCE.toLocaleString()} → ${lastBreakdown.tokensAfterCE.toLocaleString()} tokens（省 ${saved.toLocaleString()}）`);
        }
      } else {
        lines.push("- 未觸發壓縮");
      }
    }

    // 使用率警告
    if (utilization > 0.8) {
      lines.push("");
      lines.push("⚠️ **Context 使用率 >80%**，建議使用 `/session compact` 壓縮或 `/session clear` 清空。");
    } else if (utilization > 0.6) {
      lines.push("");
      lines.push("ℹ️ Context 使用率 >60%，接近自動壓縮門檻。");
    }

    return { text: lines.join("\n") };
  },
};
