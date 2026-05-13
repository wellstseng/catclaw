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
    this.persist();
    this.onComplete?.(r);
  }

  fail(jobId: string, reason: string, exitCode: number | null): void {
    const r = this.records.get(jobId);
    if (!r) return;
    r.status = "failed";
    r.exitCode = exitCode;
    r.endedAt = Date.now();
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
    this.persist();
    this.onFail?.(r, "max duration exceeded");
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
      // 6. process 活 + 輸出齊 → 視為完成（程式可能還沒收尾但結果已到）
      if (!alive) {
        if (outputsOk || !r.expectedOutputs?.length) {
          // 沒有 expectedOutputs 約定時，僅靠 process 死視為完成（exitCode 不可知，標 null）
          this.complete(r.jobId, null);
        } else {
          this.fail(r.jobId, "process exited but expected outputs missing", null);
        }
      } else if (outputsOk && r.expectedOutputs?.length) {
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
      for (const stored of parsed.records ?? []) {
        // running 但 PID 已死 → 標 stale（無法判斷成功與否）
        if (stored.status === "running" && stored.pid && !isProcessAlive(stored.pid)) {
          stored.status = "stale";
          stored.endedAt = stored.endedAt ?? Date.now();
        }
        this.records.set(stored.jobId, stored);
      }
      const running = Array.from(this.records.values()).filter(r => r.status === "running").length;
      log.info(`[bg-job] 載入 ${this.records.size} 筆，其中 ${running} 筆仍 running`);
    } catch (err) {
      log.warn(`[bg-job] loadFromDisk 失敗：${err instanceof Error ? err.message : String(err)}`);
    }
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
