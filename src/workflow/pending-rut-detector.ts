/**
 * @file workflow/pending-rut-detector.ts
 * @description Pending Questions 拖延型 rut 偵測（項目 7 plan §範圍擴充補洞）
 *
 * 偵測邏輯：
 *   - 每次 CompactionStrategy 完成後，呼叫 recordPendingQuestions(sessionKey, pending[])
 *   - 比對歷史：同一 hash 連續 ≥ N 次 compaction 仍出現 → 拖延型 rut
 *   - emit workflow:rut event（沿用既有 channel，agent-loop 會自動寫 trace +
 *     recordGuardianHit(rule="rut")）
 *
 * 設計選擇：
 *   - 用 hash 比對（normalize：lowercase + 去標點 + 前 100 字）— 避免相似但非同字串重複
 *   - in-memory state，process restart 重新計算（session 通常時間長度遠超 process lifetime
 *     不算嚴重損失）
 *   - 預設 N=3（即 3 次 compaction 仍未答）
 */

import { log } from "../logger.js";
import { eventBus } from "../core/event-bus.js";

const PENDING_RUT_THRESHOLD = (() => {
  const n = parseInt(process.env["CATCLAW_PENDING_RUT_THRESHOLD"] ?? "3", 10);
  return Number.isFinite(n) && n >= 2 ? n : 3;
})();

interface PendingState {
  count: number;
  lastSeenAt: number;
  text: string;
}

/** sessionKey → pendingHash → state */
const _state = new Map<string, Map<string, PendingState>>();
/** 已 emit 過 rut 的 hash（避免每次 compaction 重複 emit 同一條） */
const _alreadyEmitted = new Map<string, Set<string>>();

function hashPending(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w一-鿿]/g, "")
    .slice(0, 100);
}

/**
 * 記錄一次 compaction 的 pending list，比對歷史並偵測拖延 rut。
 * pending 為空陣列表示這次沒 pending（清除 session 的歷史記錄）。
 */
export function recordPendingQuestions(sessionKey: string, pending: string[]): void {
  if (!sessionKey) return;
  let sessionMap = _state.get(sessionKey);
  if (!sessionMap) {
    sessionMap = new Map();
    _state.set(sessionKey, sessionMap);
  }
  let emittedSet = _alreadyEmitted.get(sessionKey);
  if (!emittedSet) {
    emittedSet = new Set();
    _alreadyEmitted.set(sessionKey, emittedSet);
  }

  const seen = new Set<string>();
  for (const p of pending) {
    const hash = hashPending(p);
    if (!hash) continue;
    seen.add(hash);
    const existing = sessionMap.get(hash);
    if (existing) {
      existing.count++;
      existing.lastSeenAt = Date.now();
    } else {
      sessionMap.set(hash, { count: 1, lastSeenAt: Date.now(), text: p });
    }
  }

  // 移除這次沒出現的（已答 / 已忘）
  for (const hash of [...sessionMap.keys()]) {
    if (!seen.has(hash)) {
      sessionMap.delete(hash);
      emittedSet.delete(hash);
    }
  }

  // 偵測拖延：連續 ≥ THRESHOLD 次 compaction 仍未答 → emit
  const stalled = [...sessionMap.entries()].filter(
    ([hash, s]) => s.count >= PENDING_RUT_THRESHOLD && !emittedSet!.has(hash),
  );
  if (stalled.length > 0) {
    const warnings = stalled.map(([_h, s]) => ({
      pattern: `pending_unresolved:${s.text.slice(0, 40)}`,
      count: s.count,
      sessions: [sessionKey],
    }));
    eventBus.emit("workflow:rut", warnings, sessionKey);
    for (const [hash] of stalled) emittedSet!.add(hash);
    log.warn(
      `[pending-rut-detector] ${sessionKey} 偵測到 ${stalled.length} 個拖延 pending（≥ ${PENDING_RUT_THRESHOLD} 次 compaction 仍未解）`,
    );
  }
}

/** session.delete 時清 state（避免 in-memory leak） */
export function clearPendingState(sessionKey: string): void {
  _state.delete(sessionKey);
  _alreadyEmitted.delete(sessionKey);
}
