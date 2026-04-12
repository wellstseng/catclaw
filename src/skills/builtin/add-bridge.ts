/**
 * @file skills/builtin/add-bridge.ts
 * @description /add-bridge — 新增一條 CLI Bridge 並驗證上線
 *
 * 用法：
 *   /add-bridge label=<unique> channel=<id> cwd=<absPath>
 *               [token=<botToken>] [skipPerms=true] [thinking=true]
 *               [editInterval=800] [keepAlive=0]
 *
 * 流程：
 *   1. 解析 + 驗證參數
 *   2. workingDir 存在性檢查
 *   3. loadAllCliBridgeConfigs：唯一性檢查（idempotent on label）
 *   4. 組裝 entry → saveCliBridgeConfigs（觸發 hot-reload）
 *   5. 輪詢 getCliBridgeByLabel + status，最多 ~6s
 *   6. 失敗 rollback：移除 entry、save、回報 stderr
 *
 * 設計對齊：1d67076 之後 bridge 變更一律走 saveCliBridgeConfigs，
 * 不再 in-place mutate，避免雙重啟 race。
 */

import { existsSync, statSync } from "node:fs";
import type { Skill, SkillContext, SkillResult } from "../types.js";
import {
  loadAllCliBridgeConfigs,
  saveCliBridgeConfigs,
  getCliBridgeByLabel,
} from "../../cli-bridge/index.js";
import type { CliBridgeConfig } from "../../cli-bridge/types.js";

interface ParsedArgs {
  label?: string;
  channel?: string;
  cwd?: string;
  token?: string;
  skipPerms?: boolean;
  thinking?: boolean;
  editInterval?: number;
  keepAlive?: number;
}

export function parseArgs(raw: string): ParsedArgs {
  const out: ParsedArgs = {};
  const re = /(\w+)=("([^"]*)"|(\S+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const key = m[1];
    const val = m[3] ?? m[4] ?? "";
    switch (key) {
      case "label": out.label = val; break;
      case "channel": case "channelId": out.channel = val; break;
      case "cwd": case "workingDir": out.cwd = val; break;
      case "token": case "botToken": out.token = val; break;
      case "skipPerms": case "dangerouslySkipPermissions":
        out.skipPerms = val === "true" || val === "1"; break;
      case "thinking": case "showThinking":
        out.thinking = val === "true" || val === "1"; break;
      case "editInterval": case "editIntervalMs":
        out.editInterval = Number(val); break;
      case "keepAlive": case "keepAliveIntervalMs":
        out.keepAlive = Number(val); break;
    }
  }
  return out;
}

function isAdmin(ctx: SkillContext): boolean {
  const admin = ctx.config.admin as { allowedUserIds?: string[] } | undefined;
  return admin?.allowedUserIds?.includes(ctx.authorId) ?? false;
}

function usage(): SkillResult {
  return {
    text: [
      "**`/add-bridge` 用法**",
      "`/add-bridge label=<unique> channel=<id> cwd=<absPath> [token=...] [skipPerms=true] [thinking=true] [editInterval=800] [keepAlive=0]`",
      "",
      "範例：",
      "`/add-bridge label=catclaw-dev channel=1485277764205547630 cwd=/Users/wellstseng/project/catclaw`",
    ].join("\n"),
  };
}

const POLL_INTERVAL_MS = 300;
const POLL_MAX_MS = 6000;

async function waitForBridge(label: string): Promise<{ status: string; sessionId: string | null } | null> {
  const start = Date.now();
  while (Date.now() - start < POLL_MAX_MS) {
    const b = getCliBridgeByLabel(label);
    if (b) {
      const status = b.status;
      if (status !== "restarting") {
        return { status, sessionId: b.getChannelConfig().sessionId ?? null };
      }
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  const b = getCliBridgeByLabel(label);
  if (b) return { status: b.status, sessionId: b.getChannelConfig().sessionId ?? null };
  return null;
}

export const skill: Skill = {
  name: "add-bridge",
  description: "新增 CLI Bridge 設定並驗證上線（admin）",
  tier: "admin",
  trigger: ["/add-bridge", "/addbridge"],

  async execute(ctx: SkillContext): Promise<SkillResult> {
    if (!isAdmin(ctx)) {
      return { text: "需要 admin 權限。", isError: true };
    }

    const args = parseArgs(ctx.args);
    if (!args.label || !args.channel || !args.cwd) {
      return usage();
    }

    // 預檢：workingDir
    if (!existsSync(args.cwd) || !statSync(args.cwd).isDirectory()) {
      return { text: `workingDir 不存在或不是目錄：\`${args.cwd}\``, isError: true };
    }

    // 載入並做唯一性檢查
    const all = loadAllCliBridgeConfigs();

    const labelHit = all.find(c => c.label === args.label);
    if (labelHit) {
      // idempotent：若 label + channel + cwd 完全一致，回報已存在
      const sameChannel = labelHit.channels[args.channel];
      if (sameChannel && labelHit.workingDir === args.cwd && labelHit.enabled) {
        const live = getCliBridgeByLabel(args.label);
        return {
          text: `Bridge \`${args.label}\` 已存在（status=${live?.status ?? "unknown"}），未做任何變更。`,
        };
      }
      return {
        text: `label \`${args.label}\` 已存在但設定不同；請先刪除或改用其他 label。`,
        isError: true,
      };
    }

    const channelOccupied = all.find(
      c => c.enabled && Object.keys(c.channels).includes(args.channel!),
    );
    if (channelOccupied) {
      return {
        text: `channel \`${args.channel}\` 已被 bridge \`${channelOccupied.label}\` 佔用。`,
        isError: true,
      };
    }

    // 組裝 entry
    const entry: CliBridgeConfig = {
      enabled: true,
      label: args.label,
      workingDir: args.cwd,
      channels: {
        [args.channel]: {
          label: args.label,
          dangerouslySkipPermissions: args.skipPerms ?? false,
        },
      },
    };
    if (args.token) entry.botToken = args.token;
    if (args.thinking !== undefined) entry.showThinking = args.thinking;
    if (args.editInterval !== undefined && Number.isFinite(args.editInterval)) {
      entry.editIntervalMs = args.editInterval;
    }
    if (args.keepAlive !== undefined && Number.isFinite(args.keepAlive)) {
      entry.keepAliveIntervalMs = args.keepAlive;
    }

    const next = [...all, entry];
    saveCliBridgeConfigs(next);

    // 等待 hot-reload 把 bridge 拉起
    const result = await waitForBridge(args.label);

    if (!result || result.status === "dead") {
      // rollback
      const rollback = loadAllCliBridgeConfigs().filter(c => c.label !== args.label);
      saveCliBridgeConfigs(rollback);
      const live = getCliBridgeByLabel(args.label);
      const stderr = (live as unknown as { _process?: { lastStderr?: string } } | undefined)?._process?.lastStderr;
      return {
        text: [
          `Bridge \`${args.label}\` 啟動失敗，已 rollback。`,
          stderr ? `stderr：\n\`\`\`\n${stderr.slice(-500)}\n\`\`\`` : "（無 stderr 輸出）",
        ].join("\n"),
        isError: true,
      };
    }

    return {
      text: [
        `已新增並啟動 CLI Bridge \`${args.label}\``,
        `- channel: \`${args.channel}\``,
        `- cwd: \`${args.cwd}\``,
        `- status: \`${result.status}\``,
        result.sessionId ? `- sessionId: \`${result.sessionId}\`` : "- sessionId: (待 CLI 初始化)",
      ].join("\n"),
    };
  },
};
