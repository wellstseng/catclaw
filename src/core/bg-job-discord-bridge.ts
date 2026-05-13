/**
 * @file core/bg-job-discord-bridge.ts
 * @description Background Job → Discord 通知 fallback
 *
 * 當 background job 完成但 parent reply-handler 已退場時，這條路徑直接 send
 * Discord 確保使用者收到通知。對應 subagent 的 sendSubagentNotification 同模式。
 */

import { TextChannel } from "discord.js";
import { existsSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { getDiscordClient } from "./subagent-discord-bridge.js";
import type { BackgroundJobRecord } from "./background-job-registry.js";
import { log } from "../logger.js";

/** 讀檔尾 N 行（最多 8KB）— 失敗時用來附上 process 死前最後輸出 */
function tailLog(path: string, lines: number): string {
  try {
    if (!existsSync(path)) return "(stdout 檔不存在)";
    const stat = statSync(path);
    const maxBytes = 8_000;
    const buf = Buffer.alloc(Math.min(maxBytes, stat.size));
    const fd = openSync(path, "r");
    try {
      readSync(fd, buf, 0, buf.length, Math.max(0, stat.size - maxBytes));
    } finally {
      closeSync(fd);
    }
    const all = buf.toString("utf-8").split("\n").filter(l => l.length > 0);
    return all.slice(-lines).join("\n") || "(stdout 為空)";
  } catch (err) {
    return `(讀取失敗：${err instanceof Error ? err.message : String(err)})`;
  }
}

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
      // 失敗時附 stdout 尾段（process 死前最後輸出，幫 user 立刻看到診斷資訊）
      const tail = record.stdoutPath ? tailLog(record.stdoutPath, 10) : "";
      const tailBlock = tail
        ? `\n**stdout 尾 10 行：**\n\`\`\`\n${tail.length > 1500 ? tail.slice(-1500) : tail}\n\`\`\``
        : "";
      await textChannel.send(`❌ **背景 Job 失敗**：${record.label}${exit}（${dur}s）${reasonLine}${stdoutLine}${tailBlock}`);
    }
  } catch (err) {
    log.warn(`[bg-job-discord-bridge] 通知失敗：${err instanceof Error ? err.message : String(err)}`);
  }
}
