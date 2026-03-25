/**
 * @file history.ts
 * @description 訊息歷史記錄 — SQLite 存儲所有 user/assistant/thinking/tool 訊息
 *
 * Schema：單表 messages，用 turn_id (UUID) 串聯同一輪的 user input + AI response
 * DB 寫入失敗不影響 bot 正常運作（try-catch + log.warn）
 *
 * 對外 API：initHistory() / recordUserMessage() / recordAssistantTurn() / query functions
 */

import Database from "better-sqlite3";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { resolveWorkspaceDir } from "./config.js";
import { log } from "./logger.js";

// ── 型別定義 ────────────────────────────────────────────────────────────────

export interface UserMessageParams {
  turnId: string;
  messageId: string;
  authorId: string;
  authorName: string;
  isBot: boolean;
  channelId: string;
  guildId: string | null;
  content: string;
  attachments?: string[];
}

export interface AssistantTurnParams {
  turnId: string;
  channelId: string;
  guildId: string | null;
  botId: string;
  botName: string;
  sessionId: string | null;
  text: string;
  thinking: string;
  toolCalls: string[];
}

export interface HistoryQueryOptions {
  channelId?: string;
  authorId?: string;
  role?: string;
  limit?: number;
  before?: string; // ISO 8601
}

export interface HistoryRow {
  id: number;
  turn_id: string;
  message_id: string | null;
  role: string;
  author_id: string | null;
  author_name: string | null;
  is_bot: number;
  channel_id: string;
  guild_id: string | null;
  content: string | null;
  tool_name: string | null;
  attachments: string | null;
  created_at: string;
  session_id: string | null;
}

// ── 內部狀態 ────────────────────────────────────────────────────────────────

let db: Database.Database | null = null;

// Prepared statements cache
let stmtInsert: Database.Statement | null = null;

// ── 初始化 ────────────────────────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  turn_id       TEXT NOT NULL,
  message_id    TEXT,
  role          TEXT NOT NULL,
  author_id     TEXT,
  author_name   TEXT,
  is_bot        INTEGER NOT NULL DEFAULT 0,
  channel_id    TEXT NOT NULL,
  guild_id      TEXT,
  content       TEXT,
  tool_name     TEXT,
  attachments   TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', 'localtime')),
  session_id    TEXT
);

