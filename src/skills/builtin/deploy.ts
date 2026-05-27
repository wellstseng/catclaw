/**
 * @file skills/builtin/deploy.ts
 * @description 三合一 deploy skill — git pull + pnpm build + restart
 *
 * 觸發：「更新建置重啟」「deploy」「全套更新」「pull build restart」
 * 在 catclaw 專案根目錄依序執行 git pull → pnpm build → restart
 * 任一階段失敗則中止，不繼續往下。
 * tier：admin
 */

import { spawn } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import type { Skill } from "../types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function runShell(cmd: string, cwd: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise(res => {
    const isWin = process.platform === "win32";
    const shell = isWin ? "cmd.exe" : "bash";
    const args = isWin ? ["/c", cmd] : ["-c", cmd];
    const proc = spawn(shell, args, { cwd, env: process.env });
    let stdout = "", stderr = "";
    proc.stdout.on("data", d => { stdout += d.toString(); });
    proc.stderr.on("data", d => { stderr += d.toString(); });
    proc.on("error", err => { stderr += err.message; res({ stdout, stderr, code: -1 }); });
    proc.on("close", code => { res({ stdout, stderr, code: code ?? -1 }); });
  });
}

function writeRestartSignal(channelId: string, projectRoot: string): void {
  const signalDir = join(projectRoot, "signal");
  mkdirSync(signalDir, { recursive: true });
  const signalPath = join(signalDir, "RESTART");
  if (existsSync(signalPath)) rmSync(signalPath);
  writeFileSync(signalPath, JSON.stringify({ channelId, time: new Date().toISOString() }), "utf-8");
}

export const skill: Skill = {
  name: "deploy",
  description: "三合一：git pull + pnpm build + 重啟 catclaw（任一階段失敗則中止）",
  tier: "admin",
  trigger: ["更新建置重啟", "更新並重啟", "deploy", "全套更新", "pull build restart", "更新+build+重啟"],

  async execute(ctx) {
    const projectRoot = resolve(__dirname, "..", "..", "..");
    const lines: string[] = ["🚀 開始三合一 deploy（git pull → pnpm build → restart）", ""];

    // Step 1: git pull
    lines.push("**Step 1: git pull**");
    const pull = await runShell("git pull", projectRoot);
    if (pull.code !== 0) {
      lines.push(`❌ git pull 失敗（exit=${pull.code}）`);
      lines.push("```");
      lines.push((pull.stderr || pull.stdout).slice(0, 600));
      lines.push("```");
      lines.push("中止 deploy，請手動處理（merge conflict / 認證等）。");
      return { text: lines.join("\n") };
    }
    lines.push(`✅ git pull 完成`);
    const pullOut = (pull.stdout || "").trim().split("\n").slice(-3).join(" | ");
    if (pullOut) lines.push(`  ${pullOut.slice(0, 200)}`);
    lines.push("");

    // Step 2: pnpm build
    lines.push("**Step 2: pnpm build**");
    const build = await runShell("pnpm build", projectRoot);
    if (build.code !== 0) {
      lines.push(`❌ pnpm build 失敗（exit=${build.code}）`);
      lines.push("```");
      lines.push((build.stderr || "").split("\n").slice(-8).join("\n").slice(0, 800));
      lines.push("```");
      lines.push("中止 deploy，請修 TypeScript 錯誤後重試。");
      return { text: lines.join("\n") };
    }
    lines.push(`✅ pnpm build 完成`);
    lines.push("");

    // Step 3: restart
    lines.push("**Step 3: restart**");
    writeRestartSignal(ctx.channelId, projectRoot);
    setTimeout(() => { process.kill(process.pid, "SIGTERM"); }, 1500);
    lines.push("🔄 重啟中，幾秒後重新上線（含 git pull + build 變更）。");

    return { text: lines.join("\n") };
  },
};
