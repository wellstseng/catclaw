/**
 * @file core/reply-handler.ts
 * @description AgentLoopEvent async generator → Discord 分段回覆
 *
 * 邏輯與 reply.ts 對齊（chunking / code fence / MEDIA token / typing indicator）
 * 差別：輸入是 AsyncGenerator<AgentLoopEvent>，非 AcpEvent callback。
 */

import { AttachmentBuilder, type Message, type SendableChannels } from "discord.js";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { AgentLoopEvent } from "./agent-loop.js";
import type { BridgeConfig } from "../config.js";
import { log } from "../logger.js";

// Discord 字數上限
const TEXT_LIMIT = 2000;
const FLUSH_DELAY_MS = 3000;

// ── 工具函式 ──────────────────────────────────────────────────────────────────

function countCodeFences(text: string): number {
  return (text.match(/```/g) ?? []).length;
}

function closeFenceIfOpen(text: string): string {
  return countCodeFences(text) % 2 !== 0 ? text + "\n```" : text;
}

const MEDIA_RE = /\bMEDIA:\s*`?([^\n`]+)`?/gi;
const WINDOWS_ABS_PATH_RE = /^[a-zA-Z]:[\\/]/;

function extractMediaTokens(raw: string): { text: string; mediaPaths: string[] } {
  const mediaPaths: string[] = [];
  const text = raw
    .replace(MEDIA_RE, (_, path: string) => {
      const trimmed = path.trim();
      if (trimmed.startsWith("/") || WINDOWS_ABS_PATH_RE.test(trimmed)) {
        mediaPaths.push(trimmed);
      }
      return "";
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text, mediaPaths };
}

async function uploadMediaFile(filePath: string, originalMessage: Message, isFirst: boolean): Promise<boolean> {
  try {
    const buffer = await readFile(filePath);
    const attachment = new AttachmentBuilder(buffer, { name: basename(filePath) });
    const payload = { files: [attachment] };
    if (isFirst) {
      await originalMessage.reply(payload);
    } else {
      await (originalMessage.channel as SendableChannels).send(payload);
    }
    log.info(`[reply-handler] 已上傳附件：${basename(filePath)} (${buffer.length} bytes)`);
    return true;
  } catch (err) {
    log.warn(`[reply-handler] 附件上傳失敗：${filePath} — ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

async function sendChunk(content: string, originalMessage: Message, isFirst: boolean): Promise<void> {
  if (!content.trim()) return;
  if (isFirst) {
    await originalMessage.reply(content);
  } else {
    await (originalMessage.channel as SendableChannels).send(content);
  }
}

async function sendFile(content: string, fileName: string, originalMessage: Message, isFirst: boolean, preview?: string): Promise<void> {
  const attachment = new AttachmentBuilder(Buffer.from(content, "utf-8"), { name: fileName });
  const payload = { content: preview ?? undefined, files: [attachment] };
  if (isFirst) {
    await originalMessage.reply(payload);
  } else {
    await (originalMessage.channel as SendableChannels).send(payload);
  }
}

// ── 主要 API ──────────────────────────────────────────────────────────────────

/**
 * 消費 AgentLoop async generator，串流回覆到 Discord
 */
