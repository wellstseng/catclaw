/**
 * @file workflow/trajectory-fingerprint.ts
 * @description Trajectory Fingerprint — 失敗 pattern 壓縮 + 比對（項目 12 階段 2 plumbing）
 *
 * 階段 2 plumbing：寫法可立即落地，但「比對 recall 有用」需 ≥100 標註樣本累積。
 *
 * 流程：
 *   1. Trace 的 Guardian hit 被標註 falsePositive=false（即真失敗）
 *      → recordFailureFingerprint(trace, rule)
 *   2. agent-loop 啟動 turn 前 / Guardian 規則觸發前
 *      → matchAgainstFailureDB(currentFingerprint) 找歷史失敗
 *      → 命中 → 主動警告 + 提示解決脈絡
 *
 * 階段 1 已落地（commit 2247d0b / a42ea53 / c713410）：標註基建 + dashboard panel + jsonl 匯出。
 * 階段 3 暫不做：用 fingerprint 集 fine-tune 小模型（外部訓練 pipeline，本專案範圍外）。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { log } from "../logger.js";
import type { MessageTraceEntry } from "../core/message-trace.js";

const FINGERPRINT_TURNS = 5;

export interface TrajectoryFingerprint {
  pattern: {
    /** 最後 N turn 的 tool 名稱序列（依出現順序，含重複） */
    toolSeq: string[];
    /** 最後 user 訊息的 keyword hint（lowercase / ≥3 char / top 5） */
    userTextHints: string[];
    /** 每次 LLM call 的 stopReason 序列 */
    statusSeq: string[];
  };
  /** SHA-256 前 16 hex 字元 */
  hash: string;
}

function getStorePath(): string {
  return join(
    process.env["CATCLAW_HOME"] ?? join(homedir(), ".catclaw"),
    "workspace",
    "data",
    "failure-fingerprints.jsonl",
  );
}

/** 從 trace 計算 trajectory fingerprint。輕量同步操作，O(N turns)。 */
export function computeTrajectoryFingerprint(trace: MessageTraceEntry): TrajectoryFingerprint {
  const llmCalls = trace.llmCalls?.slice(-FINGERPRINT_TURNS) ?? [];
  const toolSeq: string[] = [];
  const statusSeq: string[] = [];
  for (const c of llmCalls) {
    for (const tc of c.toolCalls ?? []) toolSeq.push(tc.name);
    if (c.stopReason) statusSeq.push(c.stopReason);
  }
  const inboundText = trace.inbound?.textPreview ?? "";
  const userTextHints = inboundText
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter(w => w.length >= 3)
    .slice(0, 5);

  const pattern = { toolSeq, userTextHints, statusSeq };
  const hash = createHash("sha256")
    .update(JSON.stringify(pattern))
    .digest("hex")
    .slice(0, 16);
  return { pattern, hash };
}

interface FailureRecord {
  ts: number;
  traceId: string;
  rule: string;
  fingerprint: TrajectoryFingerprint;
}

/** Record 真失敗 fingerprint 到 jsonl（dashboard 標 falsePositive=false 觸發） */
export function recordFailureFingerprint(trace: MessageTraceEntry, rule: string): void {
  try {
    const fp = computeTrajectoryFingerprint(trace);
    const dir = dirname(getStorePath());
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const record: FailureRecord = {
      ts: Date.now(),
      traceId: trace.traceId,
      rule,
      fingerprint: fp,
    };
    appendFileSync(getStorePath(), JSON.stringify(record) + "\n", "utf-8");
    log.debug(
      `[trajectory-fingerprint] record failure ${trace.traceId.slice(0, 8)} rule=${rule} hash=${fp.hash}`,
    );
  } catch (err) {
    log.warn(`[trajectory-fingerprint] record 失敗：${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * 比對當前 fingerprint vs failure DB。
 * 命中策略（任一）：
 *   - hash 完全相同（同 pattern）
 *   - toolSeq 完全相同（不同 user hints 但 tool 順序一致）
 * 樣本不足時 recall 接近 0 — 階段 2「真有用」需 ≥100 標註樣本。
 */
export function matchAgainstFailureDB(current: TrajectoryFingerprint): FailureRecord[] {
  const path = getStorePath();
  if (!existsSync(path)) return [];
  let content: string;
  try {
    content = readFileSync(path, "utf-8");
  } catch {
    return [];
  }
  const matches: FailureRecord[] = [];
  for (const line of content.split("\n").filter(Boolean)) {
    let r: FailureRecord;
    try {
      r = JSON.parse(line) as FailureRecord;
    } catch {
      continue;
    }
    if (r.fingerprint.hash === current.hash) {
      matches.push(r);
      continue;
    }
    const toolSeqMatch =
      r.fingerprint.pattern.toolSeq.length === current.pattern.toolSeq.length &&
      r.fingerprint.pattern.toolSeq.every((t, i) => t === current.pattern.toolSeq[i]);
    if (toolSeqMatch) matches.push(r);
  }
  return matches;
}

/** 給 dashboard / /insights 用：回傳 fingerprint DB 大小（樣本數） */
export function getFailureFingerprintCount(): number {
  const path = getStorePath();
  if (!existsSync(path)) return 0;
  try {
    return readFileSync(path, "utf-8").split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}
