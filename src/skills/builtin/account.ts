/**
 * @file skills/builtin/account.ts
 * @description /account 帳號管理 skill（tier=admin）
 *
 * 子命令：
 *   /account create <id> --role <role> --discord <discordId> [--display "name"]
 *   /account invite [--role <role>] [--expires <h>]
 *   /account approve <pairingCode> --name <id> [--role <role>]
 *   /account pairings
 *   /account list
 *   /account info [<id>]
 *   /account link <id> --discord <discordId>
 */

import type { Skill, SkillContext, SkillResult } from "../types.js";
import type { Role } from "../../accounts/registry.js";
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
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = "true";
      }
    } else {
      positionals.push(t);
    }
  }
  return { positionals, flags };
}

const VALID_ROLES: Role[] = ["platform-owner", "admin", "developer", "member", "guest"];

// ── 子命令 ────────────────────────────────────────────────────────────────────

async function handleCreate(args: string, _ctx: SkillContext): Promise<SkillResult> {
  const { positionals, flags } = parseFlags(args);
  const accountId = positionals[0];
  if (!accountId) return { text: "❌ 用法：`/account create <id> --role <role> [--discord <id>] [--display name]`", isError: true };

  const role = (flags["role"] ?? "member") as Role;
  if (!VALID_ROLES.includes(role)) {
    return { text: `❌ 角色無效：${role}（可用：${VALID_ROLES.join(", ")}）`, isError: true };
  }
  const discordId = flags["discord"];
  const displayName = flags["display"] ?? accountId;

  try {
    const { getAccountRegistry } = await import("../../core/platform.js");
    const registry = getAccountRegistry();
    const account = registry.create({
      accountId,
      displayName,
      role,
      identities: discordId
        ? [{ platform: "discord", platformId: discordId, linkedAt: new Date().toISOString() }]
        : [],
    });
    return { text: `✅ 帳號建立：\`${account.accountId}\`（role=${account.role}${discordId ? ` discord=${discordId}` : ""}）` };
  } catch (err) {
    return { text: `❌ ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
}

async function handleInvite(args: string, ctx: SkillContext): Promise<SkillResult> {
  const { flags } = parseFlags(args);
  const role = (flags["role"] ?? "member") as Role;
  const expireH = Math.max(1, parseInt(flags["expires"] ?? "24", 10));

  if (!VALID_ROLES.includes(role)) {
    return { text: `❌ 角色無效：${role}`, isError: true };
  }

  try {
    const { getRegistrationManager } = await import("../../accounts/registration.js");
    const { resolveDiscordIdentity } = await import("../../core/platform.js");
    const { accountId } = resolveDiscordIdentity(ctx.authorId, []);
    const invite = getRegistrationManager().createInvite({
      createdBy: accountId,
      role,
      expireMs: expireH * 60 * 60 * 1000,
    });
    return {
      text: `✅ 邀請碼：\`${invite.code}\`\n角色：${role} | 有效期：${expireH}h\n使用方式：\`/register ${invite.code} <username>\``,
    };
  } catch (err) {
    return { text: `❌ ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
}

async function handleApprove(args: string, _ctx: SkillContext): Promise<SkillResult> {
  const { positionals, flags } = parseFlags(args);
  const code = positionals[0];
  if (!code) return { text: "❌ 用法：`/account approve <code> --name <id> [--role member]`", isError: true };

  const accountId = flags["name"];
  if (!accountId) return { text: "❌ 缺少 --name <id>", isError: true };

  const role = (flags["role"] ?? "member") as Role;
  if (!VALID_ROLES.includes(role)) return { text: `❌ 角色無效：${role}`, isError: true };

  try {
    const { getRegistrationManager } = await import("../../accounts/registration.js");
    const result = getRegistrationManager().approvePairing(code, {
      accountId,
      role,
      displayName: flags["display"] ?? accountId,
    });
    if (!result.ok) return { text: `❌ ${result.reason}`, isError: true };
    return { text: `✅ 配對批准：帳號 \`${accountId}\`（role=${role}）已建立並綁定` };
  } catch (err) {
    return { text: `❌ ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
}

async function handlePairings(_args: string, _ctx: SkillContext): Promise<SkillResult> {
  try {
    const { getRegistrationManager } = await import("../../accounts/registration.js");
    const list = getRegistrationManager().listPairings();
    if (list.length === 0) return { text: "目前沒有待審批的配對請求。" };

    const lines = list.map(p => {
      const ageMin = Math.floor((Date.now() - p.createdAt) / 60000);
      const leftMin = Math.max(0, 5 - ageMin);
      return `• \`${p.code}\` — ${p.platform}:${p.platformId}（${ageMin} 分鐘前，剩 ${leftMin} 分鐘）`;
    });
    return {
      text: `**待審批配對（${list.length} 個）**\n${lines.join("\n")}\n\n批准：\`/account approve <code> --name <id>\``,
    };
  } catch (err) {
    return { text: `❌ ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
}

async function handleList(_args: string, _ctx: SkillContext): Promise<SkillResult> {
  try {
    const { getAccountRegistry } = await import("../../core/platform.js");
    const index = getAccountRegistry().getIndex();
    const entries = Object.entries(index);
    if (entries.length === 0) return { text: "帳號清單：（空）" };
    const lines = entries.map(([id, info]) => `• \`${id}\` — ${info.role}（${info.displayName}）`);
    return { text: `**帳號清單（${entries.length} 個）**\n${lines.join("\n")}` };
  } catch (err) {
    return { text: `❌ ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
}

async function handleInfo(args: string, ctx: SkillContext): Promise<SkillResult> {
  const { positionals } = parseFlags(args);
  try {
    const { getAccountRegistry, resolveDiscordIdentity } = await import("../../core/platform.js");
    const registry = getAccountRegistry();

    let targetId = positionals[0];
    if (!targetId) {
      const resolved = resolveDiscordIdentity(ctx.authorId, []);
      targetId = resolved.accountId;
    }

    const account = registry.get(targetId);
    if (!account) return { text: `❌ 找不到帳號：${targetId}`, isError: true };

    const ids = account.identities.map(i => `${i.platform}:${i.platformId}`).join(", ") || "（無）";
    return {
      text: [
        `**帳號：\`${account.accountId}\`**`,
        `顯示名：${account.displayName}`,
        `角色：${account.role}`,
        `綁定：${ids}`,
        `建立：${account.createdAt.slice(0, 10)}`,
      ].join("\n"),
    };
  } catch (err) {
    return { text: `❌ ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
}

async function handleLink(args: string, _ctx: SkillContext): Promise<SkillResult> {
  const { positionals, flags } = parseFlags(args);
  const accountId = positionals[0];
  if (!accountId) return { text: "❌ 用法：`/account link <id> --discord <discordId>`", isError: true };

  const discordId = flags["discord"];
  if (!discordId) return { text: "❌ 缺少 --discord <discordId>", isError: true };

  try {
    const { getIdentityLinker } = await import("../../accounts/identity-linker.js");
    const result = getIdentityLinker().linkDirect(accountId, "discord", discordId);
    if (!result.ok) return { text: `❌ ${result.reason}`, isError: true };
    return { text: `✅ 已綁定：\`${accountId}\` ← discord:${discordId}` };
  } catch (err) {
    return { text: `❌ ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
}

// ── Skill 定義 ────────────────────────────────────────────────────────────────

export const skill: Skill = {
  name: "account",
  description: "帳號管理：建立、邀請、配對批准、列表、資訊、身份綁定",
  tier: "admin",
  trigger: ["/account"],

  async execute(ctx: SkillContext): Promise<SkillResult> {
    const { args } = ctx;
    const tokens = args.trim().split(/\s+/);
    const sub = (tokens[0] ?? "").toLowerCase();
    const rest = tokens.slice(1).join(" ");

    log.debug(`[skill:account] sub=${sub}`);

    switch (sub) {
      case "create":   return handleCreate(rest, ctx);
      case "invite":   return handleInvite(rest, ctx);
      case "approve":  return handleApprove(rest, ctx);
      case "pairings": return handlePairings(rest, ctx);
      case "list":     return handleList(rest, ctx);
      case "info":     return handleInfo(rest, ctx);
      case "link":     return handleLink(rest, ctx);
      default:
        return {
          text: [
            "**`/account` 子命令**",
            "• `create <id> --role <role> [--discord <id>]` — 建立帳號",
            "• `invite [--role member] [--expires 24]` — 產生邀請碼",
            "• `approve <code> --name <id> [--role member]` — 批准配對",
            "• `pairings` — 列出待審批配對",
            "• `list` — 列出所有帳號",
            "• `info [<id>]` — 查看帳號資訊",
            "• `link <id> --discord <id>` — 直接綁定身份",
          ].join("\n"),
        };
    }
  },
};
