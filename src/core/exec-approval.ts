/**
 * @file core/exec-approval.ts
 * @description 執行指令 DM 確認機制
 *
 * 流程 A（文字回覆，相容舊版）：
 *   agent-loop 偵測到 run_command → createApproval()
 *   → sendDm 送含 approvalId 的訊息
 *   → 使用者回覆 ✅ <id> 或 ❌ <id>
 *   → discord.ts 呼叫 resolveApproval()
 *
 * 流程 B（Discord 按鈕，優先）：
 *   → sendDmWithButtons 附加 ActionRow 按鈕
 *   → 使用者點擊按鈕
 *   → discord.ts interactionCreate 呼叫 resolveApproval()
 *
 * 路徑白名單：
 *   allowedPatterns：指令符合任一 pattern（substring match）→ 自動允許，不送 DM
 */

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, type Client } from "discord.js";

// ── 型別 ─────────────────────────────────────────────────────────────────────

interface PendingApproval {
  approvalId: string;
  command: string;
  channelId: string;
  resolve: (approved: boolean) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

// ── Store ────────────────────────────────────────────────────────────────────

const _pending = new Map<string, PendingApproval>();

/** Discord client 引用（送 DM 按鈕用） */
let _discordClient: Client | null = null;

export function setApprovalDiscordClient(client: Client): void {
  _discordClient = client;
}

/**
 * 建立一個等待確認的 pending entry，回傳 Promise<boolean>。
 */
export function createApproval(
  command: string,
  channelId: string,
  timeoutMs: number,
): [string, Promise<boolean>] {
  const approvalId = Math.random().toString(36).slice(2, 8).toUpperCase();
  const promise = new Promise<boolean>((resolve) => {
    const timeoutHandle = setTimeout(() => {
      _pending.delete(approvalId);
      resolve(false);
    }, timeoutMs);

    _pending.set(approvalId, { approvalId, command, channelId, resolve, timeoutHandle });
  });

  return [approvalId, promise];
}

/**
 * 解析使用者回覆，回傳是否找到對應 pending。
 */
export function resolveApproval(approvalId: string, approved: boolean): boolean {
  const entry = _pending.get(approvalId);
  if (!entry) return false;
  clearTimeout(entry.timeoutHandle);
  _pending.delete(approvalId);
  entry.resolve(approved);
  return true;
}

/**
 * 解析 DM 訊息文字，嘗試找出 ✅/❌ + approvalId 格式（文字回覆相容）。
 */
export function parseApprovalReply(text: string): { approved: boolean; approvalId: string } | null {
  const match = text.trim().match(/^([✅❌])\s*([A-Z0-9]{6})$/i);
  if (!match) return null;
  return {
    approved: match[1] === "✅",
    approvalId: match[2].toUpperCase(),
  };
}

/**
 * 解析 Discord 按鈕 interaction 的 customId，格式：`approval_allow_ABCDEF` 或 `approval_deny_ABCDEF`
 */
export function parseApprovalButtonId(customId: string): { approved: boolean; approvalId: string } | null {
  const match = customId.match(/^approval_(allow|deny)_([A-Z0-9]{6})$/i);
  if (!match) return null;
  return {
    approved: match[1].toLowerCase() === "allow",
    approvalId: match[2].toUpperCase(),
  };
}

/**
 * 送出帶有 ✅/❌ 按鈕的 DM 確認訊息。
 * 若 Discord client 不可用，fallback 到純文字指示。
 */
export async function sendApprovalDm(opts: {
  dmUserId: string;
  command: string;
  channelId: string;
  approvalId: string;
  timeoutMs: number;
  /** fallback：若沒有 Discord client，用此函式送純文字 DM */
  sendTextFallback: (userId: string, text: string) => Promise<void>;
}): Promise<void> {
  const timeoutSec = Math.round(opts.timeoutMs / 1000);
  const commandDisplay = opts.command.length > 1500
    ? opts.command.slice(0, 1500) + "\n...[截斷]"
    : opts.command;

  const baseContent = [
    `🔐 **CatClaw 執行確認**`,
    `頻道：<#${opts.channelId}>`,
    `指令：\`\`\`\n${commandDisplay}\n\`\`\``,
  ].join("\n");

  if (_discordClient) {
    try {
      const user = await _discordClient.users.fetch(opts.dmUserId);
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`approval_allow_${opts.approvalId}`)
          .setLabel("✅ 允許")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`approval_deny_${opts.approvalId}`)
          .setLabel("❌ 拒絕")
          .setStyle(ButtonStyle.Danger),
      );
      await user.send({
        content: baseContent + `\n（${timeoutSec}s 後自動拒絕）`,
        components: [row],
      });
      return;
    } catch {
      // fallback to text
    }
  }

  // Fallback：純文字指示
  await opts.sendTextFallback(
    opts.dmUserId,
    baseContent + `\n回覆 \`✅ ${opts.approvalId}\` 允許，\`❌ ${opts.approvalId}\` 拒絕（${timeoutSec}s 後自動拒絕）`,
  );
}

/**
 * 檢查指令是否符合白名單 pattern（substring match）。
 * 符合 → 自動允許，不需 DM 確認。
 */
export function isCommandAllowed(command: string, allowedPatterns: string[]): boolean {
  if (allowedPatterns.length === 0) return false;
  return allowedPatterns.some(p => command.includes(p));
}

/** 目前等待中的數量（debug 用） */
export function pendingCount(): number {
  return _pending.size;
}
