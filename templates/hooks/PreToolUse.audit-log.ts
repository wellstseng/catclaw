/**
 * 範例 Hook：PreToolUse → 記錄所有工具呼叫至檔案
 *
 * 使用方式：
 *   1. 複製到 ~/.catclaw/workspace/hooks/ 或 agents/{id}/hooks/
 *   2. fs.watch 會在幾百毫秒內自動 reload
 *
 * 檔名格式：{event}.{name}.ts → PreToolUse.audit-log.ts
 */

import { defineHook } from "../../src/hooks/sdk.js";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export default defineHook(
  {
    event: "PreToolUse",
    name: "audit-log",
    timeoutMs: 2000,
    // toolFilter: ["write_file", "run_command"], // 只監聽特定工具（選填）
  },
  async (input) => {
    const logPath = join(homedir(), ".catclaw", "runtime", "hook-audit.log");
    try {
      mkdirSync(dirname(logPath), { recursive: true });
      const line = JSON.stringify({
        ts: new Date().toISOString(),
        agentId: input.agentId,
        tool: input.toolName,
        tier: input.toolTier,
        sessionKey: input.sessionKey,
      });
      appendFileSync(logPath, line + "\n");
    } catch { /* fail-open */ }

    return { action: "allow" };
  },
);
