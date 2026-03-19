/**
 * @file discord.ts
 * @description Discord client 建立、訊息事件處理、debounce 合併
 *
 * 流程：
 * 1. 建立 discord.js Client（含所有必要 Intents + Partials）
 * 2. messageCreate 事件：
 *    a. 忽略 bot 自身訊息
 *    b. getChannelAccess() 查詢 per-channel 設定（allow / requireMention）
 *    c. strip mention prefix
 *    d. debounce（同一人 500ms 內多則訊息合併）
 *    e. 觸發 session.enqueue → reply.createReplyHandler
 */

import {
  Client,
  GatewayIntentBits,
  Partials,
  type Message,
} from "discord.js";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { BridgeConfig } from "./config.js";
import { getChannelAccess } from "./config.js";
import { enqueue } from "./session.js";
import { createReplyHandler } from "./reply.js";
import { log } from "./logger.js";

// ── 訊息去重 ─────────────────────────────────────────────────────────────────

/**
 * 已處理的 message ID 集合，防止 DM partial channel 導致重複觸發
 * 超過 1000 筆時整批清除（重複訊息不可能間隔這麼久）
 */
const processedMessages = new Set<string>();

// ── Debounce 內部狀態 ────────────────────────────────────────────────────────

/** debounce key → timer handle */
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** debounce key → 累積中的訊息行 */
const debounceBuffers = new Map<string, string[]>();

/** debounce key → 觸發 debounce 的第一則訊息（用於 reply） */
const debounceMessages = new Map<string, Message>();

// ── Debounce 函式 ────────────────────────────────────────────────────────────

/**
 * Debounce：同一人在 debounceMs 內的多則訊息合併成一則
 *
 * @param message Discord 訊息物件
 * @param text strip 後的訊息文字
 * @param config 全域設定
 * @param onFire 合併完成後的回呼，接收合併後文字 + 第一則訊息
 */
function debounce(
  message: Message,
  text: string,
  config: BridgeConfig,
  onFire: (combinedText: string, firstMessage: Message) => void
): void {
  // key 以 channelId:authorId 區分，避免不同人的訊息互相干擾
  const key = `${message.channelId}:${message.author.id}`;

  // 清除上一個 timer，重新計時
  const existing = debounceTimers.get(key);
  if (existing) clearTimeout(existing);

  // 累積訊息文字（多則用換行合併）
  const lines = debounceBuffers.get(key) ?? [];
  lines.push(text);
  debounceBuffers.set(key, lines);

  // 記錄第一則訊息（用於 reply）
  if (!debounceMessages.has(key)) {
    debounceMessages.set(key, message);
  }

  // 設定新 timer
  const timer = setTimeout(() => {
    const combinedText = (debounceBuffers.get(key) ?? []).join("\n");
    const firstMessage = debounceMessages.get(key) ?? message;

    // 清理狀態
    debounceTimers.delete(key);
    debounceBuffers.delete(key);
    debounceMessages.delete(key);

    onFire(combinedText, firstMessage);
  }, config.debounceMs);

  debounceTimers.set(key, timer);
}

// ── 附件下載 ─────────────────────────────────────────────────────────────────

/** 附件暫存根目錄 */
const UPLOAD_DIR = join(tmpdir(), "claude-discord-uploads");

/**
 * 下載 Discord 訊息中的附件到暫存目錄
 * @param message Discord 訊息物件
 * @returns 已下載檔案的本地路徑陣列（空陣列 = 無附件）
 */
