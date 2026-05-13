/**
 * @file tools/builtin/background-jobs.ts
 * @description background_jobs — 管理本地 shell 長期 job（list / status / kill / wait）
 *
 * 對應 run_background_command 啟動的 BackgroundJobRegistry 記錄。LLM 用此工具
 * 中間查狀態、強制終止、或等待完成。
 */

import { existsSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { getBackgroundJobRegistry, type BackgroundJobRecord } from "../../core/background-job-registry.js";
import type { Tool } from "../types.js";

function formatJob(r: BackgroundJobRecord): string {
  const dur = r.endedAt
    ? `${Math.round((r.endedAt - r.startedAt) / 1000)}s`
    : `${Math.round((Date.now() - r.startedAt) / 1000)}s+`;
  const exit = r.exitCode != null ? ` exitCode=${r.exitCode}` : "";
  return `• [${r.status}] ${r.label} | ${dur}${exit} | jobId:${r.jobId}`;
}

function tailFile(path: string, lines = 50): string {
  try {
    if (!existsSync(path)) return "(stdout 檔不存在)";
    const stat = statSync(path);
    const maxBytes = 32_000;
    const buf = Buffer.alloc(Math.min(maxBytes, stat.size));
    const fd = openSync(path, "r");
    try {
      readSync(fd, buf, 0, buf.length, Math.max(0, stat.size - maxBytes));
    } finally {
      closeSync(fd);
    }
    const all = buf.toString("utf-8").split("\n");
    return all.slice(-lines).join("\n");
  } catch (err) {
    return `(讀取失敗：${err instanceof Error ? err.message : String(err)})`;
  }
}

export const tool: Tool = {
  name: "background_jobs",
  description: "管理本地 shell 背景 job（由 run_background_command 啟動）：list / status / kill / wait。中段檢查 job 狀態、看 stdout 尾段、強制終止。",
  tier: "standard",
  deferred: false,
  resultTokenCap: 1500,
  parameters: {
    type: "object",
    properties: {
      action:        { type: "string", description: "list | status | kill | wait" },
      jobId:         { type: "string", description: "目標 jobId（status/kill/wait 用）" },
      stdoutLines:   { type: "number", description: "status 時回傳 stdout 尾 N 行（預設 50）" },
      timeoutMs:     { type: "number", description: "wait 最長毫秒（預設 60000）" },
    },
    required: ["action"],
  },
  async execute(params, ctx) {
    const registry = getBackgroundJobRegistry();
    if (!registry) return { error: "BackgroundJobRegistry 尚未初始化" };

    const action = String(params["action"] ?? "").trim();
    const jobId = params["jobId"] ? String(params["jobId"]) : undefined;

    switch (action) {
      case "list": {
        const records = registry.listByParent(ctx.sessionId);
        if (records.length === 0) return { result: "（本 session 無 background job 紀錄）" };
        const sorted = records.sort((a, b) => b.startedAt - a.startedAt).slice(0, 20);
        return { result: sorted.map(formatJob).join("\n") };
      }

      case "status": {
        if (!jobId) return { error: "status 需要指定 jobId" };
        const r = registry.get(jobId);
        if (!r) return { error: `找不到 jobId：${jobId}` };
        const lines = typeof params["stdoutLines"] === "number" ? params["stdoutLines"] : 50;
        const stdoutTail = r.stdoutPath ? tailFile(r.stdoutPath, lines) : "(無 stdoutPath)";
        const expected = r.expectedOutputs?.length
          ? r.expectedOutputs.map(p => `  ${existsSync(p) ? "✓" : "✗"} ${p}`).join("\n")
          : "  (未設定)";
        return {
          result: [
            formatJob(r),
            `command: ${r.command.slice(0, 200)}`,
            `pid: ${r.pid ?? "?"}`,
            `expectedOutputs:\n${expected}`,
            `--- stdout 尾 ${lines} 行 ---`,
            stdoutTail,
          ].join("\n"),
        };
      }

      case "kill": {
        if (!jobId) return { error: "kill 需要指定 jobId" };
        const ok = registry.kill(jobId);
        return { result: ok ? `✅ killed ${jobId}` : `❌ 找不到或已結束：${jobId}` };
      }

      case "wait": {
        if (!jobId) return { error: "wait 需要指定 jobId" };
        const r = registry.get(jobId);
        if (!r) return { error: `找不到 jobId：${jobId}` };
        const timeoutMs = typeof params["timeoutMs"] === "number" ? params["timeoutMs"] : 60_000;
        const start = Date.now();
        // poll 每 1s
        while (Date.now() - start < timeoutMs) {
          const cur = registry.get(jobId);
          if (cur && cur.status !== "running") {
            return { result: `job ${jobId.slice(0, 8)} 結束：status=${cur.status} exitCode=${cur.exitCode ?? "null"} 經過 ${Math.round((Date.now() - start) / 1000)}s` };
          }
          await new Promise(r => setTimeout(r, 1000));
        }
        return { result: `⏱️ wait timeout（${timeoutMs}ms 內 job 仍 running）。可改用 background_jobs action=status 看進度。` };
      }

      default:
        return { error: `未知 action：${action}（支援 list/status/kill/wait）` };
    }
  },
};
