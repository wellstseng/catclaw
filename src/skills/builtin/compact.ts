/**
 * @file skills/builtin/compact.ts
 * @description /compact — 手動觸發 CE 壓縮（/session compact 的快捷指令）
 *
 * 對標 Claude Code 的 /compact 指令。
 */

import type { Skill, SkillContext, SkillResult } from "../types.js";
import { getSessionManager, makeSessionKey } from "../../core/session.js";
import { getContextEngine, estimateTokens } from "../../core/context-engine.js";

export const skill: Skill = {
  name: "compact",
  description: "手動觸發 CE 壓縮當前頻道的 session（/session compact 快捷鍵）",
  tier: "standard",
  trigger: ["/compact"],

  async execute(ctx: SkillContext): Promise<SkillResult> {
    const sm = getSessionManager();
    const isDm = ctx.message?.channel.isDMBased() ?? false;
    const key = makeSessionKey(ctx.channelId, ctx.authorId, isDm);
    const session = sm.get(key);

    if (!session || session.messages.length === 0) {
      return { text: `此頻道無 session 或訊息為空。` };
    }

    const ce = getContextEngine();
    if (!ce) {
      return { text: "ContextEngine 未初始化，無法壓縮。", isError: true };
    }

    const beforeCount = session.messages.length;
    const beforeTokens = estimateTokens(session.messages);

    const processed = await ce.build(session.messages, {
      sessionKey: key,
      turnIndex: session.turnCount,
    });
    const applied = ce.lastBuildBreakdown.strategiesApplied;

    if (applied.length > 0) {
      sm.replaceMessages(key, processed);
    }

    const afterSession = sm.get(key);
    const afterCount = afterSession?.messages.length ?? 0;
    const afterTokens = afterSession ? estimateTokens(afterSession.messages) : 0;

    if (applied.length === 0) {
      const contextWindow = ce.getContextWindowTokens();
      const pct = ((beforeTokens / contextWindow) * 100).toFixed(1);
      return { text: `CE 判斷不需壓縮（${beforeCount} msgs, ${beforeTokens.toLocaleString()} tokens, ${pct}% 使用率）。\n提示：使用 \`/context\` 查看詳細分布。` };
    }

    const savedTokens = beforeTokens - afterTokens;
    return {
      text: [
        `✅ 壓縮完成`,
        `- 訊息：${beforeCount} → ${afterCount}`,
        `- Token：${beforeTokens.toLocaleString()} → ${afterTokens.toLocaleString()}（省 ${savedTokens.toLocaleString()}）`,
        `- 策略：${applied.join(", ")}`,
      ].join("\n"),
    };
  },
};