export async function handleAgentLoopReply(
  gen: AsyncGenerator<AgentLoopEvent>,
  originalMessage: Message,
  bridgeConfig: BridgeConfig,
): Promise<void> {
  let buffer = "";
  let totalText = "";
  let fileMode = false;
  let isFirst = true;
  let prevChunkHadOpenFence = false;
  let summaryHintSent = false;
  let thinkingBuffer = "";

  const threshold = bridgeConfig.fileUploadThreshold;
  const toolMode = bridgeConfig.showToolCalls;

  // Typing indicator
  const channel = originalMessage.channel;
  if ("sendTyping" in channel) void (channel as SendableChannels).sendTyping();
  const typingInterval = setInterval(() => {
    if ("sendTyping" in channel) void (channel as SendableChannels).sendTyping();
  }, 8_000);
  const stopTyping = () => clearInterval(typingInterval);

  // Flush timer
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let flushing = false;

  function scheduleFlush(): void {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(() => {
      flushTimer = null;
      if (flushing) return;
      flushing = true;
      void (async () => {
        if (thinkingBuffer.length > 0) await flushThinking();
        if (buffer.length > 0 && !fileMode) await flush(true);
      })().finally(() => { flushing = false; });
    }, FLUSH_DELAY_MS);
  }

  function cancelFlushTimer(): void {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  }

  async function flush(flushAll = false): Promise<void> {
    while (buffer.length >= TEXT_LIMIT || (flushAll && buffer.length > 0)) {
      const safeLimit = TEXT_LIMIT - 8;
      let chunk = buffer.slice(0, safeLimit);
      buffer = buffer.slice(safeLimit);

      if (prevChunkHadOpenFence) chunk = "```\n" + chunk;
      const hadOpenFence = countCodeFences(chunk) % 2 !== 0;
      const toSend = hadOpenFence ? closeFenceIfOpen(chunk) : chunk;
      prevChunkHadOpenFence = hadOpenFence;

      await sendChunk(toSend, originalMessage, isFirst);
      if (isFirst) stopTyping();
      isFirst = false;
    }
  }

  async function flushThinking(): Promise<void> {
    if (!thinkingBuffer.trim()) return;
    const formatted = thinkingBuffer.trim().split("\n").map(l => `> ${l}`).join("\n");
    const toSend = `> 💭 **Thinking**\n${formatted}`;
    let remaining = toSend;
    while (remaining.length > 0) {
      await sendChunk(remaining.slice(0, TEXT_LIMIT), originalMessage, isFirst);
      isFirst = false;
      remaining = remaining.slice(TEXT_LIMIT);
    }
    thinkingBuffer = "";
  }

  try {
    for await (const event of gen) {
      if (event.type === "thinking") {
        if (bridgeConfig.showThinking) {
          thinkingBuffer += event.thinking;
          scheduleFlush();
        }

      } else if (event.type === "text_delta") {
        if (thinkingBuffer.length > 0) {
          cancelFlushTimer();
          await flushThinking();
        }
        totalText += event.text;

        if (fileMode) continue;

        if (threshold > 0 && totalText.length > threshold) {
          fileMode = true;
          cancelFlushTimer();
          buffer = "";
          continue;
        }

        buffer += event.text;
        if (buffer.length >= TEXT_LIMIT) {
          cancelFlushTimer();
          await flush(false);
        } else {
          scheduleFlush();
        }

      } else if (event.type === "tool_start") {
        if (toolMode === "all") {
          cancelFlushTimer();
          if (!fileMode) await flush(true);
          await sendChunk(`🔧 使用工具：${event.name}`, originalMessage, isFirst);
          if (isFirst) stopTyping();
          isFirst = false;
        } else if (toolMode === "summary" && !summaryHintSent) {
          cancelFlushTimer();
          if (!fileMode) await flush(true);
          await sendChunk("⏳ 處理中...", originalMessage, isFirst);
          if (isFirst) stopTyping();
          isFirst = false;
          summaryHintSent = true;
        }

      } else if (event.type === "tool_blocked") {
        if (toolMode !== "none") {
          cancelFlushTimer();
          if (!fileMode) await flush(true);
          await sendChunk(`🚫 工具被阻擋：${event.name} — ${event.reason}`, originalMessage, isFirst);
          if (isFirst) stopTyping();
          isFirst = false;
        }

      } else if (event.type === "done") {
        cancelFlushTimer();
        stopTyping();

        const { text: cleanedText, mediaPaths } = extractMediaTokens(totalText);

        if (fileMode && mediaPaths.length === 0) {
          const preview = cleanedText.slice(0, 150).replace(/\n/g, " ") + "...";
          await sendFile(cleanedText, "response.md", originalMessage, isFirst, preview);
          isFirst = false;
        } else {
          if (fileMode) {
            buffer = cleanedText;
          } else {
            const { text: cleanedBuffer } = extractMediaTokens(buffer);
            buffer = cleanedBuffer;
          }
          await flush(true);
        }

        for (const filePath of mediaPaths) {
          const uploaded = await uploadMediaFile(filePath, originalMessage, isFirst);
          if (uploaded) isFirst = false;
        }

      } else if (event.type === "error") {
        cancelFlushTimer();
        stopTyping();
        if (!fileMode) await flush(true);
        const errorMsg = `⚠️ ${event.message}`.slice(0, TEXT_LIMIT);
        await sendChunk(errorMsg, originalMessage, isFirst);
        isFirst = false;
      }
    }
  } finally {
    cancelFlushTimer();
    stopTyping();
  }
}
