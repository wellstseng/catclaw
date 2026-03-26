/**
 * @file skills/builtin/project.ts
 * @description /project 專案管理 skill（tier=standard）
 *
 * 子命令：
 *   /project create <id> --name "顯示名" [--desc "說明"]
 *   /project list
 *   /project info [<id>]
 *   /project switch <id>
 *   /project add-member <projectId> <accountId>
 */

import type { Skill, SkillContext, SkillResult } from "../types.js";
import { log } from "../../logger.js";

// ── 參數解析 ──────────────────────────────────────────────────────────────────

function parseFlags(args: string): { positionals: string[]; flags: Record<string, string> } {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const positionals: string[] = [];
  const flags: Record<string, string> = {};

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.startsWith("--")) {
      const key = t.slice(2);
      const next = tokens[i + 1];
      if (next && !next.startsWith("--")) { flags[key] = next; i++; }
      else flags[key] = "true";
    } else {
      positionals.push(t);
    }
  }
  return { positionals, flags };
}

// ── 子命令 ────────────────────────────────────────────────────────────────────

async function handleCreate(args: string, ctx: SkillContext): Promise<SkillResult> {
  const { positionals, flags } = parseFlags(args);
  const projectId = positionals[0];
  if (!projectId) return { text: "❌ 用法：`/project create <id> --name \"顯示名\"`", isError: true };

  const displayName = flags["name"] ?? projectId;
  const description = flags["desc"];

  try {
    const { getProjectManager } = await import("../../projects/manager.js");
    const { resolveDiscordIdentity } = await import("../../core/platform.js");
    const { accountId } = resolveDiscordIdentity(ctx.authorId, []);

    const project = getProjectManager().create({ projectId, displayName, description, createdBy: accountId });
    return { text: `✅ 專案已建立：\`${project.projectId}\`（${displayName}）` };
  } catch (err) {
    return { text: `❌ ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
}

async function handleList(_args: string, ctx: SkillContext): Promise<SkillResult> {
  try {
    const { getProjectManager } = await import("../../projects/manager.js");
    const { resolveDiscordIdentity } = await import("../../core/platform.js");
    const { accountId } = resolveDiscordIdentity(ctx.authorId, []);

    const projects = getProjectManager().listForAccount(accountId);
    if (projects.length === 0) return { text: "目前沒有任何專案。" };

    const lines = projects.map(p =>
      `• \`${p.projectId}\` — ${p.displayName}${p.description ? ` (${p.description})` : ""}`
    );
    return { text: `**專案清單（${projects.length} 個）**\n${lines.join("\n")}` };
  } catch (err) {
    return { text: `❌ ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
}

async function handleInfo(args: string, ctx: SkillContext): Promise<SkillResult> {
  const { positionals } = parseFlags(args);
  try {
    const { getProjectManager } = await import("../../projects/manager.js");
    const { getAccountRegistry, resolveDiscordIdentity } = await import("../../core/platform.js");

    let projectId = positionals[0];
    if (!projectId) {
      // 取得目前帳號的 currentProject
      const { accountId } = resolveDiscordIdentity(ctx.authorId, []);
      const account = getAccountRegistry().get(accountId);
      projectId = account?.projects?.[0] ?? "";
    }

    if (!projectId) return { text: "❌ 未指定專案 ID，且帳號沒有設定 currentProject", isError: true };

    const project = getProjectManager().get(projectId);
    if (!project) return { text: `❌ 找不到專案：${projectId}`, isError: true };

    return {
      text: [
        `**專案：\`${project.projectId}\`**`,
        `名稱：${project.displayName}`,
        project.description ? `說明：${project.description}` : null,
        `成員：${project.members.join(", ") || "（公開）"}`,
        `建立者：${project.createdBy}`,
        `建立：${project.createdAt.slice(0, 10)}`,
      ].filter(Boolean).join("\n"),
    };
  } catch (err) {
    return { text: `❌ ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
}

async function handleSwitch(args: string, ctx: SkillContext): Promise<SkillResult> {
  const { positionals } = parseFlags(args);
  const projectId = positionals[0];
  if (!projectId) return { text: "❌ 用法：`/project switch <id>`", isError: true };

  try {
    const { getProjectManager } = await import("../../projects/manager.js");
    const { getAccountRegistry, resolveDiscordIdentity } = await import("../../core/platform.js");

    const project = getProjectManager().get(projectId);
    if (!project) return { text: `❌ 找不到專案：${projectId}`, isError: true };

    const { accountId } = resolveDiscordIdentity(ctx.authorId, []);
    const registry = getAccountRegistry();
    const account = registry.get(accountId);
    if (!account) return { text: `❌ 找不到帳號：${accountId}`, isError: true };

    // 確認有權存取
    if (project.members.length > 0 && !project.members.includes(accountId)) {
      return { text: `❌ 無權存取專案 ${projectId}`, isError: true };
    }

    // 更新 account.projects[0] = currentProject
    const projects = [projectId, ...account.projects.filter(p => p !== projectId)];
    registry.update(accountId, { projects });

    log.info(`[skill:project] ${accountId} 切換至專案 ${projectId}`);
    return { text: `✅ 已切換至專案 \`${projectId}\`（${project.displayName}）` };
  } catch (err) {
    return { text: `❌ ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
}

async function handleAddMember(args: string, _ctx: SkillContext): Promise<SkillResult> {
  const { positionals } = parseFlags(args);
  const [projectId, accountId] = positionals;
  if (!projectId || !accountId) return { text: "❌ 用法：`/project add-member <projectId> <accountId>`", isError: true };

  try {
    const { getProjectManager } = await import("../../projects/manager.js");
    getProjectManager().addMember(projectId, accountId);
    return { text: `✅ \`${accountId}\` 已加入專案 \`${projectId}\`` };
  } catch (err) {
    return { text: `❌ ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
}

// ── Skill 定義 ────────────────────────────────────────────────────────────────

export const skill: Skill = {
  name: "project",
  description: "專案管理：建立、列表、資訊、切換、成員管理",
  tier: "standard",
  trigger: ["/project"],

  async execute(ctx: SkillContext): Promise<SkillResult> {
    const tokens = ctx.args.trim().split(/\s+/);
    const sub = (tokens[0] ?? "").toLowerCase();
    const rest = tokens.slice(1).join(" ");

    log.debug(`[skill:project] sub=${sub}`);

    switch (sub) {
      case "create":     return handleCreate(rest, ctx);
      case "list":       return handleList(rest, ctx);
      case "info":       return handleInfo(rest, ctx);
      case "switch":     return handleSwitch(rest, ctx);
      case "add-member": return handleAddMember(rest, ctx);
      default:
        return {
          text: [
            "**`/project` 子命令**",
            "• `create <id> --name \"名稱\" [--desc \"說明\"]` — 建立專案",
            "• `list` — 列出所有專案",
            "• `info [<id>]` — 查看專案詳情",
            "• `switch <id>` — 切換當前專案",
            "• `add-member <projectId> <accountId>` — 新增成員",
          ].join("\n"),
        };
    }
  },
};