CREATE INDEX IF NOT EXISTS idx_messages_channel_time ON messages (channel_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_turn_id ON messages (turn_id);
CREATE INDEX IF NOT EXISTS idx_messages_author ON messages (author_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_role ON messages (role);
`;

/**
 * 初始化 SQLite DB（data/history.db）
 * 設定 WAL mode + NORMAL sync，建立 schema
 */
export function initHistory(): void {
  try {
    const dir = join(resolveWorkspaceDir(), "data");
    mkdirSync(dir, { recursive: true });
    const dbPath = join(dir, "history.db");

    db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.exec(SCHEMA);

    stmtInsert = db.prepare(`
      INSERT INTO messages (turn_id, message_id, role, author_id, author_name, is_bot, channel_id, guild_id, content, tool_name, attachments, session_id)
      VALUES (@turnId, @messageId, @role, @authorId, @authorName, @isBot, @channelId, @guildId, @content, @toolName, @attachments, @sessionId)
    `);

    log.info(`[history] SQLite 初始化完成：${dbPath}`);
  } catch (err) {
    log.warn(`[history] 初始化失敗：${err instanceof Error ? err.message : String(err)}`);
    db = null;
  }
}

// ── 寫入 ────────────────────────────────────────────────────────────────

/**
 * 記錄 user 訊息（debounce 合併後的最終文字）
 */
export function recordUserMessage(params: UserMessageParams): void {
  if (!db || !stmtInsert) return;
  try {
    stmtInsert.run({
      turnId: params.turnId,
      messageId: params.messageId,
      role: "user",
      authorId: params.authorId,
      authorName: params.authorName,
      isBot: params.isBot ? 1 : 0,
      channelId: params.channelId,
      guildId: params.guildId,
      content: params.content,
      toolName: null,
      attachments: params.attachments?.length ? JSON.stringify(params.attachments) : null,
      sessionId: null,
    });
  } catch (err) {
    log.warn(`[history] user message 寫入失敗：${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * 記錄 assistant 回覆（一次寫入 text + thinking + tool_calls，用 transaction）
 */
export function recordAssistantTurn(params: AssistantTurnParams): void {
  if (!db || !stmtInsert) return;
  try {
    const insertMany = db.transaction(() => {
      // thinking（如果有的話）
      if (params.thinking.trim()) {
        stmtInsert!.run({
          turnId: params.turnId,
          messageId: null,
          role: "thinking",
          authorId: params.botId,
          authorName: params.botName,
          isBot: 1,
          channelId: params.channelId,
          guildId: params.guildId,
          content: params.thinking,
          toolName: null,
          attachments: null,
          sessionId: params.sessionId,
        });
      }

      // tool calls
      for (const toolName of params.toolCalls) {
        stmtInsert!.run({
          turnId: params.turnId,
          messageId: null,
          role: "tool",
          authorId: params.botId,
          authorName: params.botName,
          isBot: 1,
          channelId: params.channelId,
          guildId: params.guildId,
          content: null,
          toolName,
          attachments: null,
          sessionId: params.sessionId,
        });
      }

      // assistant text（最終回覆）
      if (params.text.trim()) {
        stmtInsert!.run({
          turnId: params.turnId,
          messageId: null,
          role: "assistant",
          authorId: params.botId,
          authorName: params.botName,
          isBot: 1,
          channelId: params.channelId,
          guildId: params.guildId,
          content: params.text,
          toolName: null,
          attachments: null,
          sessionId: params.sessionId,
        });
      }
    });

    insertMany();
  } catch (err) {
    log.warn(`[history] assistant turn 寫入失敗：${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── 查詢 ────────────────────────────────────────────────────────────────

/**
 * 查詢頻道歷史訊息
 */
export function getChannelHistory(channelId: string, limit = 50, before?: string): HistoryRow[] {
  if (!db) return [];
  try {
    if (before) {
      return db.prepare(
        `SELECT * FROM messages WHERE channel_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?`
      ).all(channelId, before, limit) as HistoryRow[];
    }
    return db.prepare(
      `SELECT * FROM messages WHERE channel_id = ? ORDER BY created_at DESC LIMIT ?`
    ).all(channelId, limit) as HistoryRow[];
  } catch (err) {
    log.warn(`[history] 查詢失敗：${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * 查詢完整 turn（user + thinking + tool + assistant）
 */
export function getTurnDetail(turnId: string): HistoryRow[] {
  if (!db) return [];
  try {
    return db.prepare(
      `SELECT * FROM messages WHERE turn_id = ? ORDER BY id ASC`
    ).all(turnId) as HistoryRow[];
  } catch (err) {
    log.warn(`[history] turn 查詢失敗：${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * 查詢特定使用者的歷史
 */
export function getUserHistory(authorId: string, limit = 50): HistoryRow[] {
  if (!db) return [];
  try {
    return db.prepare(
      `SELECT * FROM messages WHERE author_id = ? ORDER BY created_at DESC LIMIT ?`
    ).all(authorId, limit) as HistoryRow[];
  } catch (err) {
    log.warn(`[history] user 查詢失敗：${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * 取得 DB 統計（總筆數 + 各 role 計數）
 */
export function getHistoryStats(): Record<string, number> {
  if (!db) return {};
  try {
    const rows = db.prepare(
      `SELECT role, COUNT(*) as count FROM messages GROUP BY role`
    ).all() as { role: string; count: number }[];
    const stats: Record<string, number> = {};
    let total = 0;
    for (const row of rows) {
      stats[row.role] = row.count;
      total += row.count;
    }
    stats.total = total;
    return stats;
  } catch (err) {
    log.warn(`[history] stats 查詢失敗：${err instanceof Error ? err.message : String(err)}`);
    return {};
  }
}
