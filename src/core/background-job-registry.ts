/**
 * @file core/background-job-registry.ts
 * @description Background Job Registry — 追蹤本地 shell 長期程式
 *
 * 設計：
 * - run_background_command 工具起 process → registry.create()
 * - Poller 每 30s 檢查 process alive + expectedOutputs 是否齊全
 * - 完成 / 失敗 / 逾時 → eventBus.emit("background-job:*") → 由 agent-loop 接住
 * - 重啟後 loadFromDisk 重建記憶；running 但 PID 已死 → 標 stale
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { log } from "../logger.js";

const PERSIST_PATH = join(homedir(), ".catclaw", "workspace", "data", "jobs", "registry.json");
const MAX_RETAINED_JOBS = 200;
const DEFAULT_POLL_INTERVAL_MS = 30_000;
// 「process 活著 + output 已到」分支的穩定門檻：output 非空且 mtime ≥ 5s 沒變才算完成。
// 防 `cmd > out.md` 開頭立即建 0-byte 檔被誤判 completed（bug case：jobId 03bb6aa2，startedAt+636ms 誤判）。
const OUTPUT_STABLE_MS = 5_000;

export type JobStatus = "running" | "completed" | "failed" | "killed" | "timeout" | "stale";

export interface BackgroundJobRecord {
  jobId: string;
  parentSessionKey: string;
  label: string;
  command: string;
  cwd?: string;
  status: JobStatus;
  pid?: number;
  /** 預期完成時應出現的檔案 glob/絕對路徑（任一缺失 → 視為未完成） */
  expectedOutputs?: string[];
  /** stdout 持久化檔（內部寫入） */
  stdoutPath?: string;
  exitCode?: number | null;
  startedAt: number;
  endedAt?: number;
  /** 最近一次 poller 檢查時間 */
  lastPolledAt?: number;
  /** poller 自我輪詢間隔（ms） */
  pollIntervalMs: number;
  /** 觸發 timeout 的 deadline（startedAt + maxDurationMs；0 = 不限時） */
  maxDurationMs: number;
  discordChannelId?: string;
  /** 啟動者 accountId（wake-agent 重啟新 turn 時用） */
  accountId?: string;
  /** 啟動者 agentId（wake-agent 重啟新 turn 時用；多 agent 場景識別） */
  agentId?: string;
  /**
   * ACK 旗標（解 LLM silent end_turn 漏報）：
   * - complete/fail/timeout 時 mark false
   * - agent-loop 把 result 注入 LLM messages 時 mark true
   * - turn 結束 scan：completed 但 acked=false → 補 wake
   * undefined = 舊紀錄（不掃，避免重啟後大量補 wake）
   */
  acked?: boolean;
  /** 最近一次 startup recovery 被動觀察時間；重啟 recovery 不喚醒 agent */
  recoveryObservedAt?: number;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function allExpectedOutputsExist(paths: string[] | undefined): boolean {
  if (!paths || paths.length === 0) return false;
  for (const p of paths) {
    if (p.includes("*") || p.includes("?")) {
      // glob 不在此判斷，留給 caller 用 fs.glob；簡化版只接絕對路徑
      return false;
    }
    try {
      statSync(p);
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * 「process 還活著 + output 已到」分支用的穩定性判斷。
 * 修 false-positive：`cmd > out.md` 一啟動 shell 就立刻建立 0-byte out.md，
 * 純 existence 檢查會在 poll 第一輪就誤判 completed（startedAt+636ms case 已觀察到）。
 *
 * 條件：所有 expected output 都 (a) 存在 (b) size > 0 (c) mtime 至少 stableForMs 沒變
 */
function allExpectedOutputsStable(paths: string[] | undefined, stableForMs: number): boolean {
  if (!paths || paths.length === 0) return false;
  const now = Date.now();
  for (const p of paths) {
    if (p.includes("*") || p.includes("?")) return false;
    try {
      const s = statSync(p);
      if (s.size === 0) return false;
      if (now - s.mtimeMs < stableForMs) return false;
    } catch {
      return false;
    }
  }
  return true;
}

export class BackgroundJobRegistry {
  private records = new Map<string, BackgroundJobRecord>();
  private pollerHandle: ReturnType<typeof setInterval> | null = null;
  private onComplete?: (r: BackgroundJobRecord) => void;
  private onFail?: (r: BackgroundJobRecord, reason: string) => void;

  setEventHandlers(opts: {
    onComplete?: (r: BackgroundJobRecord) => void;
    onFail?: (r: BackgroundJobRecord, reason: string) => void;
  }): void {
    this.onComplete = opts.onComplete;
    this.onFail = opts.onFail;
  }

  create(opts: {
    parentSessionKey: string;
    label: string;
    command: string;
    cwd?: string;
    pid: number;
    stdoutPath?: string;
    expectedOutputs?: string[];
    pollIntervalMs?: number;
    maxDurationMs?: number;
    discordChannelId?: string;
    accountId?: string;
    agentId?: string;
  }): BackgroundJobRecord {
    const jobId = randomUUID();
    const record: BackgroundJobRecord = {
      jobId,
      parentSessionKey: opts.parentSessionKey,
      label: opts.label,
      command: opts.command,
      cwd: opts.cwd,
      status: "running",
      pid: opts.pid,
      stdoutPath: opts.stdoutPath,
      expectedOutputs: opts.expectedOutputs,
      startedAt: Date.now(),
      pollIntervalMs: opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      maxDurationMs: opts.maxDurationMs ?? 0,
      discordChannelId: opts.discordChannelId,
      accountId: opts.accountId,
      agentId: opts.agentId,
    };
    this.records.set(jobId, record);
    log.info(`[bg-job] 建立 jobId=${jobId} label=${opts.label} pid=${opts.pid}`);
    this.persist();
    return record;
  }

  get(jobId: string): BackgroundJobRecord | undefined {
    return this.records.get(jobId);
  }

  listByParent(parentSessionKey: string): BackgroundJobRecord[] {
    return Array.from(this.records.values()).filter(r => r.parentSessionKey === parentSessionKey);
  }

  /** 列所有 records（dashboard 用，跨 session） */
  listAll(): BackgroundJobRecord[] {
    return Array.from(this.records.values());
  }

  /** 從紀錄移除（dashboard 手動清理用，不刪 stdout 檔） */
  deleteJob(jobId: string): boolean {
    const r = this.records.get(jobId);
    if (!r) return false;
    if (r.status === "running" && r.pid && isProcessAlive(r.pid)) {
      // running 還活著的不允許直接 delete，要先 kill
      return false;
    }
    this.records.delete(jobId);
    this.persist();
    return true;
  }

  listRunning(): BackgroundJobRecord[] {
    return Array.from(this.records.values()).filter(r => r.status === "running");
  }

  kill(jobId: string): boolean {
    const r = this.records.get(jobId);
    if (!r || r.status !== "running" || !r.pid) return false;
    try {
      process.kill(r.pid, "SIGTERM");
      setTimeout(() => {
        try { if (r.pid) process.kill(r.pid, "SIGKILL"); } catch { /* dead */ }
      }, 2000);
    } catch { /* already dead */ }
    r.status = "killed";
    r.endedAt = Date.now();
    log.info(`[bg-job] killed jobId=${jobId}`);
    this.persist();
    return true;
  }

  complete(jobId: string, exitCode: number | null): void {
    const r = this.records.get(jobId);
    if (!r) return;
    r.status = "completed";
    r.exitCode = exitCode;
    r.endedAt = Date.now();
    r.acked = false;
    this.persist();
    this.onComplete?.(r);
  }

  fail(jobId: string, reason: string, exitCode: number | null): void {
    const r = this.records.get(jobId);
    if (!r) return;
    r.status = "failed";
    r.exitCode = exitCode;
    r.endedAt = Date.now();
    r.acked = false;
    this.persist();
    this.onFail?.(r, reason);
  }

  timeoutJob(jobId: string): void {
    const r = this.records.get(jobId);
    if (!r) return;
    if (r.pid) {
      try { process.kill(r.pid, "SIGTERM"); } catch { /* dead */ }
    }
    r.status = "timeout";
    r.endedAt = Date.now();
    r.acked = false;
    this.persist();
    this.onFail?.(r, "max duration exceeded");
  }

  /** 標記 record 已 ACK（agent-loop 注入結果到 LLM messages 時呼叫） */
  markAcked(jobId: string): void {
    const r = this.records.get(jobId);
    if (!r) return;
    r.acked = true;
    this.persist();
  }

  /** 啟動週期 poller，每秒檢查一次（內部 throttle 至每 job 的 pollIntervalMs） */
  startPoller(): void {
    if (this.pollerHandle) return;
    this.pollerHandle = setInterval(() => this.tick(), 1000);
  }

  stopPoller(): void {
    if (this.pollerHandle) {
      clearInterval(this.pollerHandle);
      this.pollerHandle = null;
    }
  }

  private tick(): void {
    const now = Date.now();
    for (const r of this.records.values()) {
      if (r.status !== "running") continue;
      if (r.lastPolledAt && now - r.lastPolledAt < r.pollIntervalMs) continue;
      r.lastPolledAt = now;

      // 1. process alive 檢查
      const alive = r.pid ? isProcessAlive(r.pid) : false;

      // 2. expectedOutputs 全部存在 → 視為完成
      const outputsOk = allExpectedOutputsExist(r.expectedOutputs);

      // 3. max duration 觸頂
      if (r.maxDurationMs > 0 && now - r.startedAt >= r.maxDurationMs) {
        log.warn(`[bg-job] 超時 jobId=${r.jobId} elapsed=${Math.round((now - r.startedAt) / 1000)}s`);
        this.timeoutJob(r.jobId);
        continue;
      }

      // 4. process 死 + 預期輸出齊 → completed
      // 5. process 死 + 預期輸出不齊 → failed
      // 6. process 活 + 輸出齊（穩定）→ 視為完成（程式可能還沒收尾但結果已到）
      //    穩定條件 = 非空 + mtime ≥ 5s 沒變；防 `cmd > file.md` 開頭立即建空檔誤判 completed
      if (!alive) {
        if (outputsOk || !r.expectedOutputs?.length) {
          // 沒有 expectedOutputs 約定時，僅靠 process 死視為完成（exitCode 不可知，標 null）
          this.complete(r.jobId, null);
        } else {
          this.fail(r.jobId, "process exited but expected outputs missing", null);
        }
      } else if (r.expectedOutputs?.length && allExpectedOutputsStable(r.expectedOutputs, OUTPUT_STABLE_MS)) {
        this.complete(r.jobId, null);
      }
    }
  }

  private toPersistable(r: BackgroundJobRecord): BackgroundJobRecord {
    return r; // 全欄位都可序列化（無 controller / handle）
  }

  private persist(): void {
    try {
      mkdirSync(dirname(PERSIST_PATH), { recursive: true });
      const all = Array.from(this.records.values())
        .sort((a, b) => b.startedAt - a.startedAt)
        .slice(0, MAX_RETAINED_JOBS)
        .map(r => this.toPersistable(r));
      writeFileSync(PERSIST_PATH, JSON.stringify({ version: 1, records: all }, null, 2));
    } catch (err) {
      log.warn(`[bg-job] persist 失敗：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  loadFromDisk(): void {
    try {
      if (!existsSync(PERSIST_PATH)) return;
      const raw = readFileSync(PERSIST_PATH, "utf-8");
      const parsed = JSON.parse(raw) as { version?: number; records?: BackgroundJobRecord[] };
      let staleConverted = 0;
      for (const stored of parsed.records ?? []) {
        // running 但 PID 已死 → 標 stale（無法判斷成功與否）。
        // 不在 load 階段喚醒 agent；startup recovery 只做被動收斂，避免重啟觸發工作流。
        if (stored.status === "running" && stored.pid && !isProcessAlive(stored.pid)) {
          stored.status = "stale";
          stored.endedAt = stored.endedAt ?? Date.now();
          stored.acked = false;
          staleConverted++;
        }
        this.records.set(stored.jobId, stored);
      }
      const running = Array.from(this.records.values()).filter(r => r.status === "running").length;
      log.info(`[bg-job] 載入 ${this.records.size} 筆，其中 ${running} 筆仍 running${staleConverted > 0 ? `，stale 化 ${staleConverted} 筆（startup recovery 將被動標記，不喚醒 agent）` : ""}`);
      // stale 變動需 persist 回 disk，否則下次重啟仍誤認 running
      if (staleConverted > 0) this.persist();
    } catch (err) {
      log.warn(`[bg-job] loadFromDisk 失敗：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Startup Recovery（被動收斂）：
   * 重啟期間不應主動啟動 agent turn，否則 restart 本身會造成「不該跑的 job」。
   * 因此本方法只掃 1h 內結束的 unacked records，標記為已觀察 / acked，
   * 不 emit background-job:* event，也不呼叫 onComplete/onFail。
   *
   * 條件：acked === false（明確 false，舊紀錄 undefined 不掃）+ endedAt 在 cutoff 內
   * 時窗 1h：避免重啟後對遠古 records 大量改寫
   */
  runStartupRecovery(timeWindowMs: number = 60 * 60_000): void {
    const now = Date.now();
    const cutoff = now - timeWindowMs;
    const candidates = Array.from(this.records.values()).filter(r => {
      if (r.acked !== false) return false;  // undefined 不掃、true 不掃
      if (!r.endedAt || r.endedAt < cutoff) return false;
      return r.status === "completed" || r.status === "failed" || r.status === "timeout" || r.status === "stale";
    });
    if (candidates.length === 0) {
      log.debug(`[bg-job] startup recovery：無 unacked recent record 需處理`);
      return;
    }
    log.info(`[bg-job] startup recovery：發現 ${candidates.length} 筆 acked=false 且 ${Math.round(timeWindowMs / 60_000)} 分鐘內結束的 record，已被動標記 acked（不喚醒 agent）`);
    for (const r of candidates) {
      r.recoveryObservedAt = now;
      r.acked = true;
    }
    this.persist();
  }
}

let _registry: BackgroundJobRegistry | null = null;

export function initBackgroundJobRegistry(): BackgroundJobRegistry {
  _registry = new BackgroundJobRegistry();
  _registry.loadFromDisk();
  _registry.startPoller();
  return _registry;
}

export function getBackgroundJobRegistry(): BackgroundJobRegistry | null {
  return _registry;
}
