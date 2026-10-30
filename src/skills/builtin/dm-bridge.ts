/**
 * @file skills/builtin/dm-bridge.ts
 * @description /dm — 把「私訊茱蒂」切到本機的 CLI Bridge，或切回（admin）
 *
 * 觸發：/dm, /私訊, 把私訊切成cli bridge, 私訊切成cli bridge, 把私訊切回, 私訊切回
 *
 * 子命令：
 *   /dm on | 開       本機開始接私訊（設定檔不存在就用平台預設新建）
 *   /dm off | 關      本機停止接私訊（設定保留，只改 enabled）
 *   /dm status | 狀態  看本機現況（預設）
 *
 * 設定檔：~/.catclaw/cli-bridge-dm.json（格式見 cli-bridge/dm.ts DmBridgeConfig）
 * 收私訊的 bot：cli-bridge-dm.json.botToken → cli-bridges.json 任一條 → catclaw.json 主 bot（預設就能用）
 * 多機：每台機器各自接自己名單上的人（名單外靜默不回），兩台可同時開；
 *       同一個人不要出現在兩台的名單，否則會被回兩次。
 *
 * tier: admin
 */

import { hostname } from "node:os";
import type { Skill, SkillContext, SkillResult } from "../types.js";
import { setDmBridgeEnabled, getDmBridgeStatus, ensureDmListener } from "../../cli-bridge/dm.js";
import type { DmToggleResult } from "../../cli-bridge/dm.js";

const ON_TRIGGERS = ["把私訊切成cli bridge", "私訊切成cli bridge"];
const OFF_TRIGGERS = ["把私訊切回", "私訊切回"];

function isAdmin(ctx: SkillContext): boolean {
  const admin = ctx.config.admin as { allowedUserIds?: string[] } | undefined;
  return admin?.allowedUserIds?.includes(ctx.authorId) ?? false;
}

/** 口令本身就帶動作（「把私訊切成cli bridge」= on）；/dm 則看第一個參數 */
function resolveAction(ctx: SkillContext): "on" | "off" | "status" | null {
  const text = (ctx.message?.content ?? "").toLowerCase().trim();
  if (ON_TRIGGERS.some(t => text.startsWith(t))) return "on";
  if (OFF_TRIGGERS.some(t => text.startsWith(t))) return "off";
  const arg = ctx.args.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (arg === "" || arg === "status" || arg === "狀態") return "status";
  if (arg === "on" || arg === "開" || arg === "開啟") return "on";
  if (arg === "off" || arg === "關" || arg === "關閉") return "off";
  return null;
}

function describe(r: DmToggleResult): string {
  return [
    `- 主機：\`${hostname()}\``,
    `- 設定檔：\`${r.path}\``,
    `- owner 工作目錄：\`${r.ownerWorkingDir}\``,
    `- 同事工作目錄根：\`${r.teamWorkspaceRoot}\``,
    `- 同事名單：${r.userCount} 人`,
    `- 收私訊的 bot：${r.botLabel}`,
  ].join("\n");
}

export const skill: Skill = {
  name: "dm-bridge",
  description: "把私訊切成本機 CLI Bridge／切回（admin）",
  tier: "admin",
  trigger: ["/dm", "/私訊", ...ON_TRIGGERS, ...OFF_TRIGGERS],

  async execute(ctx: SkillContext): Promise<SkillResult> {
    if (!isAdmin(ctx)) return { text: "需要 admin 權限。", isError: true };

    const action = resolveAction(ctx);
    if (!action) {
      return { text: "用法：`/dm on`（開）、`/dm off`（關）、`/dm status`（狀態）", isError: true, validation: true };
    }

    if (action === "status") {
      const r = getDmBridgeStatus();
      if (!r) return { text: `本機（\`${hostname()}\`）**未設定** DM bridge，私訊不會在這台接。\`/dm on\` 開啟。` };
      return { text: `本機 DM bridge：**${r.enabled ? "開啟" : "關閉"}**\n${describe(r)}` };
    }

    const ownerName = ctx.message?.author.displayName || ctx.message?.author.username || "owner";
    const r = setDmBridgeEnabled(action === "on", { userId: ctx.authorId, name: ownerName });
    const lines0: string[] = [];

    if (action === "off") {
      return { text: `本機（\`${hostname()}\`）已**停止**接私訊；設定保留在 \`${r.path}\`，\`/dm on\` 可再開。` };
    }

    const listener = await ensureDmListener().catch(err => {
      lines0.push(`❌ 收 DM 的 bot 登入失敗：${err instanceof Error ? err.message : String(err)}`);
      return "no-token" as const;
    });
    const lines = [`私訊已切到本機（\`${hostname()}\`）的 CLI Bridge ✅`, describe(r), ...lines0];
    if (listener === "no-token") {
      lines.push("", "❌ **這台沒有任何 bot token**（catclaw.json、cli-bridges.json、cli-bridge-dm.json 都沒有），私訊到不了這裡。");
    }
    if (r.created) {
      lines.push("", "⚠ 這台是第一次開，設定檔剛用預設值新建：名單只有你，同事請編輯 `users` 加入（可直接複製另一台的 `users` 區塊）。");
    }
    if (r.userCount === 0) {
      lines.push("", "目前沒有同事在名單上，同事私訊會被回「僅限授權成員」。");
    }
    lines.push("", "⚠ 每台機器只接自己名單上的人；同一個人若同時在兩台的名單，會被回兩次。");
    return { text: lines.join("\n") };
  },
};
