/**
 * @file reply.ts
 * @description Discord 回覆邏輯：串流 AcpEvent → 分段傳送訊息或上傳檔案
 *
 * 核心功能：
 * - 累積 text_delta，達 2000 字（Discord API 上限）時自動切割
 * - 回覆超過 fileUploadThreshold 時改為上傳 .md 檔案
 * - Code fence 跨 chunk 平衡：奇數個 ``` 時自動補關/補開
 * - 第一段用 message.reply()，後續用 channel.send()
 * - tool_call event → 可透過 config.showToolCalls 控制是否顯示
 * - error event → 傳送錯誤訊息
 *
 * 使用方式：
 *   const onEvent = createReplyHandler(message, config);
 *   enqueue(channelId, text, onEvent, opts);
 */

import { AttachmentBuilder, type Message, type SendableChannels } from "discord.js";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { AcpEvent } from "./acp.js";
import type { BridgeConfig } from "./config.js";
import { log } from "./logger.js";

// Discord 訊息字數硬上限
const TEXT_LIMIT = 2000;

// ── 工具函式 ────────────────────────────────────────────────────────────────

/**
 * 計算字串中 ``` 出現的次數
 * 奇數次 → 有未閉合的 code fence
 */
function countCodeFences(text: string): number {
  return (text.match(/```/g) ?? []).length;
}

/**
 * 若 text 有奇數個 ```（未閉合），在尾端補上 ``` 關閉
 */
function closeFenceIfOpen(text: string): string {
  return countCodeFences(text) % 2 !== 0 ? text + "\n```" : text;
}

// ── MEDIA token 解析 ─────────────────────────────────────────────────────────

/** MEDIA token 正規表達式：MEDIA: /path/to/file 或 MEDIA: `path with spaces` */
const MEDIA_RE = /\bMEDIA:\s*`?([^\n`]+)`?/gi;

/**
 * 從文字中抽取 MEDIA: token，回傳清理後的文字 + 檔案路徑
 *
 * 範例輸入："這是報告 MEDIA: /tmp/report.md"
 * 回傳：{ text: "這是報告", mediaPaths: ["/tmp/report.md"] }
 */
function extractMediaTokens(raw: string): {
  text: string;
  mediaPaths: string[];
} {
  const mediaPaths: string[] = [];

  const text = raw
    .replace(MEDIA_RE, (_, path: string) => {
      const trimmed = path.trim();
      // 只接受絕對路徑（/ 開頭），避免誤抓
      if (trimmed.startsWith("/")) {
        mediaPaths.push(trimmed);
      }
      return "";
    })
    .replace(/\n{3,}/g, "\n\n") // 清理移除 token 後的多餘空行
    .trim();

  return { text, mediaPaths };
}

/**
 * 讀取檔案並上傳到 Discord 作為附件
 */
async function uploadMediaFile(
  filePath: string,
  originalMessage: Message,
  isFirst: boolean,
): Promise<boolean> {
  try {
    const buffer = await readFile(filePath);
    const fileName = basename(filePath);
    const attachment = new AttachmentBuilder(buffer, { name: fileName });

    const payload = { files: [attachment] };

    if (isFirst) {
      await originalMessage.reply(payload);
    } else {
      const channel = originalMessage.channel as SendableChannels;
      await channel.send(payload);
    }

    log.info(`[reply] 已上傳附件：${fileName} (${buffer.length} bytes)`);
    return true;
  } catch (err) {
    log.warn(`[reply] 附件上傳失敗：${filePath} — ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

// ── 傳送函式 ────────────────────────────────────────────────────────────────

/**
 * 傳送一段訊息到 Discord
 * 第一段（isFirst = true）用 message.reply()，之後用 channel.send()
 */
async function sendChunk(
  content: string,
  originalMessage: Message,
  isFirst: boolean
): Promise<void> {
  if (!content.trim()) return;

  if (isFirst) {
    await originalMessage.reply(content);
  } else {
    // NOTE: PartialGroupDMChannel 沒有 send，但 bot 不會在 Group DM 中使用，直接 cast
    const channel = originalMessage.channel as SendableChannels;
    await channel.send(content);
  }
}

/**
 * 上傳檔案到 Discord
 *
 * @param content 檔案內容（UTF-8 文字）
 * @param fileName 檔案名稱（例如 "response.md"）
 * @param originalMessage 用於 reply 的原始訊息
 * @param isFirst 是否為第一則回覆
 * @param preview 訊息預覽文字（可選）
 */
async function sendFile(
  content: string,
  fileName: string,
  originalMessage: Message,
  isFirst: boolean,
  preview?: string
): Promise<void> {
  const attachment = new AttachmentBuilder(Buffer.from(content, "utf-8"), {
    name: fileName,
  });

  const payload = {
    content: preview ?? undefined,
    files: [attachment],
  };

  if (isFirst) {
    await originalMessage.reply(payload);
  } else {
    const channel = originalMessage.channel as SendableChannels;
    await channel.send(payload);
  }
}

// ── 主要 API ────────────────────────────────────────────────────────────────

