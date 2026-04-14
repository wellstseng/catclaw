/**
 * @file skills/builtin/register.ts
 * @description /register 帳號自助註冊 skill（tier=public）
 *
 * 使用者透過邀請碼自助建立帳號：
 *   /register <inviteCode> <username>
 */

import type { Skill, SkillContext, SkillResult } from "../types.js";
import { log } from "../../logger.js";

export const skill: Skill = {
  name: "register",
  description: "透過邀請碼自助建立帳號",
  tier: "public",
  trigger: ["/register"],

  async execute(ctx: SkillContext): Promise<SkillResult> {
    const tokens = ctx.args.trim().split(/\s+/).filter(Boolean);
    const code = tokens[0];
    const username = tokens[1];

    if (!code || !username) {
      return {
        text: "❌ 用法：`/register <inviteCode> <username>`\n邀請碼由管理員產生（`/account invite`）。",
        isError: true,
      };
    }

    // 帳號名稱格式檢查：只允許英數字和 - _，3-32 字元
    if (!/^[a-zA-Z0-9_-]{3,32}$/.test(username)) {
      return {
        text: "❌ 帳號名稱只允許英數字、-、_，且需 3-32 個字元。",
        isError: true,
      };
    }

    try {
      const { getRegistrationManager } = await import("../../accounts/registration.js");
      const result = getRegistrationManager().claimInvite(
        code,
        username,
        "discord",
        ctx.authorId,
        ctx.message?.author.displayName ?? ctx.authorId,
      );

      if (!result.ok) {
        return { text: `❌ 註冊失敗：${result.reason}`, isError: true };
      }

      log.info(`[skill:register] 帳號 ${username} 註冊成功 discord=${ctx.authorId}`);
      return { text: `✅ 帳號 \`${username}\` 已建立並綁定！歡迎加入。` };
    } catch (err) {
      log.warn(`[skill:register] 失敗：${err instanceof Error ? err.message : String(err)}`);
      return { text: `❌ ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  },
};
