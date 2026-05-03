/**
 * @file memory/message-index-store.ts
 * @description Message Index Store — 跨 session 訊息全文索引（項目 9 Phase 1）
 *
 * Phase 1：NDJSON append-only 寫入到 ~/.catclaw/workspace/data/messages.ndjson
 *   - 每個訊息一行 JSON
 *   - 為跨 session recall (`/recall`) 與 trajectory fingerprint 訓練資料源預埋資料
 *   - fire-and-forget 寫入，失敗只 warn，不阻塞主 pipeline
 *   - 不阻擋 history.ts NDJSON（後者是 Discord-only message log，schema 不同）
 *
 * 不做（Phase 2-3）：
 *   - 查詢介面：`memory_search_fulltext` LLM tool / `/recall` skill
 *   - `/insights` 統計報告
 *   - Dashboard 搜尋面板
 *   - 歷史資料 backfill
 *
 * 未來升級路徑：
 *   - 若效能不足，可升級為 SQLite FTS5（需引入 better-sqlite3，但 catclaw 設計
 *     避開 native build；或考慮 Node 22+ 的 node:sqlite 內建模組）
 *   - 升級時 schema 已對齊（fields 對應 messages_meta + messages_fts）
 */

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { log } from "../logger.js";

export interface IndexedMessage {
  /** 寫入時間（unix ms） */
  ts: number;
  /** 訊息 ID（自動生成或來自上層） */
  messageId?: string;
  /** Session key（platform:ch:channelId 或自定） */
  sessionKey: string;
  /** 平台頻道 ID（Discord channel / API channel） */
  channelId?: string;
  /** 帳號 ID */
  accountId?: string;
  /** Agent ID（boot agent / subagent） */
  agentId?: string;
  /** 訊息角色 */
  role: "user" | "assistant" | "tool_result";
  /** 該 session 的 turn 索引（assistant 訊息有；user 訊息可選） */
  turnIndex?: number;
  /** 訊息文字內容（已 sanitized） */
  content: string;
  /** Tool 名稱（role=tool_result 時用） */
  toolName?: string;
}

let _initialized = false;
let _storePath: string | null = null;

function getStorePath(): string {
  if (_storePath) return _storePath;
  _storePath = join(
    process.env["CATCLAW_HOME"] ?? join(homedir(), ".catclaw"),
    "workspace",
    "data",
    "messages.ndjson",
  );
  return _storePath;
}

/** 初始化：確保 data 目錄存在。Idempotent。 */
export function initMessageIndex(): void {
  if (_initialized) return;
  try {
    const dir = join(getStorePath(), "..");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    _initialized = true;
    log.info(`[message-index] initialized at ${getStorePath()}`);
  } catch (err) {
    log.warn(`[message-index] init 失敗：${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Fire-and-forget 寫入。失敗只 warn，不阻塞。 */
export function indexMessage(msg: IndexedMessage): void {
  if (!_initialized) return;
  try {
    const line = JSON.stringify(msg) + "\n";
    appendFileSync(getStorePath(), line, "utf-8");
  } catch (err) {
    log.warn(
      `[message-index] 寫入失敗 sessionKey=${msg.sessionKey} role=${msg.role}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** 供未來 query interface（Phase 2）使用 */
export function getMessageIndexPath(): string {
  return getStorePath();
}
