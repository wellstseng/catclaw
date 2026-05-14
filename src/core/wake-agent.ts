/**
 * @file core/wake-agent.ts
 * @description Agent-spawned 工具完成 → 自動喚醒該 agent 新 turn
 *
 * 背景：
 * agent end_turn 後，agent-loop 的 `_wfListeners` cleanup，event 接不到。
 * 既有 fallback（platform.ts 第 274-303 行）只送 Discord 文字通知，不喚醒 agent。
 * 結果是 wendy spawn manga 翻譯 job 後 end_turn，job 完成後 wendy 沒被叫回來執行
 * skill 的後續步驟（搬 Obsidian / 邀校稿）。
 *
 * 本模組：在 fallback 路徑啟動新 turn，注入「[平台喚醒]」訊息給 agent，
 * agent 自己決定後續或跟使用者確認。
 *
 * 並發：agent-loop 內部已用 SessionManager.enqueueTurn 排隊，wake 不需要額外 lock。
 * 去重：5 分鐘 TTL 的 in-memory Set 防同 record 多次喚醒（race / 重啟）。
 * 失敗：agent-loop throw / channel 失聯 → return ok=false，呼叫端決定是否走 Discord 通知 fallback。
 */

import { log } from "../logger.js";
import type { MessageTrace } from "./message-trace.js";

const _wakeDedup = new Set<string>();
const DEDUP_TTL_MS = 5 * 60_000;

export interface WakeAgentOpts {
  sessionKey: string;
  channelId: string;
  accountId: string;
  agentId?: string;
  /** 注入給 agent 的訊息，會以 user role 進入新 turn 的 messages 開頭 */
  injectedMessage: string;
  source: "background-job" | "subagent";
  /** 用於去重（jobId / runId） */
  recordId: string;
  /** 可選 trace；提供時 wake turn 會被記錄、可從 dashboard 追蹤 */
  trace?: MessageTrace;
}

export interface WakeAgentResult {
  ok: boolean;
  reason?: string;
  /** wake turn 的 traceId（若 opts.trace 有提供） */
  traceId?: string;
}

export async function wakeAgentForCompletion(opts: WakeAgentOpts): Promise<WakeAgentResult> {
  const dedupKey = `${opts.source}:${opts.recordId}`;
  if (_wakeDedup.has(dedupKey)) {
    return { ok: false, reason: "already-woken" };
  }
  _wakeDedup.add(dedupKey);
  setTimeout(() => _wakeDedup.delete(dedupKey), DEDUP_TTL_MS);

  let markedActive = false;
  try {
    const { getDiscordClient, markParentStreamActive, unmarkParentStreamActive } = await import("./subagent-discord-bridge.js");
    const client = getDiscordClient();
    if (!client) return { ok: false, reason: "discord-client-not-ready" };

    const channel = await client.channels.fetch(opts.channelId).catch(() => null);
    if (!channel || !("send" in channel)) {
      return { ok: false, reason: "channel-not-sendable" };
    }

    const {
      isPlatformReady,
      getPlatformSessionManager,
      getPlatformPermissionGate,
      getPlatformToolRegistry,
      getPlatformSafetyGuard,
    } = await import("./platform.js");
    if (!isPlatformReady()) return { ok: false, reason: "platform-not-ready" };

    const { agentLoop } = await import("./agent-loop.js");
    const { getProviderRegistry } = await import("../providers/registry.js");
    const { eventBus } = await import("./event-bus.js");
    const { getBootAgentId, getBootIsAdmin } = await import("./agent-loader.js");

    const provider = getProviderRegistry().resolve();
    const agentId = opts.agentId ?? getBootAgentId();

    // mark active：wake 引發的 turn 期間，若內部 spawn 的 job/subagent 完成，
    // platform.ts fallback 看到 isParentStreamActive=true 就走 listener 路徑（不重複 wake）
    markParentStreamActive(opts.channelId);
    markedActive = true;

    const gen = agentLoop(opts.injectedMessage, {
      platform: "discord",
      channelId: opts.channelId,
      accountId: opts.accountId,
      agentId,
      isAdmin: getBootIsAdmin(),
      provider,
      _sessionKeyOverride: opts.sessionKey,
      ...(opts.trace ? { trace: opts.trace } : {}),
    }, {
      sessionManager: getPlatformSessionManager(),
      permissionGate: getPlatformPermissionGate(),
      toolRegistry: getPlatformToolRegistry(),
      safetyGuard: getPlatformSafetyGuard(),
      eventBus,
    });

    let totalText = "";
    let errored: string | null = null;
    for await (const ev of gen) {
      if (ev.type === "text_delta") totalText += ev.text;
      else if (ev.type === "done") { if (!totalText && ev.text) totalText = ev.text; break; }
      else if (ev.type === "error") { errored = ev.message; break; }
    }
    // unmark：turn 結束 → 後續 fallback 應走 wake 路徑
    unmarkParentStreamActive(opts.channelId);
    markedActive = false;

    if (errored) {
      log.warn(`[wake-agent] agent-loop error session=${opts.sessionKey}: ${errored}`);
      return { ok: false, reason: `agent-error: ${errored}` };
    }

    const trimmed = totalText.trim();
    if (trimmed) {
      const { splitForDiscord } = await import("../cli-bridge/reply.js");
      const chunks = splitForDiscord(trimmed);
      const sendable = channel as { send: (content: string) => Promise<unknown> };
      for (const c of chunks) {
        await sendable.send(c).catch((e: unknown) => {
          log.warn(`[wake-agent] send 失敗：${e instanceof Error ? e.message : String(e)}`);
        });
      }
    }

    log.info(`[wake-agent] woke session=${opts.sessionKey} source=${opts.source} record=${opts.recordId.slice(0, 8)} replyChars=${trimmed.length}${opts.trace ? ` trace=${opts.trace.traceId.slice(0, 8)}` : ""}`);
    return { ok: true, traceId: opts.trace?.traceId };
  } catch (err) {
    log.warn(`[wake-agent] 失敗 session=${opts.sessionKey} source=${opts.source}: ${err instanceof Error ? err.message : String(err)}`);
    if (markedActive) {
      try {
        const { unmarkParentStreamActive } = await import("./subagent-discord-bridge.js");
        unmarkParentStreamActive(opts.channelId);
      } catch { /* 靜默 */ }
    }
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
