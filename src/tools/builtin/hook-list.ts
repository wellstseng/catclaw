/**
 * @file tools/builtin/hook-list.ts
 * @description hook_list — 列出已註冊的 hooks
 */

import type { Tool } from "../types.js";

export const tool: Tool = {
  name: "hook_list",
  description:
    "列出目前已註冊的 hooks。可用 event 篩選；scope=global 顯示全域、scope=agent 顯示當前 agent、" +
    "scope=all（預設）顯示兩者。",
  tier: "standard",
  resultTokenCap: 1500,
  parameters: {
    type: "object",
    properties: {
      event: { type: "string", description: "只列出指定事件的 hooks（選填）" },
      scope: { type: "string", description: "global / agent / all（預設 all）" },
    },
  },
  async execute(params, ctx) {
    const eventFilter = String(params["event"] ?? "").trim();
    const scope = String(params["scope"] ?? "all").trim() as "global" | "agent" | "all";

    try {
      const { getHookRegistry } = await import("../../hooks/hook-registry.js");
      const reg = getHookRegistry();
      if (!reg) return { error: "HookRegistry 未初始化" };

      const all = reg.listAll();
      const hooks: Array<{
        event: string; name: string; scope: string; agentId?: string;
        runtime?: string; scriptPath?: string; command?: string; timeoutMs?: number; toolFilter?: string[];
      }> = [];

      const pushIf = (def: { event: string; name: string; scope?: string; agentId?: string; runtime?: string; scriptPath?: string; command?: string; timeoutMs?: number; toolFilter?: string[] }) => {
        if (eventFilter && def.event !== eventFilter) return;
        hooks.push({
          event: def.event,
          name: def.name,
          scope: def.scope ?? "global",
          agentId: def.agentId,
          runtime: def.runtime,
          scriptPath: def.scriptPath,
          command: def.command,
          timeoutMs: def.timeoutMs,
          toolFilter: def.toolFilter,
        });
      };

      if (scope !== "agent") all.global.forEach(pushIf);
      if (scope !== "global") {
        const agentId = ctx.agentId;
        if (scope === "agent" && !agentId) return { error: "scope=agent 需要 agentId context" };
        if (agentId && all.byAgent[agentId]) all.byAgent[agentId].forEach(pushIf);
        if (scope === "all") {
          for (const [aid, list] of Object.entries(all.byAgent)) {
            if (aid === ctx.agentId) continue;
            list.forEach(pushIf);
          }
        }
      }

      return {
        result: {
          count: hooks.length,
          hooks,
        },
      };
    } catch (err) {
      return { error: `列出失敗：${err instanceof Error ? err.message : String(err)}` };
    }
  },
};
