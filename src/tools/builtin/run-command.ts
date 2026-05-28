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
import iconv from "iconv-lite";
import { log } from "../../logger.js";
import type { Tool } from "../types.js";

const STDOUT_CAP = 100_000; // 100KB
const DEFAULT_TIMEOUT_MS = 300_000; // 5 分鐘硬上限（LLM 未傳 timeoutMs 時的預設）
const SIGKILL_GRACE_MS = 2_000;  // SIGTERM 後等 2 秒再 SIGKILL

// ── Windows stdout decoding ─────────────────────────────────────────────────

const REPLACEMENT_CHAR = "�";
// 雙門檻防誤觸：U+FFFD 絕對 count ≥ MIN_COUNT 且占比 ≥ THRESHOLD 才視為亂碼
// 短 buffer 偶有 1-2 個 FFFD（如二進位輸出邊界）不該誤觸 fallback
const MOJIBAKE_THRESHOLD = 0.03;
const MOJIBAKE_MIN_COUNT = 3;

/**
 * 在 Windows 環境下，cmd.exe / find.exe / dir.exe 等 native 工具印錯誤訊息
 * 用 OEM/ACP code page（zh-TW 是 CP950），即使 chcp 65001 切過 console，
 * pipe-mode stdio 仍可能走 ACP。
 *
 * 策略：
 *   1. 先試 UTF-8 decode
 *   2. 若 U+FFFD 比例過高 → 視為亂碼，fallback CP950 (zh-TW) / CP936 (zh-CN) 重 decode
 *   3. 環境變數 `CATCLAW_FORCE_DECODE=<encoding>` 可強制指定（debug 用）
 */
function decodeWindowsStdout(buf: Buffer): string {
  const forced = process.env["CATCLAW_FORCE_DECODE"];
  if (forced && iconv.encodingExists(forced)) {
    return iconv.decode(buf, forced);
  }

  const utf8 = buf.toString("utf8");
  // 計算 U+FFFD 比例
  let replacementCount = 0;
  for (let i = 0; i < utf8.length; i++) {
    if (utf8[i] === REPLACEMENT_CHAR) replacementCount++;
  }
  const ratio = utf8.length > 0 ? replacementCount / utf8.length : 0;
  // 雙門檻：絕對 count 與比例都過才 fallback
  if (replacementCount < MOJIBAKE_MIN_COUNT || ratio < MOJIBAKE_THRESHOLD) return utf8;

  // mojibake 偵測：UTF-8 decode 大量失敗，嘗試 CP950（zh-TW 預設）
  try {
    return iconv.decode(buf, "cp950");
  } catch {
    return utf8; // CP950 decode 也失敗 → 回傳原 UTF-8（可能含 U+FFFD，但比錯誤好）
  }
}

// ── Git Safety Protocol ─────────────────────────────────────────────────────

/**
 * 檢查 git 命令安全性，回傳錯誤訊息（null = 安全）。
 *
 * 規則：
 * 1. 禁止 --force / -f push（特別是 main/master）
 * 2. 禁止 --no-verify（跳過 hooks）
 * 3. 禁止 git reset --hard（除非使用者明確要求，由 exec-approval 處理）
 * 4. 禁止 git push --force 到 main/master
 * 5. 禁止 git checkout/restore . （丟棄所有變更）
 * 6. 禁止 git clean -f（刪除 untracked 檔案）
 * 7. 禁止 git branch -D（強制刪除分支）
 */
