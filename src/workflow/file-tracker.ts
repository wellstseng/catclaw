/**
 * @file workflow/file-tracker.ts
 * @description 檔案修改追蹤器 — 訂閱 file:modified，per-session 記錄修改過的檔案
 *
 * 觸發：tool:after（write/edit 工具 → agent-loop emit file:modified）
 */

import { log } from "../logger.js";
import type { CatClawEvents } from "../core/event-bus.js";

type EventBus = {
  on<K extends keyof CatClawEvents>(event: K, listener: (...args: CatClawEvents[K]) => void): unknown;
};

// ── 狀態 ──────────────────────────────────────────────────────────────────────

/** sessionKey → Set<filePath> */
const _sessionFiles = new Map<string, Set<string>>();

/** sessionKey → Map<filePath, editCount>（用於 oscillation 偵測） */
const _editCounts = new Map<string, Map<string, number>>();

// ── 公開 API ──────────────────────────────────────────────────────────────────

/** 取得 session 修改過的所有檔案路徑 */
export function getModifiedFiles(sessionKey: string): string[] {
  return [...(_sessionFiles.get(sessionKey) ?? [])];
}

/** 取得 session 內某檔案的編輯次數 */
export function getEditCount(sessionKey: string, filePath: string): number {
  return _editCounts.get(sessionKey)?.get(filePath) ?? 0;
}

/** 取得 session 內 editCount ≥ n 的檔案 */
export function getFrequentEdits(sessionKey: string, minCount = 2): Array<{ path: string; count: number }> {
  const counts = _editCounts.get(sessionKey);
  if (!counts) return [];
  return [...counts.entries()]
    .filter(([, c]) => c >= minCount)
    .map(([path, count]) => ({ path, count }));
}

/** 清除 session 紀錄（session:end 後） */
export function clearSession(sessionKey: string): void {
  _sessionFiles.delete(sessionKey);
  _editCounts.delete(sessionKey);
}

/** 取得當前所有 session 的修改統計（用於 rut detection） */
export function getAllSessionStats(): Map<string, Set<string>> {
  return _sessionFiles;
}

// ── EventBus 訂閱 ─────────────────────────────────────────────────────────────

export function initFileTracker(eventBus: EventBus): void {
  let _currentSessionKey = "_global";

  eventBus.on("turn:before", (ctx) => {
    _currentSessionKey = ctx.sessionKey;
    if (!_sessionFiles.has(ctx.sessionKey)) _sessionFiles.set(ctx.sessionKey, new Set());
    if (!_editCounts.has(ctx.sessionKey)) _editCounts.set(ctx.sessionKey, new Map());
  });

  eventBus.on("file:modified", (path, _tool, _accountId) => {
    // 記錄到 _global + 當前 sessionKey（讓 sync-reminder 可用 sessionKey 查詢）
    for (const key of ["_global", _currentSessionKey]) {
      if (!_sessionFiles.has(key)) _sessionFiles.set(key, new Set());
      _sessionFiles.get(key)!.add(path);

      if (!_editCounts.has(key)) _editCounts.set(key, new Map());
      const counts = _editCounts.get(key)!;
      counts.set(path, (counts.get(path) ?? 0) + 1);
    }
    const globalCounts = _editCounts.get("_global")!;
    log.debug(`[file-tracker] 記錄修改：${path}（總次數：${globalCounts.get(path)}，session=${_currentSessionKey.slice(-16)}）`);
  });

  eventBus.on("session:end", (sessionId) => {
    clearSession(sessionId);
    log.debug(`[file-tracker] session:end 清除 ${sessionId}`);
  });

  log.info("[file-tracker] 初始化完成");
}

/**
 * 直接記錄（供 agent-loop 在有 sessionKey 時呼叫）
 */
export function trackFileEdit(sessionKey: string, filePath: string): void {
  if (!_sessionFiles.has(sessionKey)) _sessionFiles.set(sessionKey, new Set());
  _sessionFiles.get(sessionKey)!.add(filePath);

  if (!_editCounts.has(sessionKey)) _editCounts.set(sessionKey, new Map());
  const counts = _editCounts.get(sessionKey)!;
  counts.set(filePath, (counts.get(filePath) ?? 0) + 1);
}
