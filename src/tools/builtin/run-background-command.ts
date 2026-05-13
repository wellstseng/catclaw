/**
 * @file tools/builtin/run-background-command.ts
 * @description run_background_command — 起本地 shell 長期程式並背景追蹤
 *
 * 與 run_command 的差別：
 * - run_command：blocking、佔用 turn timer、stdout 直接回 result
 * - run_background_command：非 blocking、立即回 jobId、process 真背景跑、
 *   stdout 寫檔、由 BackgroundJobRegistry poller 監測 process 與 expectedOutputs
 *
 * 適用場景：≥ 5 分鐘的腳本（ML 訓練、批次翻譯、長 build、影音轉檔），
 * 想分派出去後 wendy 繼續做別的事，完成時自動通知。
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { openSync } from "node:fs";
import { getBackgroundJobRegistry } from "../../core/background-job-registry.js";
import { log } from "../../logger.js";
import type { Tool } from "../types.js";

function jobStdoutDir(): string {
  const dir = join(homedir(), ".catclaw", "workspace", "data", "jobs", "stdout");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export const tool: Tool = {
  name: "run_background_command",
  description: [
    "起本地 shell 長期程式（≥ 5 分鐘）並背景追蹤，立即回傳 jobId。",
    "process 真在背景跑，不佔你的 turn timer。",
    "完成時（process exit 或 expectedOutputs 齊全）會自動經主 stream 通知。",
    "stdout/stderr 寫到絕對路徑檔，需要時用 read_file 取。",
    "適用：長腳本（manga_translator / ML 訓練 / 批次處理 / ffmpeg 等）。",
    "短指令請用 run_command。",
  ].join(" "),
  tier: "elevated",
  resultTokenCap: 500,
  parameters: {
    type: "object",
    properties: {
      command:          { type: "string", description: "Shell 指令（用 bash -c 跑，可含 pipe/heredoc/cd）" },
      label:            { type: "string", description: "短標籤（如 'manga-ch56-translate'），通知與 list 顯示用" },
      cwd:              { type: "string", description: "工作目錄（省略 = catclaw 預設 cwd）" },
      expectedOutputs:  { type: "array",  items: { type: "string" }, description: "預期完成時必出現的絕對路徑檔案清單。任一缺失視為未完成。可省略。" },
      pollIntervalMs:   { type: "number", description: "Poller 檢查間隔毫秒，預設 30000" },
      maxDurationMs:    { type: "number", description: "最長允許執行毫秒，超過自動 SIGTERM。預設 0（不限）" },
    },
    required: ["command", "label"],
  },
  async execute(params, ctx) {
    const command = String(params["command"] ?? "");
    const label = String(params["label"] ?? "");
    if (!command || !label) return { error: "command 與 label 為必填" };

    const cwd = params["cwd"] ? String(params["cwd"]) : undefined;
    const expectedOutputs = Array.isArray(params["expectedOutputs"])
      ? (params["expectedOutputs"] as unknown[]).map(String)
      : undefined;
    const pollIntervalMs = typeof params["pollIntervalMs"] === "number" ? params["pollIntervalMs"] : undefined;
    const maxDurationMs = typeof params["maxDurationMs"] === "number" ? params["maxDurationMs"] : undefined;

    const registry = getBackgroundJobRegistry();
    if (!registry) return { error: "BackgroundJobRegistry 尚未初始化" };

    // 預先建 stdout 檔案
    const jobIdPreview = Date.now().toString(36);
    const stdoutPath = join(jobStdoutDir(), `${jobIdPreview}-${label.replace(/[^a-zA-Z0-9_-]/g, "_")}.log`);
    let stdoutFd: number;
    try {
      stdoutFd = openSync(stdoutPath, "w");
    } catch (err) {
      return { error: `建立 stdout 檔案失敗：${err instanceof Error ? err.message : String(err)}` };
    }

    // 用 bash -c 跑指令，detached 模式
    let child;
    try {
      child = spawn("bash", ["-c", command], {
        cwd,
        detached: true,
        stdio: ["ignore", stdoutFd, stdoutFd],
        env: { ...process.env },
      });
    } catch (err) {
      return { error: `啟動失敗：${err instanceof Error ? err.message : String(err)}` };
    }

    if (!child.pid) {
      return { error: "process spawn 但沒拿到 pid" };
    }

    // 解除 parent 對 child 的引用，讓 catclaw 重啟 child 仍能繼續
    child.unref();

    const record = registry.create({
      parentSessionKey: ctx.sessionId,
      label,
      command,
      cwd,
      pid: child.pid,
      stdoutPath,
      expectedOutputs,
      pollIntervalMs,
      maxDurationMs,
      discordChannelId: ctx.channelId,
    });

    log.info(`[run-bg-cmd] spawned jobId=${record.jobId} pid=${child.pid} label="${label}" cmd="${command.slice(0, 100)}"`);

    return {
      result: {
        status: "spawned",
        jobId: record.jobId,
        pid: child.pid,
        stdoutPath,
        note: "process 已在背景啟動。catclaw 會 polling 監測，完成時自動通知。不要 end_turn 前必須等——你可以繼續做其他事，完成事件會自動 relay 到你後續 turn 或 Discord。",
      },
    };
  },
};
