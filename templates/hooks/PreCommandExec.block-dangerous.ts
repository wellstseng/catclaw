/**
 * 範例 Hook：PreCommandExec → 阻擋高風險 shell 指令
 *
 * 示範 blocking hook：回傳 { action: "block", reason: ... } 即中止 run_command。
 */

import { defineHook } from "../../src/hooks/sdk.js";

const DANGEROUS_PATTERNS = [
  /\brm\s+-rf\s+\//,
  /\bmkfs\b/,
  /\bdd\s+if=.+of=\/dev\//,
  /:\(\)\s*\{/, // fork bomb
  /\bcurl\s+.*\|\s*(sh|bash)\b/,
];

export default defineHook(
  {
    event: "PreCommandExec",
    name: "block-dangerous",
    timeoutMs: 1000,
  },
  async (input) => {
    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.test(input.command)) {
        return {
          action: "block",
          reason: `指令符合高風險樣式（${pattern.source}），已阻擋`,
        };
      }
    }
    return { action: "allow" };
  },
);
