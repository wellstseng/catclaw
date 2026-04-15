/**
 * @file skills/builtin/hook.ts
 * @description /hook skill — 查詢、建立、移除 hook
 *
 * 子指令：
 *   /hook list [event]            — 列出已註冊 hooks
 *   /hook events                  — 列出所有支援的事件
 *   /hook remove <event> <name>   — 停用指定 hook
 *   /hook help                    — 顯示說明
 */

import type { Skill, SkillContext, SkillResult } from "../types.js";

const ALL_EVENTS: string[] = [
  // Lifecycle
  "PreToolUse", "PostToolUse", "SessionStart", "SessionEnd",
  // Turn / Message
  "UserMessageReceived", "UserPromptSubmit", "PreTurn", "PostTurn",
  "PreLlmCall", "PostLlmCall", "AgentResponseReady", "ToolTimeout",
  // Memory / Atom
  "PreAtomWrite", "PostAtomWrite", "PreAtomDelete", "PostAtomDelete",
  "AtomReplace", "MemoryRecall",
  // Subagent
  "PreSubagentSpawn", "PostSubagentComplete", "SubagentError",
  // Context
  "PreCompaction", "PostCompaction", "ContextOverflow",
  // CLI Bridge
  "CliBridgeSpawn", "CliBridgeSuspend", "CliBridgeTurn",
  // File / Command
  "PreFileWrite", "PreFileEdit", "PreCommandExec",
  // Error / Safety
  "SafetyViolation", "AgentError",
  // Platform
  "ConfigReload", "ProviderSwitch",
];

export const skill: Skill = {
  name: "hook",
  description: "Hook 系統管理（/hook list / events / remove / help）",
  tier: "standard",
  trigger: ["/hook"],

  async execute(ctx: SkillContext): Promise<SkillResult> {
    const parts = ctx.args.trim().split(/\s+/).filter(Boolean);
    const sub = (parts[0] ?? "help").toLowerCase();

    try {
      const { getHookRegistry } = await import("../../hooks/hook-registry.js");
      const reg = getHookRegistry();
      if (!reg) return { text: "❌ HookRegistry 未初始化", isError: true };

      switch (sub) {
        case "events": {
          const grouped: Record<string, string[]> = {
            Lifecycle: ALL_EVENTS.slice(0, 4),
            "Turn/Message": ALL_EVENTS.slice(4, 12),
            "Memory/Atom": ALL_EVENTS.slice(12, 18),
            Subagent: ALL_EVENTS.slice(18, 21),
            Context: ALL_EVENTS.slice(21, 24),
            "CLI Bridge": ALL_EVENTS.slice(24, 27),
            "File/Command": ALL_EVENTS.slice(27, 30),
            "Error/Safety": ALL_EVENTS.slice(30, 32),
            Platform: ALL_EVENTS.slice(32, 34),
          };
          const lines = ["🪝 **支援的 Hook Events** (32)\n"];
          for (const [group, evs] of Object.entries(grouped)) {
            lines.push(`**${group}**`);
            lines.push("  " + evs.map(e => `\`${e}\``).join(", "));
          }
          return { text: lines.join("\n") };
        }

        case "list": {
          const eventFilter = parts[1];
          const all = reg.listAll();
          const lines: string[] = ["🪝 **已註冊 Hooks**\n"];

          const globalHooks = eventFilter ? all.global.filter(h => h.event === eventFilter) : all.global;
          lines.push(`**Global** (${globalHooks.length})`);
          for (const h of globalHooks.slice(0, 20)) {
            const src = h.scriptPath ? h.scriptPath.split("/").slice(-2).join("/") : (h.command ?? "?");
            lines.push(`  • \`${h.event}\` / ${h.name} — ${src}`);
          }
          if (globalHooks.length > 20) lines.push(`  …還有 ${globalHooks.length - 20} 筆`);

          const agentEntries = Object.entries(all.byAgent);
          if (agentEntries.length > 0) {
            lines.push("");
            for (const [agentId, defs] of agentEntries) {
              const filtered = eventFilter ? defs.filter(h => h.event === eventFilter) : defs;
              if (filtered.length === 0) continue;
              lines.push(`**Agent: ${agentId}** (${filtered.length})`);
              for (const h of filtered.slice(0, 10)) {
                const src = h.scriptPath ? h.scriptPath.split("/").slice(-2).join("/") : (h.command ?? "?");
                lines.push(`  • \`${h.event}\` / ${h.name} — ${src}`);
              }
            }
          }

          return { text: lines.join("\n") };
        }

        case "remove": {
          const event = parts[1];
          const name = parts[2];
          if (!event || !name) return { text: "用法：`/hook remove <event> <name>`", isError: true };

          const all = reg.listAll();
          const found = all.global.find(h => h.event === event && h.name === name);
          if (!found || !found.scriptPath) {
            return { text: `❌ 找不到 global hook：${event}/${name}`, isError: true };
          }

          const { rename } = await import("node:fs/promises");
          const { dirname, basename, extname, join } = await import("node:path");
          const ext = extname(found.scriptPath);
          const base = basename(found.scriptPath, ext);
          const target = join(dirname(found.scriptPath), `${base}.disabled${ext}`);
          await rename(found.scriptPath, target);

          return { text: `✅ 已停用 hook：${event}/${name}\n  搬至：\`${target}\`\n  （scanner 將自動 reload）` };
        }

        default:
          return {
            text: [
              "🪝 **Hook 管理**",
              "",
              "• `/hook list [event]` — 列出已註冊 hooks",
              "• `/hook events` — 列出 32 個支援事件",
              "• `/hook remove <event> <name>` — 停用指定 hook（rename to *.disabled.*）",
              "",
              "新增 hook：使用 `hook_register` tool，或直接在 `workspace/hooks/` 放腳本。",
              "支援副檔名：`.ts` `.js` `.mjs` `.sh` `.bat` `.ps1`",
              "檔名格式：`{event}.{name}.{ext}`（例如 `PreToolUse.log.ts`）",
            ].join("\n"),
          };
      }
    } catch (err) {
      return { text: `❌ 執行失敗：${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  },
};
