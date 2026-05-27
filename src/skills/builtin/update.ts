/**
 * @file skills/builtin/update.ts
 * @description 更新 catclaw skill — git pull 拿最新 code
 *
 * 觸發：「更新」「更新catclaw」「update」「pull」「git pull」
 * 在 catclaw 專案根目錄執行 `git pull`
 * tier：admin
 */

import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Skill } from "../types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function runGitPull(cwd: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise(res => {
    const isWin = process.platform === "win32";
    const cmd = isWin ? "cmd.exe" : "bash";
    const args = isWin ? ["/c", "git pull"] : ["-c", "git pull"];
    const proc = spawn(cmd, args, { cwd, env: process.env });
    let stdout = "", stderr = "";
    proc.stdout.on("data", d => { stdout += d.toString(); });
    proc.stderr.on("data", d => { stderr += d.toString(); });
    proc.on("error", err => { stderr += err.message; res({ stdout, stderr, code: -1 }); });
    proc.on("close", code => { res({ stdout, stderr, code: code ?? -1 }); });
  });
}

export const skill: Skill = {
  name: "update",
  description: "在 catclaw 專案根目錄執行 git pull 拿最新 code（不重啟、不 build）",
  tier: "admin",
  trigger: ["更新", "更新catclaw", "更新 catclaw", "update", "pull", "git pull"],

  async execute() {
    const projectRoot = resolve(__dirname, "..", "..", "..");
    const result = await runGitPull(projectRoot);
    const text = [
      result.code === 0 ? "✅ git pull 完成" : `❌ git pull 失敗（exit=${result.code}）`,
      "",
      "**stdout**:",
      "```",
      (result.stdout || "(no output)").slice(0, 1500),
      "```",
      result.stderr ? "**stderr**:\n```\n" + result.stderr.slice(0, 800) + "\n```" : "",
      "",
      result.code === 0 ? "下一步：`/build` 編譯 → `/restart` 重啟，或直接 `/deploy` 三合一。" : "請手動處理（merge conflict / 認證等），然後 `/build` `/restart`。",
    ].filter(Boolean).join("\n");
    return { text };
  },
};
