#!/usr/bin/env node
/**
 * catclaw 跨平台管理腳本
 * 用法：node catclaw.js [start|stop|restart|logs|status]
 */

import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const run = (cmd) => {
  try {
    execSync(cmd, { cwd: __dirname, stdio: "inherit" });
  } catch {
    process.exit(1);
  }
};

const cmd = process.argv[2] ?? "start";

switch (cmd) {
  case "start":
    run("npx tsc");
    run("npx pm2 start dist/index.js --name catclaw");
    console.log("✅ catclaw 已啟動（背景執行）");
    break;
  case "stop":
    run("npx pm2 stop catclaw");
    console.log("⏹ catclaw 已停止");
    break;
  case "restart":
    run("npx tsc");
    run("npx pm2 restart catclaw");
    console.log("🔄 catclaw 已重啟");
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
