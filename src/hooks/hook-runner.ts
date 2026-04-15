/**
 * @file hooks/hook-runner.ts
 * @description Hook 執行器 — 依 runtime 分派 spawn
 *
 * Runtime 分派：
 * - .ts → bunx tsx hook-runtime.ts <script>
 * - .js / .mjs / .cjs → node hook-runtime.js <script>
 * - .sh → sh <script>
 * - .ps1 → pwsh -File <script>
 * - .bat → cmd /c <script>
 * - 純字串 command → sh -c <command>（向後相容）
 *
 * 設計：
 * - Fail-open：timeout / error / 解析失敗 → passthrough（不阻擋 agent loop）
 * - stdin 寫入 JSON payload，payload 大於 64KB 時自動截斷 toolParams
 * - stdout 讀取 JSON，解析為 HookAction
 * - CATCLAW_HOOK_DEPTH env 防遞迴（hook 內呼叫 tool 又觸發 hook）
 */

import { spawn, type SpawnOptions } from "node:child_process";
import { extname, resolve as pathResolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "../logger.js";
import type { HookInput, HookAction, HookDefinition } from "./types.js";

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_STDIN_BYTES = 64 * 1024;
const MAX_HOOK_DEPTH = 4;

interface SpawnPlan {
  cmd: string;
  args: string[];
}

/** 依 HookDefinition 決定 spawn 計畫 */
function planSpawn(def: HookDefinition): SpawnPlan | null {
  // 純字串 command → shell（向後相容）
  if (def.command && !def.scriptPath) {
    return { cmd: "sh", args: ["-c", def.command] };
  }

  const scriptPath = def.scriptPath;
  if (!scriptPath) return null;

  const ext = extname(scriptPath).toLowerCase();
  const runtime = def.runtime ?? "auto";

  // hook-runtime.js 用於 TS / JS 統一執行
  const runtimeJs = pathResolve(dirname(fileURLToPath(import.meta.url)), "hook-runtime.js");

  if (runtime === "ts" || (runtime === "auto" && ext === ".ts")) {
    return { cmd: "bunx", args: ["tsx", runtimeJs, scriptPath] };
  }
  if (runtime === "node" || (runtime === "auto" && (ext === ".js" || ext === ".mjs" || ext === ".cjs"))) {
    return { cmd: "node", args: [runtimeJs, scriptPath] };
  }
  if (runtime === "shell" || ext === ".sh") {
    return { cmd: "sh", args: [scriptPath] };
  }
  if (ext === ".ps1") {
    return { cmd: "pwsh", args: ["-NoProfile", "-File", scriptPath] };
  }
  if (ext === ".bat") {
    return { cmd: "cmd", args: ["/c", scriptPath] };
  }
  return null;
}

/**
 * 執行單一 hook
 *
 * @param def Hook 定義（含 scriptPath / command / runtime）
 * @param input hook 輸入 payload
 * @returns HookAction（失敗時回傳 passthrough）
 */
export async function runHook(def: HookDefinition, input: HookInput): Promise<HookAction> {
  const timeoutMs = def.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // 防遞迴
  const depth = Number(process.env.CATCLAW_HOOK_DEPTH ?? "0");
  if (depth >= MAX_HOOK_DEPTH) {
    log.warn(`[hook-runner] hook 遞迴深度超過 ${MAX_HOOK_DEPTH}，強制 passthrough`);
    return { action: "passthrough" };
  }

  const plan = planSpawn(def);
  if (!plan) {
    log.warn(`[hook-runner] 無法決定 spawn 計畫: ${def.name}`);
    return { action: "passthrough" };
  }

  return new Promise<HookAction>((resolve) => {
    let settled = false;
    const settle = (action: HookAction) => {
      if (settled) return;
      settled = true;
      resolve(action);
    };

    const timer = setTimeout(() => {
      log.warn(`[hook-runner] hook 超時 (${timeoutMs}ms): ${def.name}`);
      try { proc.kill("SIGKILL"); } catch { /* ignore */ }
      settle({ action: "passthrough" });
    }, timeoutMs);

    const spawnOpts: SpawnOptions = {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: {
        ...process.env,
        CATCLAW_HOOK_DEPTH: String(depth + 1),
        CATCLAW_HOOK_AGENT_ID: input.agentId ?? "",
        CATCLAW_HOOK_SCOPE: def.scope ?? "global",
      },
    };

    const proc = spawn(plan.cmd, plan.args, spawnOpts);

    // stdin: payload
    let payload = JSON.stringify(input);
    if (Buffer.byteLength(payload) > MAX_STDIN_BYTES) {
      const truncated = { ...input } as Record<string, unknown>;
      if ("toolParams" in truncated) truncated.toolParams = { _truncated: true };
      payload = JSON.stringify(truncated);
      log.debug(`[hook-runner] payload 過大，已截斷`);
    }
    try {
      proc.stdin?.write(payload);
      proc.stdin?.end();
    } catch {
      clearTimeout(timer);
      settle({ action: "passthrough" });
      return;
    }

    let stdout = "";
    proc.stdout?.on("data", (c: Buffer) => { stdout += c.toString(); });

    let stderr = "";
    proc.stderr?.on("data", (c: Buffer) => { stderr += c.toString(); });

    proc.on("error", (err) => {
      clearTimeout(timer);
      log.warn(`[hook-runner] 啟動失敗 ${def.name}: ${err.message}`);
      settle({ action: "passthrough" });
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (stderr.trim()) log.debug(`[hook-runner] ${def.name} stderr: ${stderr.trim().slice(0, 200)}`);
      if (code !== 0) {
        log.warn(`[hook-runner] ${def.name} 非零退出 code=${code}`);
        settle({ action: "passthrough" });
        return;
      }
      const trimmed = stdout.trim();
      if (!trimmed) { settle({ action: "passthrough" }); return; }
      try {
        const parsed = JSON.parse(trimmed) as HookAction;
        if (!parsed.action || !["allow", "block", "modify", "passthrough"].includes(parsed.action)) {
          log.warn(`[hook-runner] ${def.name} 回傳無效 action: ${trimmed.slice(0, 100)}`);
          settle({ action: "passthrough" });
          return;
        }
        settle(parsed);
      } catch {
        log.warn(`[hook-runner] ${def.name} stdout 非 JSON: ${trimmed.slice(0, 100)}`);
        settle({ action: "passthrough" });
      }
    });
  });
}
