/**
 * @file core/bg-job-discord-bridge.ts
 * @description Background Job → Discord 通知 fallback
 *
 * 當 background job 完成但 parent reply-handler 已退場時，這條路徑直接 send
 * Discord 確保使用者收到通知。對應 subagent 的 sendSubagentNotification 同模式。
 */

import { TextChannel } from "discord.js";
import { getDiscordClient } from "./subagent-discord-bridge.js";
import type { BackgroundJobRecord } from "./background-job-registry.js";
import { log } from "../logger.js";

export async function sendBgJobNotification(
  record: BackgroundJobRecord,
  opts: { type: "completed" | "failed"; reason?: string },
): Promise<void> {
  const client = getDiscordClient();
  if (!client || !record.discordChannelId) return;

  try {
    const channel = await client.channels.fetch(record.discordChannelId);
    if (!channel || !("send" in channel)) return;
    const textChannel = channel as TextChannel;

    const dur = record.endedAt
      ? Math.round((record.endedAt - record.startedAt) / 1000)
      : Math.round((Date.now() - record.startedAt) / 1000);
    const exit = record.exitCode != null ? `（exitCode=${record.exitCode}）` : "";

    if (opts.type === "completed") {
      const stdoutLine = record.stdoutPath ? `\nstdout: \`${record.stdoutPath}\`` : "";
      const expectedLine = record.expectedOutputs?.length
        ? `\n預期輸出（${record.expectedOutputs.length} 個）：` + record.expectedOutputs.slice(0, 3).map(p => "\n  " + p).join("")
        : "";
      await textChannel.send(`✅ **背景 Job 完成**：${record.label}${exit}（${dur}s）${stdoutLine}${expectedLine}`);
    } else {
      const reasonLine = opts.reason ? `\n原因：${opts.reason}` : "";
      const stdoutLine = record.stdoutPath ? `\nstdout: \`${record.stdoutPath}\`` : "";
      await textChannel.send(`❌ **背景 Job 失敗**：${record.label}${exit}（${dur}s）${reasonLine}${stdoutLine}`);
    }
  } catch (err) {
    log.warn(`[bg-job-discord-bridge] 通知失敗：${err instanceof Error ? err.message : String(err)}`);
  }
}
