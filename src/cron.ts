/**
 * @file cron.ts
 * @description 排程服務 — 仿 OpenClaw 的 timer loop + job 持久化
 *
 * 核心機制：
 * 1. setTimeout loop 輪詢到期 job（2-60s 間隔）
 * 2. croner 解析 cron 表達式、計算下次執行時間
 * 3. 兩種 action：message（直接發訊息）/ claude（spawn Claude turn）
 * 4. Job 狀態持久化到 data/cron-jobs.json
 * 5. 重試 + 指數退避
 * 6. 併發限制
 *
 * 對外 API：startCron(client) / stopCron()
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { Cron } from "croner";
import type { Client, SendableChannels } from "discord.js";
import { config } from "./config.js";
import type { CronJobDef, CronSchedule } from "./config.js";
import { runClaudeTurn } from "./acp.js";
import { log } from "./logger.js";

// ── 型別定義 ────────────────────────────────────────────────────────────────

/** 持久化的 job 狀態 */
interface CronJobState {
  nextRunAtMs: number;
  lastRunAtMs?: number;
  lastResult?: "success" | "error";
  lastError?: string;
  retryCount: number;
}

/** 運行時 job = 定義 + 狀態 */
interface CronJobRuntime {
  def: CronJobDef;
  state: CronJobState;
}

/** 持久化格式 */
interface CronStore {
  version: 1;
  jobs: Record<string, CronJobState>;
}

// ── 常數 ────────────────────────────────────────────────────────────────────

const STORE_PATH = resolve(process.cwd(), "data", "cron-jobs.json");
const MIN_TIMER_MS = 2_000;
const MAX_TIMER_MS = 60_000;

/** 重試退避時間表（毫秒） */
const BACKOFF_SCHEDULE_MS = [
  30_000,      // 第 1 次 → 30s
  60_000,      // 第 2 次 → 1 min
  300_000,     // 第 3 次 → 5 min
];

// ── 內部狀態 ────────────────────────────────────────────────────────────────

let discordClient: Client | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;
const jobs = new Map<string, CronJobRuntime>();

// ── Schedule 計算 ───────────────────────────────────────────────────────────

/**
 * 計算 schedule 的下次執行時間
 * @returns epoch ms，若無法計算回傳 Infinity
 */
function computeNextRunAtMs(schedule: CronSchedule, nowMs: number): number {
  switch (schedule.kind) {
    case "cron": {
      try {
        const cron = new Cron(schedule.expr, { timezone: schedule.tz });
        const next = cron.nextRun();
        return next ? next.getTime() : Infinity;
      } catch {
        log.warn(`[cron] 無效的 cron 表達式：${schedule.expr}`);
        return Infinity;
      }
    }
    case "every":
      return nowMs + schedule.everyMs;
    case "at": {
      const ts = new Date(schedule.at).getTime();
      return isNaN(ts) ? Infinity : ts;
    }
  }
}

// ── 持久化 ──────────────────────────────────────────────────────────────────

/** 從磁碟載入 job 狀態 */
function loadStore(): CronStore {
  try {
    const raw = readFileSync(STORE_PATH, "utf-8");
    return JSON.parse(raw) as CronStore;
  } catch {
    return { version: 1, jobs: {} };
  }
}

