/**
 * @file skills/builtin/system.ts
 * @description /system skill — 為此頻道設定額外的 system prompt 附加文字
 *
 * 用法：
 *   /system             → 顯示目前 override
 *   /system set <text>  → 設定（追加到 base prompt 後）
 *   /system append <t>  → 附加到現有 override
 *   /system reset       → 清除 override
 */

import type { Skill } from "../types.js";

// ── per-channel system prompt override store ──────────────────────────────────

const _channelSystemMap = new Map<string, string>();

export function getChannelSystemOverride(channelId: string): string | undefined {
  return _channelSystemMap.get(channelId);
}

export function setChannelSystemOverride(channelId: string, text: string | null): void {
  if (text === null) {
    _channelSystemMap.delete(channelId);
  } else {
    _channelSystemMap.set(channelId, text);
  }
}

// ── /system skill ─────────────────────────────────────────────────────────────

export const skill: Skill = {
  name: "system",
  description: "設定此頻道的 system prompt 附加文字（追加到 CATCLAW.md 後）",
  tier: "admin",
  trigger: ["/system"],

  async execute({ channelId, args }) {
    const trimmed = args.trim();
    const current = getChannelSystemOverride(channelId);

    if (!trimmed) {
      if (current) {
        const preview = current.length > 200 ? current.slice(0, 200) + "…" : current;
        return { text: `📝 **System Prompt 附加**：\n\`\`\`\n${preview}\n\`\`\`\n用法：\`/system set <text>\` / \`/system append <text>\` / \`/system reset\`` };
      }
      return { text: "📝 **System Prompt 附加**：未設定\n用法：`/system set <text>` / `/system reset`" };
    }

    const spaceIdx = trimmed.indexOf(" ");
    const sub = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
    const rest = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

    if (sub === "reset" || sub === "clear") {
      setChannelSystemOverride(channelId, null);
      return { text: "📝 System Prompt 附加已清除。" };
    }

    if (sub === "set") {
      if (!rest) return { text: "❌ 用法：`/system set <text>`", isError: true };
      setChannelSystemOverride(channelId, rest);
      return { text: `📝 System Prompt 附加已設定（${rest.length} 字）。下次對話生效。` };
    }

    if (sub === "append") {
      if (!rest) return { text: "❌ 用法：`/system append <text>`", isError: true };
      const newText = current ? `${current}\n${rest}` : rest;
      setChannelSystemOverride(channelId, newText);
      return { text: `📝 已附加到 System Prompt（共 ${newText.length} 字）。下次對話生效。` };
    }

    // 沒有子命令 → 直接當 set
    setChannelSystemOverride(channelId, trimmed);
    return { text: `📝 System Prompt 附加已設定（${trimmed.length} 字）。下次對話生效。` };
  },
};
