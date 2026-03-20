#!/usr/bin/env node
/**
 * catclaw 跨平台管理腳本
 * 用法：node catclaw.js [start|stop|restart|logs|status]
 *
 * 重啟機制：
 * - start 使用 ecosystem.config.cjs，PM2 監聽 dist/.restart signal file
 * - tsc 編譯不會觸發重啟（只編譯到 dist/，不動 signal file）
 * - 寫入 signal/RESTART 才會觸發 PM2 自動重啟
 */

import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const run = (cmd) => {
  try {
    execSync(cmd, { cwd: __dirname, stdio: "inherit" });
  } catch {
    process.exit(1);
  }
};

/** 檢查 pm2 中 catclaw 是否正在執行 */
function isRunning() {
  try {
    const out = execSync("npx pm2 jlist", { cwd: __dirname, stdio: ["pipe", "pipe", "pipe"] }).toString();
    const list = JSON.parse(out);
    return list.some((p) => p.name === "catclaw" && p.pm2_env?.status === "online");
  } catch {
    return false;
  }
}

/**
 * 寫入 signal file 觸發 PM2 watch 重啟
 * channelId 從環境變數 CATCLAW_CHANNEL_ID 取得（由 acp.ts spawn 時設定）
 * 手動執行時不帶 channelId（無通知）
 *
 * @param channelId 可選，指定要通知的頻道
 */
function triggerRestart(channelId) {
  const signalDir = resolve(__dirname, "signal");
  try { execSync(`mkdir -p "${signalDir}"`, { stdio: "pipe" }); } catch {}
  const signalPath = resolve(signalDir, "RESTART");
  writeFileSync(signalPath, JSON.stringify({
    channelId: channelId ?? process.env.CATCLAW_CHANNEL_ID,
    time: new Date().toISOString(),
  }), "utf-8");
}

const cmd = process.argv[2] ?? "start";

switch (cmd) {
  case "start":
    if (isRunning()) {
      console.log("⚠️ catclaw 已在執行中，使用 restart 重啟或 stop 停止");
      process.exit(0);
    }
    run("npx tsc");
    run(`mkdir -p "${resolve(__dirname, "signal")}"`);
    run("npx pm2 start ecosystem.config.cjs");
    console.log("✅ catclaw 已啟動（背景執行，監聽 signal/RESTART）");
    break;
  case "stop":
    run("npx pm2 stop catclaw");
    console.log("⏹ catclaw 已停止");
    break;
  case "restart":
    run("npx tsc");
    triggerRestart();
    console.log("🔄 catclaw 重啟信號已送出");
    break;
  case "logs":
    run("npx pm2 logs catclaw");
    break;
  case "status":
    run("npx pm2 status");
    break;
  default:
    console.log("用法：node catclaw.js [start|stop|restart|logs|status]");
    process.exit(1);
}
