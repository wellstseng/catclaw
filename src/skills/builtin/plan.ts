/**
 * @file skills/builtin/plan.ts
 * @description /plan — Plan Mode 切換（對標 Claude Code Plan Mode）
 *
 * Plan Mode 下 agent 只分析、規劃，不執行修改類工具。
 * 透過 per-channel flag 控制，agent-loop 檢查後過濾危險工具。
 */

import type { Skill, SkillContext, SkillResult } from "../types.js";

// ── per-channel plan mode store ─────────────────────────────────────────────

const _planMode = new Map<string, boolean>();

/** 取得 channel 是否處於 plan mode */
export function isPlanMode(channelId: string): boolean {
  return _planMode.get(channelId) ?? false;
}

/** 切換 plan mode */
export function setPlanMode(channelId: string, enabled: boolean): void {
  if (enabled) {
    _planMode.set(channelId, true);
  } else {
    _planMode.delete(channelId);
  }
}

/** Plan Mode 下禁止使用的工具（寫入/修改/執行類） */
export const PLAN_MODE_BLOCKED_TOOLS = new Set([
  "write_file",
  "edit_file",
  "run_command",
  "config_patch",
  "spawn_subagent",
]);

export const skill: Skill = {
  name: "plan",
  description: "切換 Plan Mode（只分析規劃，不執行修改）",
  tier: "standard",
  trigger: ["/plan"],

  async execute(ctx: SkillContext): Promise<SkillResult> {
    const arg = ctx.args.trim().toLowerCase();

    if (arg === "on" || arg === "enable") {
      setPlanMode(ctx.channelId, true);
      return { text: "🗺️ Plan Mode ON — agent 將只進行分析和規劃，不執行任何修改操作。\n使用 `/plan off` 恢復正常模式。" };
    }

    if (arg === "off" || arg === "disable") {
      setPlanMode(ctx.channelId, false);
      return { text: "⚡ Plan Mode OFF — 已恢復正常模式，agent 可執行所有操作。" };
    }

    // 無參數 = toggle
    const current = isPlanMode(ctx.channelId);
    setPlanMode(ctx.channelId, !current);

    if (!current) {
      return { text: "🗺️ Plan Mode ON — agent 將只進行分析和規劃，不執行任何修改操作。\n使用 `/plan off` 恢復正常模式。" };
    } else {
      return { text: "⚡ Plan Mode OFF — 已恢復正常模式，agent 可執行所有操作。" };
    }
  },
};
