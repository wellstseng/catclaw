/**
 * @file skills/builtin/session-manage.ts
 * @description /session — Session 管理指令
 *
 * 子命令：
 *   /session list              — 列出目前活躍 session
 *   /session clear             — 清空當前頻道的 session 訊息
 *   /session compact           — 強制觸發 CE 壓縮（當前頻道）
 *   /session purge             — 清除所有過期 session（admin only）
 *   /session delete [key]      — 刪除指定 session（admin only）
 */

import type { Skill, SkillContext, SkillResult } from "../types.js";
import { getSessionManager, makeSessionKey } from "../../core/session.js";
import { getContextEngine } from "../../core/context-engine.js";

/** 從 SkillContext 推算當前頻道的 session key */
function currentSessionKey(ctx: SkillContext): string {
  const isDm = ctx.message.channel.isDMBased();
  return makeSessionKey(ctx.channelId, ctx.authorId, isDm);
}

function isAdmin(ctx: SkillContext): boolean {
  const admin = ctx.config.admin as { allowedUserIds?: string[] } | undefined;
  return admin?.allowedUserIds?.includes(ctx.authorId) ?? false;
}

export const skill: Skill = {
  name: "session",
  description: "Session 管理（list / clear / compact / purge / delete）",
  tier: "standard",
  trigger: ["/session"],

  async execute(ctx: SkillContext): Promise<SkillResult> {
    const args = ctx.args.trim();
    const [sub, ...rest] = args.split(/\s+/);

    switch (sub) {
      case "list": return handleList();
      case "clear": return handleClear(ctx);
      case "compact": return handleCompact(ctx);
      case "purge": return handlePurge(ctx);
      case "delete": return handleDelete(ctx, rest.join(" "));
      default:
        return {
          text: [
            "**`/session` 用法**",
            "- `/session list` — 列出活躍 session",
            "- `/session clear` — 清空當前頻道的 session 訊息",
            "- `/session compact` — 強制 CE 壓縮（當前頻道）",
            "- `/session purge` — 清除所有過期 session（admin）",
            "- `/session delete <key>` — 刪除指定 session（admin）",
          ].join("\n"),
        };
    }
  },
};

function handleList(): SkillResult {
  const sm = getSessionManager();
  const sessions = sm.list();
  if (sessions.length === 0) {
    return { text: "目前沒有活躍的 session。" };
  }
  const lines = sessions
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
    .slice(0, 20)
    .map(s => {
      const age = Math.round((Date.now() - s.lastActiveAt) / 60_000);
      return `- \`${s.sessionKey}\` — ${s.messages.length} msgs, ${s.turnCount} turns, idle ${age}m`;
    });
  return { text: `**活躍 Sessions（${sessions.length}）**\n${lines.join("\n")}` };
}

function handleClear(ctx: SkillContext): SkillResult {
  const sm = getSessionManager();
  const key = currentSessionKey(ctx);
  const count = sm.clearMessages(key);
  if (count === 0) {
    return { text: `此頻道無 session 或已是空的。（key=\`${key}\`）` };
  }
  return { text: `已清空 ${count} 條訊息。（key=\`${key}\`）` };
}

async function handleCompact(ctx: SkillContext): Promise<SkillResult> {
  const sm = getSessionManager();
  const key = currentSessionKey(ctx);
  const session = sm.get(key);
  if (!session || session.messages.length === 0) {
    return { text: `此頻道無 session 或訊息為空。` };
  }

  const ce = getContextEngine();
  if (!ce) {
    return { text: "ContextEngine 未初始化，無法壓縮。", isError: true };
  }

  const before = session.messages.length;
  const processed = await ce.build(session.messages, {
    sessionKey: key,
    turnIndex: session.turnCount,
  });
  const applied = ce.lastBuildBreakdown.strategiesApplied;
  if (applied.length > 0) {
    sm.replaceMessages(key, processed);
  }
  const after = sm.get(key)?.messages.length ?? 0;

  if (applied.length === 0) {
    return { text: `CE 判斷不需壓縮（${before} msgs，未達門檻）。` };
  }
  return {
    text: `壓縮完成：${before} → ${after} msgs\n策略：${applied.join(", ")}`,
  };
}

function handlePurge(ctx: SkillContext): SkillResult {
  if (!isAdmin(ctx)) {
    return { text: "需要 admin 權限。", isError: true };
  }
  const sm = getSessionManager();
  const count = sm.purgeExpired();
  return { text: `已清除 ${count} 個過期 session。` };
}

function handleDelete(ctx: SkillContext, keyArg: string): SkillResult {
  if (!isAdmin(ctx)) {
    return { text: "需要 admin 權限。", isError: true };
  }
  const key = keyArg.trim();
  if (!key) {
    return { text: "用法：`/session delete <sessionKey>`", isError: true };
  }
  const sm = getSessionManager();
  if (!sm.get(key)) {
    return { text: `找不到 session \`${key}\`。`, isError: true };
  }
  sm.delete(key);
  return { text: `已刪除 session \`${key}\`。` };
}
