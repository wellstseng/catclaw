/**
 * @file tools/builtin/run-command.ts
 * @description run_command — 執行 shell 指令（elevated tier）
 *
 * 安全強化：
 * - stdout/stderr 合計上限 100KB
 * - sanitized env（只繼承 PATH/HOME/LANG/SHELL/TERM）
 * - 執行前經 SafetyGuard 黑名單/白名單檢查（由 before_tool_call hook 負責）
 * - 支援白名單模式（由 SafetyConfig.bash.mode 控制）
 */

import { spawn } from "node:child_process";
import type { Tool } from "../types.js";

const STDOUT_CAP = 100_000; // 100KB
const DEFAULT_TIMEOUT_MS = 30_000;

export const tool: Tool = {
  name: "run_command",
  description: "在 shell 執行指令並取得輸出",
  tier: "elevated",
  parameters: {
    type: "object",
    properties: {
      command:    { type: "string", description: "要執行的 shell 指令" },
      cwd:        { type: "string", description: "工作目錄（省略為預設）" },
      timeoutMs:  { type: "number", description: "逾時毫秒（預設 30000）" },
    },
    required: ["command"],
  },
  async execute(params, _ctx) {
    const command   = String(params["command"] ?? "").trim();
    const cwd       = params["cwd"] ? String(params["cwd"]) : undefined;
    const timeoutMs = typeof params["timeoutMs"] === "number" ? params["timeoutMs"] : DEFAULT_TIMEOUT_MS;

    if (!command) return { error: "command 不能為空" };

    return new Promise<{ result?: unknown; error?: string }>(resolve => {
      // sanitized env：只傳安全的環境變數
      const safeEnv: NodeJS.ProcessEnv = {};
      for (const key of ["PATH", "HOME", "LANG", "SHELL", "TERM", "USER", "LOGNAME"]) {
        if (process.env[key]) safeEnv[key] = process.env[key];
      }

      const proc = spawn("sh", ["-c", command], {
        cwd,
        env: safeEnv,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let output = "";
      let truncated = false;

      const onData = (chunk: Buffer) => {
        if (truncated) return;
        output += chunk.toString();
        if (output.length > STDOUT_CAP) {
          output = output.slice(0, STDOUT_CAP);
          truncated = true;
          proc.kill();
        }
      };

      proc.stdout?.on("data", onData);
      proc.stderr?.on("data", onData);

      const timer = setTimeout(() => {
        proc.kill();
        resolve({ error: `指令逾時（${timeoutMs}ms）：${command}` });
      }, timeoutMs);

      proc.on("close", (code) => {
        clearTimeout(timer);
        const suffix = truncated ? "\n...[輸出超過 100KB，已截斷]" : "";
        resolve({ result: { exitCode: code, output: output + suffix } });
      });

      proc.on("error", (err) => {
        clearTimeout(timer);
        resolve({ error: `執行失敗：${err.message}` });
      });
    });
  },
};
