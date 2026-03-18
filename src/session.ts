/**
 * @file session.ts
 * @description ACP session 管理 + per-channel 串行佇列
 *
 * 職責：
 * 1. 維護 channelId → sessionName 的快取（避免重複建立 session）
 * 2. 以 Promise chain 實作 per-channel 串行佇列
 *    （同一 channel 的 turn 必須串行，不同 channel 完全並行）
 * 3. 對外只暴露 enqueue()，呼叫方不需要關心 session 細節
 */

import { ensureAcpSession, runAcpTurn, type AcpEvent } from "./acp.js";

// ── 型別定義 ────────────────────────────────────────────────────────────────

/** enqueue 收到的 event 回呼，與 acp.ts 的 AcpEvent 相同 */
export type OnEvent = (event: AcpEvent) => void | Promise<void>;

// ── 內部狀態 ────────────────────────────────────────────────────────────────

/** channelId → sessionName 快取（已確認存在的 session） */
const sessionCache = new Map<string, string>();

/**
 * channelId → Promise chain 尾端
 * per-channel 串行佇列核心：每個新 turn 接在上一個 Promise 後面
 */
const queues = new Map<string, Promise<void>>();

// ── 內部函式 ────────────────────────────────────────────────────────────────

/**
 * 確保指定 channel 的 ACP session 存在，回傳 sessionName
 * 有快取直接用，沒有則呼叫 acpx sessions ensure
 * @param channelId Discord channel ID
 * @param cwd Claude session 工作目錄
 * @param acpxCmd acpx binary 路徑
 */
async function ensureSession(
  channelId: string,
  cwd: string,
  acpxCmd: string
): Promise<string> {
  const cached = sessionCache.get(channelId);
  if (cached) return cached;

  // session 名稱直接用 channelId，確保唯一且可追蹤
  const sessionName = channelId;
  await ensureAcpSession(sessionName, cwd, acpxCmd);
  sessionCache.set(channelId, sessionName);
  return sessionName;
}

/**
 * 執行單一 turn 的完整流程：確保 session → 串流 event → 逐一回呼
 * @param channelId Discord channel ID
 * @param text 使用者訊息文字
 * @param onEvent event 回呼，由 discord.ts 傳入（用於更新 Discord 回覆）
 * @param cwd Claude session 工作目錄
 * @param acpxCmd acpx binary 路徑
 * @param signal AbortSignal（可選）
 */
async function runTurn(
  channelId: string,
  text: string,
  onEvent: OnEvent,
  cwd: string,
  acpxCmd: string,
  signal?: AbortSignal
): Promise<void> {
  const sessionName = await ensureSession(channelId, cwd, acpxCmd);

  for await (const event of runAcpTurn(sessionName, text, cwd, acpxCmd, signal)) {
    await onEvent(event);
  }
}

// ── 對外 API ────────────────────────────────────────────────────────────────

/** enqueue 的選項 */
export interface EnqueueOptions {
  /** Claude session 工作目錄 */
  cwd: string;
  /** acpx binary 路徑 */
  acpxCmd: string;
  /** AbortSignal（可選，用於取消） */
  signal?: AbortSignal;
}

/**
 * 將一個 turn 加入指定 channel 的串行佇列
 *
 * 同一 channelId 的呼叫會依序執行，不同 channelId 完全並行。
 * 呼叫方不需要 await，除非需要等待完成。
 *
 * @param channelId Discord channel ID（佇列 key）
 * @param text 使用者訊息文字
 * @param onEvent ACP event 回呼
 * @param opts 設定選項
 */
export function enqueue(
  channelId: string,
  text: string,
  onEvent: OnEvent,
  opts: EnqueueOptions
): void {
  // 取得目前佇列尾端（若無則 Promise.resolve()）
  const tail = queues.get(channelId) ?? Promise.resolve();

  // 將新 turn 接在尾端，錯誤不向上傳播（避免 Promise chain 中斷）
  const next = tail.then(() =>
    runTurn(channelId, text, onEvent, opts.cwd, opts.acpxCmd, opts.signal).catch(
      (err: unknown) => {
        // turn 執行失敗：通知 onEvent，讓 reply.ts 顯示錯誤給使用者
        const message =
          err instanceof Error ? err.message : String(err);
        void onEvent({ type: "error", message });
      }
    )
  );

  queues.set(channelId, next);

  // 佇列完成後清理 Map，避免記憶體洩漏
  // NOTE: 若 channel 長期不活躍，Map 中殘留的已完成 Promise 不佔太多記憶體，
  //       但仍定期清理以保持乾淨
  next.finally(() => {
    // 只有當 Map 中的值仍是這個 Promise 時才刪除（避免刪到後來的 turn）
    if (queues.get(channelId) === next) {
      queues.delete(channelId);
    }
  });
}