function checkGitSafety(command: string): string | null {
  // 正規化：去掉多餘空白
  const cmd = command.replace(/\s+/g, " ").trim();

  // 只檢查 git 命令
  if (!cmd.match(/\bgit\b/)) return null;

  // --no-verify：跳過 pre-commit hooks
  if (cmd.includes("--no-verify")) {
    return "Git Safety: --no-verify 被禁止。不要跳過 pre-commit hooks。如果 hook 失敗，請修正根本原因。";
  }

  // --no-gpg-sign / -c commit.gpgsign=false
  if (cmd.includes("--no-gpg-sign") || cmd.includes("commit.gpgsign=false")) {
    return "Git Safety: 禁止跳過 GPG 簽署。";
  }

  // git push --force / -f（特別保護 main/master）
  if (cmd.match(/\bgit\s+push\b/) && (cmd.includes("--force") || cmd.match(/\s-[a-zA-Z]*f/))) {
    if (cmd.includes("main") || cmd.includes("master")) {
      return "Git Safety: 禁止 force push 到 main/master。這會覆寫遠端歷史記錄。";
    }
    return "Git Safety: force push 有風險，可能覆寫遠端分支。請確認這是你要的操作。改用 --force-with-lease 更安全。";
  }

  // git reset --hard
  if (cmd.match(/\bgit\s+reset\b/) && cmd.includes("--hard")) {
    return "Git Safety: git reset --hard 會丟棄所有未提交的變更，無法復原。請確認是否有更安全的替代方案。";
  }

  // git checkout . / git checkout -- . / git restore .（丟棄所有變更）
  if (cmd.match(/\bgit\s+(checkout|restore)\s+(--\s+)?\.(\s|$)/)) {
    return "Git Safety: 這會丟棄工作目錄中所有未提交的修改。請改用指定檔案路徑的方式。";
  }

  // git clean -f（刪除 untracked 檔案）
  if (cmd.match(/\bgit\s+clean\b/) && cmd.match(/\s-[a-zA-Z]*f/)) {
    return "Git Safety: git clean -f 會永久刪除未追蹤的檔案。請先用 git clean -n 預覽。";
  }

  // git branch -D（強制刪除分支）
  if (cmd.match(/\bgit\s+branch\b/) && cmd.match(/\s-[a-zA-Z]*D/)) {
    return "Git Safety: git branch -D 會強制刪除分支（即使有未合併的 commit）。改用 -d 較安全。";
  }

  // git rebase -i（互動式，不支援非 TTY 環境）
  if (cmd.match(/\bgit\s+rebase\b/) && cmd.match(/\s-[a-zA-Z]*i/)) {
    return "Git Safety: git rebase -i 需要互動式終端，在此環境不支援。";
  }

  // git add -i（互動式）
  if (cmd.match(/\bgit\s+add\b/) && cmd.match(/\s-[a-zA-Z]*i/)) {
    return "Git Safety: git add -i 需要互動式終端，在此環境不支援。";
  }

  return null;
}