/** 將 job 狀態寫入磁碟（原子寫入） */
function saveStore(): void {
  const store: CronStore = { version: 1, jobs: {} };
  for (const [id, job] of jobs) {
    store.jobs[id] = job.state;
  }

  try {
    const dir = dirname(STORE_PATH);
    mkdirSync(dir, { recursive: true });
    const tmpFile = STORE_PATH + ".tmp";
    writeFileSync(tmpFile, JSON.stringify(store, null, 2), "utf-8");
    renameSync(tmpFile, STORE_PATH);
  } catch (err) {
    log.warn(`[cron] 儲存 cron-jobs.json 失敗：${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Job 初始化 ──────────────────────────────────────────────────────────────

/**
 * 從 config 載入 job 定義，合併磁碟上的狀態
 */
function initJobs(): void {
  const store = loadStore();
  const nowMs = Date.now();
  jobs.clear();

  for (const def of config.cron.jobs) {
    const existing = store.jobs[def.id];
    const state: CronJobState = existing ?? {
      nextRunAtMs: computeNextRunAtMs(def.schedule, nowMs),
      retryCount: 0,
    };

    // 若 nextRunAtMs 已過期（例如 bot 離線期間），立即排到下一次
    if (state.nextRunAtMs < nowMs && def.schedule.kind !== "at") {
      state.nextRunAtMs = computeNextRunAtMs(def.schedule, nowMs);
    }

    jobs.set(def.id, { def, state });
  }

  log.info(`[cron] 已載入 ${jobs.size} 個 job`);
  saveStore();
}

// ── Job 執行 ────────────────────────────────────────────────────────────────

/**
 * 執行 message action：直接發訊息到頻道
 */
async function execMessage(channelId: string, text: string): Promise<void> {
  if (!discordClient) throw new Error("Discord client 未初始化");

  const channel = await discordClient.channels.fetch(channelId);
  if (!channel || !("send" in channel)) {
    throw new Error(`找不到頻道或無法發送：${channelId}`);
  }
  await (channel as SendableChannels).send(text);
}

/**
 * 執行 claude action：spawn Claude turn，收集回覆文字，發送到頻道
 */
async function execClaude(channelId: string, prompt: string): Promise<void> {
  if (!discordClient) throw new Error("Discord client 未初始化");

  const channel = await discordClient.channels.fetch(channelId);
  if (!channel || !("send" in channel)) {
    throw new Error(`找不到頻道或無法發送：${channelId}`);
  }

  // 收集 Claude 回覆
  let responseText = "";
  for await (const event of runClaudeTurn(
    null, // 不 resume，每次獨立 session
    prompt,
    config.claude.cwd,
    config.claude.command,
  )) {
    if (event.type === "text_delta") {
      responseText += event.text;
    } else if (event.type === "error") {
      throw new Error(event.message);
    }
  }

  // 送出結果
  if (responseText.trim()) {
    const sendable = channel as SendableChannels;
    // 分段送出（2000 字上限）
    let remaining = responseText.trim();
    while (remaining.length > 0) {
      await sendable.send(remaining.slice(0, 2000));
      remaining = remaining.slice(2000);
    }
  }
}

/**
 * 執行單一 job
 */
async function runJob(job: CronJobRuntime): Promise<void> {
  const { def, state } = job;
  log.info(`[cron] 執行 job: ${def.name} (${def.id})`);

  try {
    if (def.action.type === "message") {
      await execMessage(def.action.channelId, def.action.text);
    } else {
      await execClaude(def.action.channelId, def.action.prompt);
    }

    // 成功
    state.lastResult = "success";
    state.lastError = undefined;
    state.retryCount = 0;
    state.lastRunAtMs = Date.now();

    // 一次性 job → 移除
    if (def.deleteAfterRun || def.schedule.kind === "at") {
      log.info(`[cron] 一次性 job 完成，移除：${def.name}`);
      jobs.delete(def.id);
    } else {
      // 計算下次執行時間
      state.nextRunAtMs = computeNextRunAtMs(def.schedule, Date.now());
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`[cron] job 執行失敗：${def.name} — ${message}`);

    state.lastResult = "error";
    state.lastError = message;
    state.lastRunAtMs = Date.now();

    const maxRetries = def.maxRetries ?? 3;
    if (state.retryCount < maxRetries) {
      // 重試：指數退避
      const backoffMs = BACKOFF_SCHEDULE_MS[Math.min(state.retryCount, BACKOFF_SCHEDULE_MS.length - 1)];
      state.retryCount++;
      state.nextRunAtMs = Date.now() + backoffMs;
      log.info(`[cron] 排程重試 #${state.retryCount}（${Math.round(backoffMs / 1000)}s 後）：${def.name}`);
    } else {
      // 超過重試上限，跳到下次正常排程
      state.retryCount = 0;
      if (def.schedule.kind !== "at") {
        state.nextRunAtMs = computeNextRunAtMs(def.schedule, Date.now());
      } else {
        log.warn(`[cron] 一次性 job 重試用盡，移除：${def.name}`);
        jobs.delete(def.id);
      }
    }
  }

  saveStore();
}

// ── Timer Loop（仿 OpenClaw） ───────────────────────────────────────────────

/**
 * 找出所有到期的 job
 */
function collectRunnableJobs(nowMs: number): CronJobRuntime[] {
  const due: CronJobRuntime[] = [];
  for (const job of jobs.values()) {
    if (job.def.enabled !== false && job.state.nextRunAtMs <= nowMs) {
      due.push(job);
    }
  }
  return due;
}

/**
 * timer tick：找到期 job → 並行執行（受 maxConcurrentRuns 限制）→ 重新 arm
 */
async function onTimer(): Promise<void> {
  const nowMs = Date.now();
  const dueJobs = collectRunnableJobs(nowMs);

  if (dueJobs.length > 0) {
    const concurrency = Math.min(config.cron.maxConcurrentRuns, dueJobs.length);
    let cursor = 0;

    // Worker pool pattern（仿 OpenClaw）
    const workers = Array.from({ length: concurrency }, async () => {
      while (true) {
        const index = cursor++;
        if (index >= dueJobs.length) return;
        await runJob(dueJobs[index]);
      }
    });

    await Promise.all(workers);
  }

  // 重新 arm timer
  armTimer();
}

/**
 * 計算下一個 timer 到期時間，設定 setTimeout
 */
function armTimer(): void {
  if (!running) return;

  // 找最近的 nextRunAtMs
  let earliest = Infinity;
  for (const job of jobs.values()) {
    if (job.def.enabled !== false && job.state.nextRunAtMs < earliest) {
      earliest = job.state.nextRunAtMs;
    }
  }

  const nowMs = Date.now();
  const delayMs = earliest === Infinity
    ? MAX_TIMER_MS
    : Math.max(MIN_TIMER_MS, Math.min(earliest - nowMs, MAX_TIMER_MS));

  timer = setTimeout(() => {
    void onTimer().catch((err) => {
      log.error(`[cron] timer tick 失敗：${err instanceof Error ? err.message : String(err)}`);
      armTimer(); // 出錯也要繼續
    });
  }, delayMs);
}

// ── 對外 API ────────────────────────────────────────────────────────────────

/**
 * 啟動排程服務
 * @param client Discord Client（用於發送訊息）
 */
export function startCron(client: Client): void {
  if (!config.cron.enabled) {
    log.info("[cron] 排程服務未啟用（cron.enabled = false）");
    return;
  }

  discordClient = client;
  running = true;

  initJobs();
  armTimer();

  log.info(`[cron] 排程服務已啟動（${jobs.size} 個 job，max concurrent: ${config.cron.maxConcurrentRuns}）`);
}

/**
 * 停止排程服務
 */
export function stopCron(): void {
  running = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  log.info("[cron] 排程服務已停止");
}
