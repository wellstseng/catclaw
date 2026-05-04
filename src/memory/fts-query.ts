/**
 * @file memory/fts-query.ts
 * @description NDJSON 訊息查詢介面（項目 9 Phase 2/3）
 *
 * Phase 1（已落地，commit 0f98164）：append-only NDJSON 寫入。
 * Phase 2（本檔）：keyword 線性掃描 + filter（sessionKey / channelId / role / days）。
 * Phase 3（本檔 aggregate）：/insights 統計（token 消耗 / 活躍度 / tool top / 熱門話題）。
 *
 * 未來升級 SQLite FTS5：searchMessages / aggregateMessages 簽名 stable，內部換 SQLite query。
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, basename, join } from "node:path";
import { getMessageIndexPath, type IndexedMessage } from "./message-index-store.js";

export interface FtsQueryOpts {
  /** keyword (lowercase compare) */
  query: string;
  /** 最近 N 天 */
  days?: number;
  /** unix ms 起始時間（與 days 二擇一） */
  since?: number;
  sessionKey?: string;
  channelId?: string;
  accountId?: string;
  agentId?: string;
  role?: "user" | "assistant" | "tool_result";
  /** 預設 50 */
  limit?: number;
}

export interface FtsHit {
  message: IndexedMessage;
  /** content 內第一次命中位置 */
  matchOffset: number;
  /** 命中前後各 60 字的預覽 */
  preview: string;
}

function listIndexFiles(): string[] {
  const path = getMessageIndexPath();
  const dir = dirname(path);
  if (!existsSync(dir)) return [];
  const baseStem = basename(path).replace(/\.ndjson$/, "");
  try {
    return readdirSync(dir)
      .filter(f => f.startsWith(baseStem) && f.endsWith(".ndjson"))
      .map(f => join(dir, f))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/**
 * 簡單 keyword search（lowercase substring 比對 + filter）。
 * 跨主檔 + rotation 歷史檔。新檔優先掃描，達 limit 即返回。
 */
export function searchMessages(opts: FtsQueryOpts): FtsHit[] {
  const queryLower = opts.query.toLowerCase();
  if (!queryLower) return [];
  const limit = opts.limit ?? 50;
  const cutoffTs = opts.since ?? (opts.days != null ? Date.now() - opts.days * 86_400_000 : 0);
  const hits: FtsHit[] = [];

  for (const file of listIndexFiles()) {
    if (hits.length >= limit) break;
    let content: string;
    try {
      content = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    const lines = content.split("\n").filter(Boolean);
    // 從新到舊掃
    for (let i = lines.length - 1; i >= 0 && hits.length < limit; i--) {
      let m: IndexedMessage;
      try {
        m = JSON.parse(lines[i]!) as IndexedMessage;
      } catch {
        continue;
      }
      if (m.ts < cutoffTs) continue;
      if (opts.sessionKey && m.sessionKey !== opts.sessionKey) continue;
      if (opts.channelId && m.channelId !== opts.channelId) continue;
      if (opts.accountId && m.accountId !== opts.accountId) continue;
      if (opts.agentId && m.agentId !== opts.agentId) continue;
      if (opts.role && m.role !== opts.role) continue;

      const matchOffset = m.content.toLowerCase().indexOf(queryLower);
      if (matchOffset < 0) continue;

      const start = Math.max(0, matchOffset - 60);
      const end = Math.min(m.content.length, matchOffset + queryLower.length + 60);
      const preview =
        (start > 0 ? "…" : "") +
        m.content.slice(start, end) +
        (end < m.content.length ? "…" : "");
      hits.push({ message: m, matchOffset, preview });
    }
  }
  return hits.sort((a, b) => b.message.ts - a.message.ts);
}

export interface MessageAggregate {
  total: number;
  byRole: Record<string, number>;
  bySession: Record<string, number>;
  topChannels: Array<{ channelId: string; count: number }>;
  topTools: Array<{ name: string; count: number }>;
  hourHistogram: number[];
  earliestTs?: number;
  latestTs?: number;
}

/** 跨檔統計（/insights 用） */
export function aggregateMessages(opts: { days?: number } = {}): MessageAggregate {
  const cutoffTs = opts.days != null ? Date.now() - opts.days * 86_400_000 : 0;
  const byRole: Record<string, number> = {};
  const bySession: Record<string, number> = {};
  const byChannel: Record<string, number> = {};
  const byTool: Record<string, number> = {};
  const hourHistogram = new Array<number>(24).fill(0);
  let total = 0;
  let earliestTs: number | undefined;
  let latestTs: number | undefined;

  for (const file of listIndexFiles()) {
    let content: string;
    try {
      content = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    for (const line of content.split("\n").filter(Boolean)) {
      let m: IndexedMessage;
      try {
        m = JSON.parse(line) as IndexedMessage;
      } catch {
        continue;
      }
      if (m.ts < cutoffTs) continue;
      total++;
      byRole[m.role] = (byRole[m.role] ?? 0) + 1;
      bySession[m.sessionKey] = (bySession[m.sessionKey] ?? 0) + 1;
      if (m.channelId) byChannel[m.channelId] = (byChannel[m.channelId] ?? 0) + 1;
      if (m.toolName) byTool[m.toolName] = (byTool[m.toolName] ?? 0) + 1;
      const hour = new Date(m.ts).getHours();
      hourHistogram[hour]++;
      if (earliestTs == null || m.ts < earliestTs) earliestTs = m.ts;
      if (latestTs == null || m.ts > latestTs) latestTs = m.ts;
    }
  }

  const topChannels = Object.entries(byChannel)
    .map(([channelId, count]) => ({ channelId, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
  const topTools = Object.entries(byTool)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  return { total, byRole, bySession, topChannels, topTools, hourHistogram, earliestTs, latestTs };
}
