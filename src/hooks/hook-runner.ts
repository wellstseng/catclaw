/**
 * @file hooks/hook-runner.ts
 * @description Hook 執行器 — spawn shell command，stdin JSON 輸入，stdout JSON 輸出
 *
 * 設計：
 * - Fail-open：timeout / error / 解析失敗 → passthrough（不阻擋 agent loop）
 * - stdin 寫入 JSON payload，payload 大於 64KB 時自動截斷 toolParams
 * - stdout 讀取 JSON，解析為 HookAction
 */

import { spawn } from "node:child_process";
import { log } from "../logger.js";
import type { HookInput, HookAction } from "./types.js";

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_STDIN_BYTES = 64 * 1024; // 64KB pipe buffer 安全上限

/**
 * 執行單一 hook command
 *
 * @param command shell command（透過 sh -c 執行）
 * @param input hook 輸入 payload
 * @param timeoutMs 超時毫秒
 * @returns HookAction（失敗時回傳 passthrough）
 */
export async function runHook(
  command: string,
  input: HookInput,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<HookAction> {
  return new Promise<HookAction>((resolve) => {
    let settled = false;
    const settle = (action: HookAction) => {
      if (settled) return;
      settled = true;
      resolve(action);
    };

    // Timeout
    const timer = setTimeout(() => {
      log.warn(`[hook-runner] hook 超時 (${timeoutMs}ms): ${command.slice(0, 80)}`);
      try { proc.kill("SIGKILL"); } catch { /* ignore */ }
      settle({ action: "passthrough" });
    }, timeoutMs);

    const proc = spawn("sh", ["-c", command], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    // stdin: 寫入 JSON payload
    let payload = JSON.stringify(input);
    if (Buffer.byteLength(payload) > MAX_STDIN_BYTES) {
      // 截斷 toolParams 避免 pipe buffer 溢出
      const truncated = { ...input, toolParams: { _truncated: true } } as HookInput;
      payload = JSON.stringify(truncated);
      log.debug(`[hook-runner] payload 過大，已截斷 toolParams`);
    }
    try {
      proc.stdin.write(payload);
      proc.stdin.end();
    } catch {
      clearTimeout(timer);
      settle({ action: "passthrough" });
      return;
    }

    // stdout: 收集輸出
    let stdout = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    // stderr: 記錄但不阻擋
    let stderr = "";
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      log.warn(`[hook-runner] hook 啟動失敗: ${err.message} (${command.slice(0, 80)})`);
      settle({ action: "passthrough" });
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (stderr.trim()) {
        log.debug(`[hook-runner] hook stderr: ${stderr.trim().slice(0, 200)}`);
      }

      if (code !== 0) {
        log.warn(`[hook-runner] hook 非零退出 code=${code}: ${command.slice(0, 80)}`);
        settle({ action: "passthrough" });
        return;
      }

      const trimmed = stdout.trim();
      if (!trimmed) {
        // 空 stdout → passthrough
        settle({ action: "passthrough" });
        return;
      }

      try {
        const parsed = JSON.parse(trimmed) as HookAction;
        // 驗證 action 欄位
        if (!parsed.action || !["allow", "block", "modify", "passthrough"].includes(parsed.action)) {
          log.warn(`[hook-runner] hook 回傳無效 action: ${JSON.stringify(parsed).slice(0, 100)}`);
          settle({ action: "passthrough" });
          return;
        }
        settle(parsed);
      } catch {
        log.warn(`[hook-runner] hook stdout 非 JSON: ${trimmed.slice(0, 100)}`);
        settle({ action: "passthrough" });
      }
    });
  });
}
