/**
 * @file cli-bridge/channel-naming.ts
 * @description 依 workingDir 自動更新 Discord channel / thread 名稱
 *
 * 規則：
 *   新頻道名 = <剝除舊 autoNameSuffix 後的 base> + SEPARATOR + basename(workingDir)
 *   若新舊名字相同 → skip；若 bot 缺 Manage Channels 權限（50013）→
 *   在頻道回覆一次警告提示，不 throw。
 *
 * 僅對 IndependentBotSender 有效（bridge 專屬 bot token）。
 */

import { DiscordAPIError, type GuildTextBasedChannel, type ThreadChannel } from "discord.js";
import { log } from "../logger.js";
import type { CliBridge } from "./bridge.js";
import type { BridgeSender } from "./discord-sender.js";

const SEPARATOR = "_";
const DISCORD_CHANNEL_NAME_MAX = 100;

/** 每個 channel 只提醒一次缺權限（避免每次 cd 洗版） */
const _warnedMissingPerm = new Set<string>();

/** 跨平台 basename：同時處理 POSIX "/" 與 Windows "\"，不依賴當前執行平台 */
function crossPlatformBasename(p: string): string {
  return p.split(/[/\\]/).filter(s => s.length > 0).pop() ?? "";
}

export function buildChannelName(
  currentName: string,
  lastSuffix: string | null | undefined,
  workingDir: string,
): { newName: string; basename: string } {
  const bn = sanitizeForDiscord(crossPlatformBasename(workingDir));
  let base = currentName;

  // 循環剝除歷史累積的尾綴（防疊加）：
  //   1. 先剝 lastSuffix（可能與當前 bn 不同，例如 cwd 從 X 切到 Y）
  //   2. 再循環剝 bn（歷史上可能已被加過多次，例如 "session1_catclaw_catclaw_catclaw"）
  if (lastSuffix && lastSuffix !== bn && base.endsWith(SEPARATOR + lastSuffix)) {
    base = base.slice(0, -(SEPARATOR.length + lastSuffix.length));
  }
  while (base.length > SEPARATOR.length + bn.length && base.endsWith(SEPARATOR + bn)) {
    base = base.slice(0, -(SEPARATOR.length + bn.length));
  }

  // 避免 base 已是空字串
  if (!base) base = bn;
  const composed = (base === bn ? bn : base + SEPARATOR + bn);
  const clipped = composed.slice(0, DISCORD_CHANNEL_NAME_MAX);
  return { newName: clipped, basename: bn };
}

/**
 * Discord channel 名稱限制：
 *  - 一般文字頻道：只允許小寫字母、數字、底線、連字號（大寫會被自動 lowercase）
 *  - Thread 相對寬鬆
 *  本函式做最保守處理：移除空白與連續底線
 */
function sanitizeForDiscord(name: string): string {
  return name
    .replace(/[\s\/\\]+/g, SEPARATOR)
    .replace(/_+/g, SEPARATOR)
    .replace(/^_+|_+$/g, "");
}

export async function applyAutoChannelName(bridge: CliBridge, sender: BridgeSender): Promise<void> {
  if (sender.mode !== "independent-bot") {
    // 主 bot fallback 的情況不動頻道名（權限不一定屬於 catclaw 管理範圍）
    return;
  }

  let client;
  try {
    client = (sender as import("./discord-sender.js").IndependentBotSender).getClient();
  } catch (err) {
    log.debug(`[cli-bridge:${bridge.label}] auto-name skip（client 未就緒）: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  let channel;
  try {
    channel = await client.channels.fetch(bridge.channelId);
  } catch (err) {
    log.warn(`[cli-bridge:${bridge.label}] auto-name: fetch channel 失敗：${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  if (!channel || !("name" in channel) || typeof channel.name !== "string") return;

  const workingDir = bridge.workingDir;
  const channelCfg = bridge.getChannelConfig();
  const lastSuffix = channelCfg.autoNameSuffix ?? null;

  const { newName, basename: newSuffix } = buildChannelName(channel.name, lastSuffix, workingDir);

  if (newName === channel.name) {
    // 已經是目標名稱 → 若 config 尚未記錄 suffix，補寫一次（idempotent）
    if (lastSuffix !== newSuffix) {
      await persistSuffix(bridge.channelId, newSuffix);
    }
    return;
  }

  try {
    const reason = `CatClaw cli-bridge cwd → ${workingDir}`;
    // TextChannel / ThreadChannel 都有 setName(name, reason?)
    await (channel as GuildTextBasedChannel | ThreadChannel).setName(newName, reason);
    log.info(`[cli-bridge:${bridge.label}] channel 改名：${channel.name} → ${newName}`);
    await persistSuffix(bridge.channelId, newSuffix);
    _warnedMissingPerm.delete(bridge.channelId); // 改名成功 → 重置警告
  } catch (err) {
    if (err instanceof DiscordAPIError && err.code === 50013) {
      log.warn(`[cli-bridge:${bridge.label}] 無 Manage Channels 權限，無法改名`);
      if (!_warnedMissingPerm.has(bridge.channelId)) {
        _warnedMissingPerm.add(bridge.channelId);
        try {
          await sender.send(
            `ℹ️ 無頻道更名權限。當前工作目錄：\`${workingDir}\``,
          );
        } catch { /* 連提示都送不出就放棄 */ }
      }
      return;
    }
    log.warn(`[cli-bridge:${bridge.label}] channel 改名失敗：${err instanceof Error ? err.message : String(err)}`);
  }
}

async function persistSuffix(channelId: string, suffix: string): Promise<void> {
  try {
    const { persistChannelAutoNameSuffix } = await import("./index.js");
    persistChannelAutoNameSuffix(channelId, suffix);
  } catch (err) {
    log.debug(`[cli-bridge] persistSuffix 失敗：${err instanceof Error ? err.message : String(err)}`);
  }
}
