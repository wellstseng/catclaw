/**
 * @file discord-login.ts
 * @description Discord 登入＋連不上時退避重試
 *
 * 啟動當下連不到 Discord（網路還沒通、DNS 慢、Discord 抖動）時，
 * 單次 login 失敗會讓行程活著卻永遠不上線。這裡改成重試到連上為止。
 *
 * 流程：先探路（不帶 token 打 /gateway）→ 通了才 client.login。
 * 探路失敗不會動到 client——discord.js 的 login 失敗會 destroy client
 * （清掉 REST／快取的定時清理），所以常見的「連不上」盡量擋在探路這層。
 */

import { log } from "./logger.js";

const PROBE_URL = "https://discord.com/api/v10/gateway";
const PROBE_TIMEOUT_MS = 10_000;

/** 重試也沒用的錯（設定問題）：token 無效、intent 沒在 Developer Portal 開 */
const FATAL_CODES = new Set(["TokenInvalid", "DisallowedIntents"]);

export function isFatalLoginError(err: unknown): boolean {
  const e = err as { code?: unknown; status?: unknown } | null;
  return FATAL_CODES.has(String(e?.code)) || e?.status === 401;
}

/** 第 attempt 次失敗後要等多久：5s、10s、20s、40s，之後固定 60s */
export function retryDelayMs(attempt: number, baseMs = 5_000, maxMs = 60_000): number {
  return Math.min(baseMs * 2 ** (attempt - 1), maxMs);
}

function waitMs(ms: number): Promise<void> {
  return new Promise<void>((done) => setTimeout(done, ms));
}

async function probeDiscord(): Promise<void> {
  const res = await fetch(PROBE_URL, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  await res.body?.cancel();
  if (res.status >= 500) throw new Error(`Discord API 回 ${res.status}`);
}

export interface LoginRetryOptions {
  /** 探路：連得上就 resolve，連不上就 throw */
  probe?: () => Promise<void>;
  /** 兩次嘗試之間的等待 */
  sleep?: (ms: number) => Promise<void>;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

/**
 * 登入 Discord，連不上就退避重試到成功為止。
 * 設定類錯誤（isFatalLoginError）不重試，直接 throw 給呼叫端處理。
 * @returns 總共試了幾次
 */
export async function loginWithRetry(
  client: { login(token: string): Promise<unknown> },
  token: string,
  opts: LoginRetryOptions = {},
): Promise<number> {
  const probe = opts.probe ?? probeDiscord;
  const sleep = opts.sleep ?? waitMs;

  for (let attempt = 1; ; attempt++) {
    try {
      await probe();
      await client.login(token);
      if (attempt > 1) log.info(`[bridge] Discord 登入成功（第 ${attempt} 次嘗試）`);
      return attempt;
    } catch (err) {
      if (isFatalLoginError(err)) throw err;
      const delay = retryDelayMs(attempt, opts.baseDelayMs, opts.maxDelayMs);
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`[bridge] Discord 登入失敗（第 ${attempt} 次），${Math.round(delay / 1000)}s 後重試：${msg}`);
      await sleep(delay);
    }
  }
}