async function downloadAttachments(message: Message): Promise<string[]> {
  if (message.attachments.size === 0) return [];

  // 每則訊息一個子目錄，避免檔名衝突
  const dir = join(UPLOAD_DIR, message.id);
  await mkdir(dir, { recursive: true });

  const paths: string[] = [];
  for (const [, att] of message.attachments) {
    try {
      const res = await fetch(att.url);
      const buffer = Buffer.from(await res.arrayBuffer());
      const fileName = att.name ?? "file";
      const filePath = join(dir, fileName);
      await writeFile(filePath, buffer);
      paths.push(filePath);
      log.debug(`[discord] 附件下載：${fileName} (${buffer.length} bytes) → ${filePath}`);
    } catch (err) {
      log.warn(`[discord] 附件下載失敗：${att.name ?? att.url} — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return paths;
}

// ── Discord Client 建立 ──────────────────────────────────────────────────────

/**
 * 建立並設定 Discord Client，綁定 messageCreate 事件
 * @param config 全域設定
 * @returns 已設定好的 Discord Client（尚未 login）
 */
export function createDiscordClient(config: BridgeConfig): Client {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    // NOTE: DM 必須加 Partials.Channel，否則 discord.js 不會觸發 DM 的 messageCreate 事件
    partials: [Partials.Channel],
  });

  client.on("messageCreate", (message: Message) => {
    void handleMessage(message, config);
  });

  return client;
}

// ── 訊息處理 ────────────────────────────────────────────────────────────────

/**
 * 處理收到的 Discord 訊息
 * @param message Discord 訊息物件
 * @param config 全域設定
 */
async function handleMessage(
  message: Message,
  config: BridgeConfig
): Promise<void> {
  log.debug(`[discord] 收到訊息 from=${message.author.tag} channel=${message.channelId} guild=${message.guild?.id ?? "DM"} content="${message.content.slice(0, 50)}"`);

  // NOTE: bot 自身訊息必須在 debounce 前過濾，避免 bot 回覆佔用 debounce 容量
  if (message.author.bot) {
    log.debug("[discord] 忽略：bot 訊息");
    return;
  }

  // 去重：防止同一訊息被處理兩次（DM partial channel 已知問題）
  if (processedMessages.has(message.id)) {
    log.debug(`[discord] 忽略：重複訊息 ${message.id}`);
    return;
  }
  processedMessages.add(message.id);
  if (processedMessages.size > 1000) processedMessages.clear();

  // 查詢 per-channel 存取設定
  const guildId = message.guild?.id ?? null;
  const access = getChannelAccess(guildId, message.channelId);

  if (!access.allowed) {
    log.debug(`[discord] 忽略：頻道 ${message.channelId} 不允許`);
    return;
  }

  // 觸發模式判斷
  let text: string;

  if (access.requireMention) {
    // 需要 @mention bot
    const botUser = message.client.user;
    if (!botUser) {
      log.debug("[discord] 忽略：botUser 為 null");
      return;
    }
    if (!message.mentions.has(botUser)) {
      log.debug("[discord] 忽略：未 mention bot");
      return;
    }

    // 移除 mention prefix（<@botId> 或 <@!botId>），保留後續文字
    text = message.content
      .replace(/<@!?\d+>/g, "")
      .trim();
  } else {
    // 不需 mention：直接使用完整訊息
    text = message.content.trim();
  }

  // 下載附件（圖片、檔案等），路徑嵌入 prompt 讓 Claude 可存取
  const attachmentPaths = await downloadAttachments(message);
  if (attachmentPaths.length > 0) {
    const fileList = attachmentPaths.map((p) => `- ${p}`).join("\n");
    text += `\n\n[使用者附件，請用 Read 工具讀取]\n${fileList}`;
  }

  // 訊息為空（只有 mention 沒有文字，且無附件）→ 忽略
  if (!text) {
    log.debug("[discord] 忽略：文字為空");
    return;
  }

  log.debug(`[discord] 通過過濾，text="${text.slice(0, 80)}" → 進入 debounce`);

  // Debounce：合併短時間內同一人的多則訊息
  debounce(message, text, config, (combinedText, firstMessage) => {
    const onEvent = createReplyHandler(firstMessage, config);

    // 多人頻道中讓 Claude 知道發言者身份
    const prompt = `${firstMessage.author.displayName}: ${combinedText}`;

    enqueue(firstMessage.channelId, prompt, onEvent, {
      cwd: config.claudeCwd,
      claudeCmd: config.claudeCommand,
      turnTimeoutMs: config.turnTimeoutMs,
      sessionTtlMs: config.sessionTtlHours * 3600_000,
    });
  });
}
