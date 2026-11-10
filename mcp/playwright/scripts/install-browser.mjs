/**
 * postinstall：下載 Playwright 用的 Chromium。下載不了只警告、一律 exit 0，
 * 不讓 pnpm install（以及內含它的 catclaw build / restart）失敗。
 *
 * 流程：
 *   1. PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 → 跳過
 *      （playwright 只在 npm 安裝自身時認這個變數，`playwright install` 指令不認，所以這裡自己判斷）
 *   2. 已裝過 → 跳過
 *   3. 有設 HTTPS_PROXY / PLAYWRIGHT_DOWNLOAD_HOST → 直接交給 playwright 下載
 *      否則先探測官方下載站 443 埠，5 秒連不上就跳過（公司網路擋站時不用等十幾分鐘逾時）
 *   4. 下載失敗 → 警告 + 補救方式
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import { chromium } from "playwright";

const DOWNLOAD_HOSTS = ["cdn.playwright.dev", "playwright.download.prss.microsoft.com"];
const PROBE_TIMEOUT_MS = 5000;

const env = process.env;
const truthy = (v) => !!v && !["0", "false", ""].includes(v.toLowerCase());

function warn(reason) {
  console.warn(`[playwright-mcp] ⚠ 跳過 Chromium 下載：${reason}`);
  console.warn("[playwright-mcp]   catclaw 照常可用；只有 playwright MCP 開瀏覽器時會找不到執行檔。要補裝擇一：");
  console.warn("[playwright-mcp]   - 公司有 proxy：export HTTPS_PROXY=http://<proxy>:<port> 後在 mcp/playwright 跑 npx playwright install chromium");
  console.warn("[playwright-mcp]   - 公司有內部鏡像：export PLAYWRIGHT_DOWNLOAD_HOST=<鏡像網址> 後同上");
  console.warn("[playwright-mcp]   - 用不到 playwright MCP：export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1，之後安裝直接略過不再探測");
}

function canReach(host) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port: 443, timeout: PROBE_TIMEOUT_MS });
    const done = (ok) => { socket.destroy(); resolve(ok); };
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

async function main() {
  if (truthy(env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD)) {
    console.log("[playwright-mcp] PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD 已設，跳過 Chromium 下載");
    return;
  }

  if (existsSync(chromium.executablePath())) {
    console.log("[playwright-mcp] Chromium 已安裝，跳過下載");
    return;
  }

  const customRoute = env.HTTPS_PROXY || env.https_proxy || env.PLAYWRIGHT_DOWNLOAD_HOST;
  if (!customRoute) {
    const reachable = await Promise.all(DOWNLOAD_HOSTS.map(canReach));
    if (!reachable.some(Boolean)) {
      warn(`${PROBE_TIMEOUT_MS / 1000} 秒內連不到下載站（${DOWNLOAD_HOSTS.join("、")}），網路可能被擋`);
      return;
    }
  }

  const result = spawnSync("npx", ["playwright", "install", "chromium"], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) warn(`playwright install 失敗（exit ${result.status ?? result.error?.message}）`);
}

main().catch((err) => warn(err?.message ?? String(err)));
