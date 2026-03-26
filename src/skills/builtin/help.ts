/**
 * @file skills/builtin/help.ts
 * @description /help skill（tier=public）— 按帳號角色顯示可用 skill 清單
 */

import type { Skill, SkillContext, SkillResult } from "../types.js";
import { log } from "../../logger.js";

export const skill: Skill = {
  name: "help",
  description: "顯示可用指令清單",
  tier: "public",
  trigger: ["/help"],

  async execute(ctx: SkillContext): Promise<SkillResult> {
    log.debug(`[skill:help] authorId=${ctx.authorId}`);

    try {
      const { listSkills } = await import("../registry.js");
      const { isPlatformReady, resolveDiscordIdentity } = await import("../../core/platform.js");

      // 取得帳號角色
      let accountRole = "guest";
      if (isPlatformReady()) {
        try {
          const { getAccountRegistry } = await import("../../core/platform.js");
          const { accountId } = resolveDiscordIdentity(ctx.authorId, []);
          const account = getAccountRegistry().get(accountId);
          if (account) accountRole = account.role;
        } catch { /* 無法取得角色，保持 guest */ }
      }

      // 角色 → 可存取的 tier
      const TIER_ORDER = ["public", "standard", "elevated", "admin", "owner"];
      const ROLE_MAX_TIER: Record<string, string> = {
        guest: "public",
        member: "standard",
        developer: "elevated",
        admin: "admin",
        "platform-owner": "owner",
      };
      const maxTier = ROLE_MAX_TIER[accountRole] ?? "public";
      const allowedTiers = new Set(
        TIER_ORDER.slice(0, TIER_ORDER.indexOf(maxTier) + 1)
      );

      const allSkills = listSkills();
      const visibleSkills = allSkills.filter((s: { tier: string }) => allowedTiers.has(s.tier));

      if (visibleSkills.length === 0) {
        return { text: "目前沒有可用指令。" };
      }

      const lines = visibleSkills.map((s: { trigger: string[]; description: string; tier: string }) =>
        `• \`${s.trigger[0]}\` — ${s.description} *(${s.tier})*`
      );

      return {
        text: [
          `**可用指令**（角色：${accountRole}，${visibleSkills.length} 個）`,
          ...lines,
        ].join("\n"),
      };
    } catch (err) {
      return {
        text: `❌ /help 失敗：${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },
};
