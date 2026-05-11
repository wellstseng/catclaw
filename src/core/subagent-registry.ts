/**
 * @file core/subagent-registry.ts
 * @description Subagent Registry — 追蹤所有子 agent 執行記錄
 *
 * 設計：
 * - 每次 spawn_subagent 建立 SubagentRunRecord（in-memory）
 * - 提供 list/kill/complete/fail 操作
 * - 全域單例（initSubagentRegistry / getSubagentRegistry）
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { log } from "../logger.js";

// ── 持久化 ───────────────────────────────────────────────────────────────────

const PERSIST_PATH = join(homedir(), ".catclaw", "workspace", "data", "subagents", "registry.json");
const MAX_RETAINED_RECORDS = 500;

// ── 型別 ─────────────────────────────────────────────────────────────────────

/** 重啟前處於 running 的 record 在 reload 時會被標為 interrupted（worker 已死，無法續跑） */
export type SubagentStatus = "running" | "completed" | "failed" | "killed" | "timeout" | "interrupted";
export type SubagentMode = "run" | "session";
export type SubagentRuntime = "default" | "coding" | "acp" | "explore" | "plan" | "build" | "review" | (string & {});

export interface SubagentRunRecord {
  runId: string;
  parentSessionKey: string;
  childSessionKey: string;         // 格式：{parent}:sub:{uuid}
  task: string;
  label?: string;
  mode: SubagentMode;
  runtime: SubagentRuntime;
  async: boolean;
  status: SubagentStatus;
  result?: string;
  error?: string;
  abortController: AbortController;
  discordChannelId?: string;       // async 模式通知用
  discordThreadId?: string;        // mode:session thread 綁定
  keepSession: boolean;
  accountId: string;               // 繼承父 accountId
  createdAt: number;
  endedAt?: number;
  turns?: number;
  /** 建立此 record 的父 subagent runId（頂層 spawn 無此欄位） */
  parentId?: string;
}

export type SpawnResult =
  | { status: "completed";  result: string; sessionKey: string; turns: number }
  | { status: "spawned";    runId: string; sessionKey: string; note?: string }   // async mode
  | { status: "timeout";    result: null }
  | { status: "error";      error: string }
  | { status: "forbidden";  reason: "no_spawn_allowed" | "max_concurrent" };

// ── SubagentRegistry ──────────────────────────────────────────────────────────

export class SubagentRegistry {
  private records = new Map<string, SubagentRunRecord>();
  private readonly maxConcurrent: number;

  constructor(maxConcurrent = 3) {
    this.maxConcurrent = maxConcurrent;
  }

  /** 建立新 record，回傳 runId */
  create(opts: {
    parentSessionKey: string;
    task: string;
    label?: string;
    mode?: SubagentMode;
    runtime?: SubagentRuntime;
    async?: boolean;
    keepSession?: boolean;
    discordChannelId?: string;
    accountId: string;
    /** 父 subagent runId（頂層 spawn 不傳） */
    parentId?: string;
    /** Agent ID — 有值時 session key 為 deterministic（自動恢復歷史） */
    agentId?: string;
  }): SubagentRunRecord {
    const runId = randomUUID();
    const childSessionKey = opts.agentId
      ? `${opts.parentSessionKey}:agent:${opts.agentId}`
      : `${opts.parentSessionKey}:sub:${runId}`;

    const record: SubagentRunRecord = {
      runId,
      parentSessionKey: opts.parentSessionKey,
      childSessionKey,
      task: opts.task,
      label: opts.label,
      mode: opts.mode ?? "run",
      runtime: opts.runtime ?? "default",
      async: opts.async ?? false,
      status: "running",
      abortController: new AbortController(),
      discordChannelId: opts.discordChannelId,
      keepSession: opts.keepSession ?? false,
      accountId: opts.accountId,
      createdAt: Date.now(),
      parentId: opts.parentId,
    };

    this.records.set(runId, record);
    log.debug(`[subagent-registry] 建立 runId=${runId} parent=${opts.parentSessionKey}`);
    this.persist();
    return record;
  }

  get(runId: string): SubagentRunRecord | undefined {
    return this.records.get(runId);
  }

  listByParent(parentSessionKey: string, recentMinutes?: number): SubagentRunRecord[] {
    const cutoff = recentMinutes ? Date.now() - recentMinutes * 60_000 : 0;
    return Array.from(this.records.values()).filter(
      r => r.parentSessionKey === parentSessionKey && r.createdAt >= cutoff,
    );
  }

