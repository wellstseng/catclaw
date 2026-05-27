/**
 * @file skills/builtin/build.ts
 * @description 建置 catclaw skill — pnpm build 編譯 TypeScript
 *
 * 觸發：「建置」「建置catclaw」「build」「pnpm build」「編譯」
 * 在 catclaw 專案根目錄執行 `pnpm build`
 * tier：admin
 */

import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Skill } from "../types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function runPnpmBuild(cwd: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise(res => {
    const isWin = process.platform === "win32";
    const cmd = isWin ? "cmd.exe" : "bash";
    const args = isWin ? ["/c", "pnpm build"] : ["-c", "pnpm build"];
    const proc = spawn(cmd, args, { cwd, env: process.env });
    let stdout = "", stderr = "";
    proc.stdout.on("data", d => { stdout += d.toString(); });
    proc.stderr.on("data", d => { stderr += d.toString(); });
    proc.on("error", err => { stderr += err.message; res({ stdout, stderr, code: -1 }); });
    proc.on("close", code => { res({ stdout, stderr, code: code ?? -1 }); });
  });
}

export const skill: Skill = {
  name: "build",
  description: "在 catclaw 專案根目錄執行 pnpm build 編譯 TypeScript（不更新、不重啟）",
  tier: "admin",
  trigger: ["建置", "建置catclaw", "建置 catclaw", "build", "pnpm build", "編譯"],

  async execute() {
    const projectRoot = resolve(__dirname, "..", "..", "..");
    const result = await runPnpmBuild(projectRoot);
    const stdoutTail = (result.stdout || "").split("\n").slice(-15).join("\n");
    const stderrTail = (result.stderr || "").split("\n").slice(-10).join("\n");
    const text = [
      result.code === 0 ? "✅ pnpm build 完成" : `❌ pnpm build 失敗（exit=${result.code}）`,
      "",
      "**stdout（末 15 行）**:",
      "```",
      stdoutTail || "(no output)",
      "```",
      stderrTail.trim() ? "**stderr（末 10 行）**:\n```\n" + stderrTail + "\n```" : "",
      "",
      result.code === 0 ? "下一步：`/restart` 重啟使新版本生效。" : "請修 TypeScript 錯誤後重試。",
    ].filter(Boolean).join("\n");
    return { text };
  },
};