export const tool: Tool = {
  name: "run_command",
  description: "在 shell 執行指令並取得輸出",
  tier: "elevated",
  resultTokenCap: 3000,
  parameters: {
    type: "object",
    properties: {
      command:    { type: "string", description: "要執行的 shell 指令" },
      cwd:        { type: "string", description: "工作目錄（省略為預設）" },
      timeoutMs:  { type: "number", description: "逾時毫秒（預設 0 = 無限制）" },
    },
    required: ["command"],
  },
  async execute(params, ctx) {
    const command   = String(params["command"] ?? "").trim();
    // cwd 解析優先序：params.cwd（agent 顯式指定）> ctx.projectCwd（bound project）> spawn 預設（catclaw 啟動目錄）
    const cwd       = params["cwd"] ? String(params["cwd"]) : (ctx.projectCwd ?? undefined);
    const timeoutMs = typeof params["timeoutMs"] === "number" ? params["timeoutMs"] : DEFAULT_TIMEOUT_MS;

    if (!command) return { error: "command 不能為空" };

    // Git Safety Protocol
    const gitSafetyError = checkGitSafety(command);
    if (gitSafetyError) {
      log.warn(`[run-command] git-safety blocked: ${command.slice(0, 80)} → ${gitSafetyError}`);
      return { error: gitSafetyError };
    }

    // PreCommandExec hook（可 block）
    try {
      const { getHookRegistry } = await import("../../hooks/hook-registry.js");
      const hookReg = getHookRegistry();
      if (hookReg && hookReg.count("PreCommandExec", ctx.agentId) > 0) {
        const pre = await hookReg.runPreCommandExec({
          event: "PreCommandExec",
          command,
          cwd,
          agentId: ctx.agentId,
          accountId: ctx.accountId,
        });
        if (pre.blocked) return { error: `PreCommandExec hook 阻擋：${pre.reason ?? ""}` };
      }
    } catch { /* hook 系統不可用，靜默通過 */ }

    return new Promise<{ result?: unknown; error?: string }>(resolve => {
      // sanitized env：只傳安全的環境變數
      const safeEnv: NodeJS.ProcessEnv = {};
      for (const key of ["PATH", "HOME", "LANG", "SHELL", "TERM", "USER", "LOGNAME"]) {
        if (process.env[key]) safeEnv[key] = process.env[key];
      }

      // Windows 額外繼承 SYSTEMROOT / COMSPEC / PATHEXT，否則 cmd.exe 找不到自己
      if (process.platform === "win32") {
        for (const key of ["SYSTEMROOT", "COMSPEC", "PATHEXT", "TEMP", "TMP", "APPDATA", "USERPROFILE"]) {
          if (process.env[key]) safeEnv[key] = process.env[key];
        }
      }

      // Windows 平台：spawn 前綴 `chcp 65001>nul & ` 強制 cmd.exe 用 UTF-8 codepage
      // 預設 CP950（zh-TW）→ stdout 含中文字會被 Node default utf8 decode 弄成亂碼
      // chcp 65001 改 UTF-8 後 cmd 輸出 UTF-8 bytes，跟 Node toString() 對齊
      // `>nul` 吞掉 "Active code page: 65001" 提示；`&` 不檢查 exit code，chcp 失敗也繼續
      const finalCommand = process.platform === "win32"
        ? `chcp 65001>nul & ${command}`
        : command;
      const proc = spawn(finalCommand, [], {
        cwd,
        env: safeEnv,
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });

      // V5: Windows 下累積 Buffer 再整體 decode（支援 CP950 fallback）；
      //     其他平台保持原本逐 chunk toString（行為不變）
      const isWin = process.platform === "win32";
      const bufChunks: Buffer[] = [];
      let bufBytes = 0;
      let output = "";
      let truncated = false;

      const onData = (chunk: Buffer) => {
        if (truncated) return;
        if (isWin) {
          bufChunks.push(chunk);
          bufBytes += chunk.length;
          if (bufBytes > STDOUT_CAP) {
            truncated = true;
            proc.kill();
          }
        } else {
          output += chunk.toString();
          if (output.length > STDOUT_CAP) {
            output = output.slice(0, STDOUT_CAP);
            truncated = true;
            proc.kill();
          }
        }
      };

      proc.stdout?.on("data", onData);
      proc.stderr?.on("data", onData);

      let killEscalationTimer: ReturnType<typeof setTimeout> | undefined;
      const timer = timeoutMs > 0
        ? setTimeout(() => {
            // 先送 SIGTERM 給 shell，讓它有機會清理 child
            try { proc.kill("SIGTERM"); } catch { /* 已死亡 */ }
            // 2 秒後若仍未退出，強制 SIGKILL
            killEscalationTimer = setTimeout(() => {
              try { proc.kill("SIGKILL"); } catch { /* 已死亡 */ }
            }, SIGKILL_GRACE_MS);
            resolve({ error: `指令逾時（${timeoutMs}ms 已強制終結）：${command.slice(0, 120)}` });
          }, timeoutMs)
        : null;

      proc.on("close", (code) => {
        if (timer) clearTimeout(timer);
        if (killEscalationTimer) clearTimeout(killEscalationTimer);
        // Windows: 整體 buffer 過 decodeWindowsStdout（UTF-8 → CP950 fallback）
        if (isWin) {
          let buf = Buffer.concat(bufChunks, bufBytes);
          if (buf.length > STDOUT_CAP) buf = buf.subarray(0, STDOUT_CAP);
          output = decodeWindowsStdout(buf);
        }
        const suffix = truncated ? "\n...[輸出超過 100KB，已截斷]" : "";
        resolve({ result: { exitCode: code, output: output + suffix } });
      });

      proc.on("error", (err) => {
        if (timer) clearTimeout(timer);
        if (killEscalationTimer) clearTimeout(killEscalationTimer);
        resolve({ error: `執行失敗：${err.message}` });
      });
    });
  },
};