  countRunning(parentSessionKey: string): number {
    return Array.from(this.records.values()).filter(
      r => r.parentSessionKey === parentSessionKey && r.status === "running",
    ).length;
  }

  isOverConcurrentLimit(parentSessionKey: string): boolean {
    return this.countRunning(parentSessionKey) >= this.maxConcurrent;
  }

  kill(runId: string): boolean {
    const record = this.records.get(runId);
    if (!record || record.status !== "running") return false;
    record.abortController.abort();
    record.status = "killed";
    record.endedAt = Date.now();
    log.info(`[subagent-registry] killed runId=${runId}`);
    this.cascadeAbortChildren(runId, "killed");
    this.persist();
    return true;
  }

  /** 級聯中止：將所有 parentId===runId 且 running 的子 agent 標記為 killed */
  private cascadeAbortChildren(parentRunId: string, parentStatus: string): void {
    for (const child of this.records.values()) {
      if (child.parentId === parentRunId && child.status === "running") {
        child.abortController.abort();
        child.status = "killed";
        child.error = `cascade abort: parent ${parentRunId} ${parentStatus}`;
        child.endedAt = Date.now();
        log.info(`[subagent-registry] cascade killed runId=${child.runId} (parent=${parentRunId})`);
      }
    }
  }

  killAll(parentSessionKey: string): number {
    let count = 0;
    for (const record of this.records.values()) {
      if (record.parentSessionKey === parentSessionKey && record.status === "running") {
        this.kill(record.runId);
        count++;
      }
    }
    return count;
  }

  complete(runId: string, result: string, turns?: number): void {
    const record = this.records.get(runId);
    if (!record) return;
    record.status = "completed";
    record.result = result;
    record.turns = turns;
    record.endedAt = Date.now();
    this.persist();
  }

  fail(runId: string, error: string): void {
    const record = this.records.get(runId);
    if (!record) return;
    record.status = "failed";
    record.error = error;
    record.endedAt = Date.now();
    this.cascadeAbortChildren(runId, "failed");
    this.persist();
  }

  timeout(runId: string): void {
    const record = this.records.get(runId);
    if (!record) return;
    record.abortController.abort();
    record.status = "timeout";
    record.endedAt = Date.now();
    this.persist();
  }

  // ── 持久化 ─────────────────────────────────────────────────────────────────

  /** 序列化 record（去掉 abortController；preview task 控長度） */
  private toPersistable(r: SubagentRunRecord): Omit<SubagentRunRecord, "abortController"> {
    const { abortController: _ac, ...rest } = r;
    return rest;
  }

  /** 同步寫整份 snapshot 到磁碟（記錄量不大，直接重寫；retention 套用） */
  private persist(): void {
    try {
      mkdirSync(dirname(PERSIST_PATH), { recursive: true });
      const all = Array.from(this.records.values())
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, MAX_RETAINED_RECORDS)
        .map(r => this.toPersistable(r));
      writeFileSync(PERSIST_PATH, JSON.stringify({ version: 1, records: all }, null, 2));
    } catch (err) {
      log.warn(`[subagent-registry] persist 失敗：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 啟動時讀取：running → interrupted（worker 已死）；補回 abortController */
  loadFromDisk(): void {
    try {
      if (!existsSync(PERSIST_PATH)) return;
      const raw = readFileSync(PERSIST_PATH, "utf-8");
      const parsed = JSON.parse(raw) as { version?: number; records?: Array<Omit<SubagentRunRecord, "abortController">> };
      const records = parsed.records ?? [];
      for (const stored of records) {
        const status: SubagentStatus = stored.status === "running" ? "interrupted" : stored.status;
        const rebuilt: SubagentRunRecord = {
          ...stored,
          status,
          endedAt: stored.endedAt ?? (status === "interrupted" ? Date.now() : undefined),
          error: status === "interrupted" ? (stored.error ?? "catclaw 重啟，worker 已中斷") : stored.error,
          abortController: new AbortController(),
        };
        this.records.set(rebuilt.runId, rebuilt);
      }
      log.info(`[subagent-registry] 載入 ${records.length} 筆歷史記錄`);
    } catch (err) {
      log.warn(`[subagent-registry] loadFromDisk 失敗：${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// ── 全域單例 ──────────────────────────────────────────────────────────────────

let _registry: SubagentRegistry | null = null;

export function initSubagentRegistry(maxConcurrent?: number): SubagentRegistry {
  _registry = new SubagentRegistry(maxConcurrent);
  _registry.loadFromDisk();
  return _registry;
}

export function getSubagentRegistry(): SubagentRegistry | null {
  return _registry;
}