/**
 * 建立 AcpEvent 回呼處理器，用於接收 session.ts 的 onEvent 回呼
 *
 * 回傳的函式每次收到 AcpEvent 都會：
 * - text_delta → 累積文字，短回覆分段傳送，長回覆等 done 時上傳 .md
 * - tool_call  → 若 showToolCalls 開啟則傳送 🔧 提示
 * - done       → 短回覆 flush；長回覆上傳 .md 檔案
 * - error      → flush buffer + 傳送錯誤訊息
 * - status     → 靜默忽略
 *
 * @param originalMessage 觸發此 turn 的 Discord 訊息（用於 reply）
 * @param bridgeConfig 全域設定
 * @returns async event handler，可直接傳給 session.enqueue 的 onEvent 參數
 */
export function createReplyHandler(
  originalMessage: Message,
  bridgeConfig: BridgeConfig
): (event: AcpEvent) => Promise<void> {
  let buffer = "";
  let isFirst = true;

  // 累積完整文字（用於判斷是否超過 fileUploadThreshold）
  let totalText = "";
  // 是否已切換為檔案模式（停止分段傳送，等 done 時上傳）
  let fileMode = false;
  const threshold = bridgeConfig.fileUploadThreshold;

  // ── Typing indicator ──
  // Discord typing 持續約 10 秒，每 8 秒重發一次，直到第一則回覆送出
  const channel = originalMessage.channel;
  if ("sendTyping" in channel) {
    void (channel as SendableChannels).sendTyping();
  }
  const typingInterval = setInterval(() => {
    if ("sendTyping" in channel) {
      void (channel as SendableChannels).sendTyping();
    }
  }, 8_000);
  // typing 清理函式，送出第一則回覆後呼叫
  const stopTyping = () => clearInterval(typingInterval);
  // NOTE: 追蹤上一個 chunk 末尾是否有未閉合 code fence
  //       若有，下一個 chunk 開頭要補開
  let prevChunkHadOpenFence = false;

  /**
   * 將 buffer 切割成 <= TEXT_LIMIT 的 chunk 並傳送
   * @param flushAll 若 true，連最後不足 TEXT_LIMIT 的部分也傳送
   */
  async function flush(flushAll = false): Promise<void> {
    while (buffer.length >= TEXT_LIMIT || (flushAll && buffer.length > 0)) {
      let chunk = buffer.slice(0, TEXT_LIMIT);
      buffer = buffer.slice(TEXT_LIMIT);

      // 補開：若上一個 chunk 有未閉合 fence，這個 chunk 開頭補 ```
      if (prevChunkHadOpenFence) {
        chunk = "```\n" + chunk;
      }

      // 補關：若這個 chunk 有未閉合 fence，尾端補 ```
      const hadOpenFence = countCodeFences(chunk) % 2 !== 0;
      const toSend = hadOpenFence ? closeFenceIfOpen(chunk) : chunk;

      prevChunkHadOpenFence = hadOpenFence;

      await sendChunk(toSend, originalMessage, isFirst);
      if (isFirst) stopTyping(); // 第一則回覆送出 → 停止 typing
      isFirst = false;
    }
  }

  return async (event: AcpEvent): Promise<void> => {
    if (event.type === "text_delta") {
      totalText += event.text;

      if (fileMode) {
        // 已進入檔案模式，只累積不傳送，等 done 時上傳
        return;
      }

      // 檢查是否應切換為檔案模式
      if (threshold > 0 && totalText.length > threshold) {
        fileMode = true;
        // 不再送出新的 chunk，buffer 清空（已送出的就算了）
        buffer = "";
        return;
      }

      buffer += event.text;
      await flush(false);
    } else if (event.type === "tool_call") {
      if (bridgeConfig.showToolCalls) {
        if (!fileMode) {
          await flush(true);
        }
        await sendChunk(`🔧 使用工具：${event.title}`, originalMessage, isFirst);
        if (isFirst) stopTyping();
        isFirst = false;
      }
    } else if (event.type === "done") {
      stopTyping();

      // 先從完整文字中抽取 MEDIA token
      const { text: cleanedText, mediaPaths } = extractMediaTokens(totalText);

      if (fileMode && mediaPaths.length === 0) {
        // 長回覆且無 MEDIA token → 上傳完整內容為 .md 檔案
        // NOTE: 若有 MEDIA token，優先以 MEDIA 指定的檔案為主，不再額外產生 response.md
        const preview = cleanedText.slice(0, 150).replace(/\n/g, " ") + "...";
        await sendFile(cleanedText, "response.md", originalMessage, isFirst, preview);
        isFirst = false;
      } else if (!fileMode) {
        // 短回覆 → 清理 buffer 中的 MEDIA token 再 flush
        // NOTE: 已送出的 chunk 無法回收，但 MEDIA token 通常在回覆末尾
        const { text: cleanedBuffer } = extractMediaTokens(buffer);
        buffer = cleanedBuffer;
        await flush(true);
      }

      // 上傳所有 MEDIA 指定的檔案
      for (const filePath of mediaPaths) {
        const uploaded = await uploadMediaFile(filePath, originalMessage, isFirst);
        if (uploaded) isFirst = false;
      }
    } else if (event.type === "error") {
      stopTyping();
      if (!fileMode) {
        await flush(true);
      }
      await sendChunk(
        `⚠️ 發生錯誤：${event.message}`,
        originalMessage,
        isFirst
      );
      isFirst = false;
    }
    // status event 靜默忽略
  };
}
