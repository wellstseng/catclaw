/**
 * @file memory/atom-access.ts
 * @description V5 P3 — atom 遙測旁路（`<atom>.access.json`）讀寫單一通道
 *
 * 對拍 upstream `~/.claude/lib/atom_access.py`（catclaw 變體）。
 *
 * Schema v2-catclaw（取代 atom .md 內的 Last-used / Confirmations / ReadHits）：
 * ```ts
 * {
 *   schema: "atom-access-v2-catclaw",
 *   read_hits: number,
 *   last_used: "YYYY-MM-DD",
 *   confirmations: number,
 *   last_promoted_at: string | null,
 *   first_seen: "YYYY-MM-DD",
 *   timestamps: number[],          // epoch ms，最多 50 筆
 *   confirmation_events: Array<{ ts: number; source?: string }>
 * }
 * ```
 *
 * 寫入策略：atomic（tmp + rename）。
 * 讀取策略：缺檔 → null；caller（atom.ts:readAtom）負責 fallback。
 */

import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { log } from "../logger.js";

// ── 常數 ─────────────────────────────────────────────────────────────────────

export const ACCESS_SCHEMA = "atom-access-v2-catclaw";
const MAX_TIMESTAMPS = 50;
const MAX_CONFIRMATION_EVENTS = 50;

// ── 型別 ─────────────────────────────────────────────────────────────────────

export interface ConfirmationEvent {
  ts: number;
  source?: string;
}

export interface AtomAccess {
  schema: typeof ACCESS_SCHEMA;
  read_hits: number;
  last_used: string;
  confirmations: number;
  last_promoted_at: string | null;
  first_seen: string;
  timestamps: number[];
  confirmation_events: ConfirmationEvent[];
}

// ── 內部工具 ─────────────────────────────────────────────────────────────────

function accessPathOf(atomPath: string): string {
  return `${atomPath}.access.json`;
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function blankAccess(firstSeen?: string): AtomAccess {
  const day = firstSeen ?? todayISO();
  return {
    schema: ACCESS_SCHEMA,
    read_hits: 0,
    last_used: day,
    confirmations: 0,
    last_promoted_at: null,
    first_seen: day,
    timestamps: [],
    confirmation_events: [],
  };
}

function pushBounded<T>(arr: T[], item: T, cap: number): T[] {
  arr.push(item);
  if (arr.length > cap) arr.splice(0, arr.length - cap);
  return arr;
}

// ── load / save ──────────────────────────────────────────────────────────────

/**
 * 讀取 atom access；缺檔 → null。
 * 偵測舊 schema（confirmations 是陣列）→ 自動轉成 v2 格式 in-memory（不持久化）。
 */
export function readAccess(atomPath: string): AtomAccess | null {
  const p = accessPathOf(atomPath);
  if (!existsSync(p)) return null;
  try {
    const raw = readFileSync(p, "utf-8");
    const data = JSON.parse(raw) as unknown;
    if (!data || typeof data !== "object") return null;
    const o = data as Record<string, unknown>;

    // Legacy: confirmations 是陣列 → 轉成 v2
    const confs = Array.isArray(o.confirmations) ? o.confirmations.length : Number(o.confirmations ?? 0);
    const events: ConfirmationEvent[] = Array.isArray(o.confirmations)
      ? (o.confirmations as unknown[]).map(c => {
          if (typeof c === "object" && c !== null) return c as ConfirmationEvent;
          return { ts: Number(c) || Date.now() };
        })
      : Array.isArray(o.confirmation_events)
        ? (o.confirmation_events as ConfirmationEvent[])
        : [];

    return {
      schema: ACCESS_SCHEMA,
      read_hits: Number(o.read_hits ?? 0),
      last_used: typeof o.last_used === "string" ? o.last_used : todayISO(),
      confirmations: confs,
      last_promoted_at: typeof o.last_promoted_at === "string" ? o.last_promoted_at : null,
      first_seen: typeof o.first_seen === "string" ? o.first_seen : todayISO(),
      timestamps: Array.isArray(o.timestamps) ? (o.timestamps as number[]) : [],
      confirmation_events: events,
    };
  } catch (err) {
    log.warn(`[atom-access] 讀取失敗 ${p}：${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export function writeAccess(atomPath: string, data: AtomAccess): void {
  const p = accessPathOf(atomPath);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  renameSync(tmp, p);
}

/**
 * 移除 access 檔（atom-delete 同步刪用）。回傳 true 表示有移除。
 */
export function deleteAccess(atomPath: string): boolean {
  const p = accessPathOf(atomPath);
  if (!existsSync(p)) return false;
  try {
    unlinkSync(p);
    return true;
  } catch (err) {
    log.warn(`[atom-access] 刪除失敗 ${p}：${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

// ── 操作 API ─────────────────────────────────────────────────────────────────

/**
 * 初始化 access 檔。idempotent：已存在則不覆寫。
 */
export function initAccess(atomPath: string, firstSeen?: string): AtomAccess {
  const existing = readAccess(atomPath);
  if (existing) return existing;
  const data = blankAccess(firstSeen);
  writeAccess(atomPath, data);
  return data;
}

/**
 * 累加 read_hits + 更新 last_used + push timestamp。
 */
export function incrementReadHits(atomPath: string, _source?: string): AtomAccess {
  const data = readAccess(atomPath) ?? blankAccess();
  data.read_hits += 1;
  data.last_used = todayISO();
  pushBounded(data.timestamps, Date.now(), MAX_TIMESTAMPS);
  writeAccess(atomPath, data);
  return data;
}

/**
 * 累加 confirmations + 記 confirmation_event + 更新 last_used。
 */
export function incrementConfirmation(atomPath: string, source?: string): AtomAccess {
  const data = readAccess(atomPath) ?? blankAccess();
  data.confirmations += 1;
  data.last_used = todayISO();
  pushBounded(data.confirmation_events, { ts: Date.now(), source }, MAX_CONFIRMATION_EVENTS);
  writeAccess(atomPath, data);
  return data;
}

/**
 * 記錄晉升動作：寫 last_promoted_at = today。
 */
export function recordPromotion(atomPath: string, _target: string): AtomAccess {
  const data = readAccess(atomPath) ?? blankAccess();
  data.last_promoted_at = todayISO();
  writeAccess(atomPath, data);
  return data;
}

// ── Migration helper ─────────────────────────────────────────────────────────

export interface MdMetadataForMigration {
  lastUsed?: string;
  confirmations?: number;
  createdAt?: number;
}

/**
 * 從 atom .md 抽出的 metadata → 建立 access.json。idempotent。
 */
export function migrateFromMd(atomPath: string, meta: MdMetadataForMigration): AtomAccess {
  const existing = readAccess(atomPath);
  // 若已有 access 檔且 confirmations >= md 值，視為新版較新，跳過覆寫
  if (existing && existing.confirmations >= (meta.confirmations ?? 0)) {
    return existing;
  }
  const firstSeen = meta.createdAt
    ? new Date(meta.createdAt).toISOString().slice(0, 10)
    : todayISO();
  const data: AtomAccess = {
    schema: ACCESS_SCHEMA,
    read_hits: 0,
    last_used: meta.lastUsed ?? todayISO(),
    confirmations: meta.confirmations ?? 0,
    last_promoted_at: null,
    first_seen: firstSeen,
    timestamps: [],
    confirmation_events: [],
  };
  writeAccess(atomPath, data);
  return data;
}
