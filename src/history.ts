/**
 * @file history.ts
 * @description 訊息歷史記錄 — NDJSON 存儲（append-only）
 *
 * 原 SQLite（better-sqlite3）實作已替換為純 Node.js NDJSON 檔案，
 * 不依賴 native build，全平台通用（Windows / macOS / Linux）。
 *
 * 格式：data/history.ndjson（每行一個 JSON 物件）
 * 自動輪換：超過 MAX_LINES 行時保留最後 KEEP_LINES 行
 *
 * 對外 API：initHistory() / recordUserMessage() / recordAssistantTurn() / query functions
 */

import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { resolveWorkspaceDir, config } from "./config.js";
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

// ── 常數 ────────────────────────────────────────────────────────────────────

const MAX_LINES = 50_000;  // 超過此行數觸發輪換
const KEEP_LINES = 30_000; // 輪換後保留最新的行數

// ── 內部狀態 ────────────────────────────────────────────────────────────────

let historyPath = "";
let lineCount = 0;
let nextId = 1;

// ── 輪換 ─────────────────────────────────────────────────────────────────────

function rotate(): void {
  try {
    const raw = readFileSync(historyPath, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim());
    const kept = lines.slice(-KEEP_LINES);
    writeFileSync(historyPath, kept.join("\n") + "\n", "utf-8");
    lineCount = kept.length;
    log.info(`[history] 輪換完成，保留 ${lineCount} 筆`);
  } catch (err) {
    log.warn(`[history] 輪換失敗：${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── 寫入 ─────────────────────────────────────────────────────────────────────

function append(row: Omit<HistoryRow, "id">): void {
  if (!historyPath || !config.history.enabled) return;
  try {
    const record: HistoryRow = { id: nextId++, ...row };
    appendFileSync(historyPath, JSON.stringify(record) + "\n", "utf-8");
    lineCount++;
    if (lineCount >= MAX_LINES) rotate();
  } catch (err) {
    log.warn(`[history] 寫入失敗：${err instanceof Error ? err.message : String(err)}`);
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

// ── 公開 API ─────────────────────────────────────────────────────────────────

/**
 * 初始化歷史記錄（data/history.ndjson）
 */
export function initHistory(): void {
  try {
    const dir = join(resolveWorkspaceDir(), "data");
    mkdirSync(dir, { recursive: true });
    historyPath = join(dir, "history.ndjson");

    // 計算現有行數
    if (existsSync(historyPath)) {
      const raw = readFileSync(historyPath, "utf-8");
      const lines = raw.split("\n").filter((l) => l.trim());
      lineCount = lines.length;
      // 推算 nextId
      if (lines.length > 0) {
        try {
          const last = JSON.parse(lines[lines.length - 1]) as { id?: number };
          if (typeof last.id === "number") nextId = last.id + 1;
        } catch { /* 忽略 */ }
      }
    }

    log.info(`[history] NDJSON 初始化完成：${historyPath}（${lineCount} 筆）`);
  } catch (err) {
    log.warn(`[history] 初始化失敗：${err instanceof Error ? err.message : String(err)}`);
    historyPath = "";
  }
}

/** 記錄 user 訊息 */
export function recordUserMessage(params: UserMessageParams): void {
  append({
    turn_id: params.turnId,
    message_id: params.messageId,
    role: "user",
    author_id: params.authorId,
    author_name: params.authorName,
    is_bot: params.isBot ? 1 : 0,
    channel_id: params.channelId,
    guild_id: params.guildId,
    content: params.content,
    tool_name: null,
    attachments: params.attachments?.length ? JSON.stringify(params.attachments) : null,
    created_at: nowIso(),
    session_id: null,
  });
}

/** 記錄 assistant 回覆（thinking + tool_calls + text） */
export function recordAssistantTurn(params: AssistantTurnParams): void {
  const base = {
    message_id: null,
    author_id: params.botId,
    author_name: params.botName,
    is_bot: 1 as const,
    channel_id: params.channelId,
    guild_id: params.guildId,
    attachments: null,
    session_id: params.sessionId,
  };

  if (params.thinking.trim()) {
    append({ turn_id: params.turnId, role: "thinking", content: params.thinking, tool_name: null, created_at: nowIso(), ...base });
  }
  for (const toolName of params.toolCalls) {
    append({ turn_id: params.turnId, role: "tool", content: null, tool_name: toolName, created_at: nowIso(), ...base });
  }
  if (params.text.trim()) {
    append({ turn_id: params.turnId, role: "assistant", content: params.text, tool_name: null, created_at: nowIso(), ...base });
  }
}

// ── 查詢（全掃描，適合低頻查詢）────────────────────────────────────────────

function readAll(): HistoryRow[] {
  if (!historyPath || !existsSync(historyPath)) return [];
  try {
    return readFileSync(historyPath, "utf-8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as HistoryRow);
  } catch {
    return [];
  }
}

export function getChannelHistory(channelId: string, limit = 50, before?: string): HistoryRow[] {
  let rows = readAll().filter((r) => r.channel_id === channelId);
  if (before) rows = rows.filter((r) => r.created_at < before);
  return rows.sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit);
}

export function getTurnDetail(turnId: string): HistoryRow[] {
  return readAll().filter((r) => r.turn_id === turnId).sort((a, b) => a.id - b.id);
}

export function getUserHistory(authorId: string, limit = 50): HistoryRow[] {
  return readAll()
    .filter((r) => r.author_id === authorId)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, limit);
}

export function getHistoryStats(): Record<string, number> {
  const rows = readAll();
  const stats: Record<string, number> = { total: rows.length };
  for (const r of rows) stats[r.role] = (stats[r.role] ?? 0) + 1;
  return stats;
}
