/**
 * postinstall：下載 Playwright 用的 Chromium。下載不了只警告、一律 exit 0，
 * 不讓 pnpm install（以及內含它的 catclaw build / restart）失敗或卡住。
 *
 * 流程：
 *   1. PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 → 跳過
 *      （playwright 只在 npm 安裝自身時認這個變數，`playwright install` 指令不認，所以這裡自己判斷）
 *   2. `playwright install --dry-run chromium` 列出要裝的項目（Chromium、headless shell、ffmpeg）與下載網址；全部裝好 → 跳過
 *   3. 沒設 proxy 時，同時試抓每個項目的真實下載網址（跟著轉址走）：
 *      10 秒內沒收到資料、或照測到的速度整組要超過 3 分鐘 → 跳過
 *      （只測下載站 443 埠不夠：cdn.playwright.dev 會轉址到 storage.googleapis.com，
 *        公司網路擋後者時 playwright 會卡在連線階段，它自己的逾時不會生效）
 *   4. 真正下載限時 5 分鐘，超時中止並清掉暫存 zip
 *   5. 任何失敗只警告 + 補救方式
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { once } from "node:events";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const PLAYWRIGHT_CLI = path.join(path.dirname(require.resolve("playwright/package.json")), "cli.js");

const FIRST_BYTE_TIMEOUT_MS = 10_000; // 試抓：每個網址多久內要收到第一筆資料（含 DNS、連線、轉址）
const SPEED_SAMPLE_MS = 3_000; // 試抓：收到資料後量多久的速度
const MAX_ESTIMATE_MS = 180_000; // 照試抓速度推算整組下載時間，超過就不下載
const INSTALL_DEADLINE_MS = 300_000; // playwright install 整體時限（含解壓縮）
const KILL_GRACE_MS = 5_000; // 超時先 SIGTERM（讓 playwright 釋放安裝鎖），再等這麼久補 SIGKILL
const MAX_REDIRECTS = 5;

// playwright 判斷要不要走 proxy 看的變數（proxy-from-env 的順序）；有設就無法直連試抓
const PROXY_VARS = ["npm_config_https_proxy", "https_proxy", "HTTPS_PROXY", "npm_config_proxy", "all_proxy", "ALL_PROXY"];
// playwright 解壓完才寫的完成標記，跟它自己判斷「已安裝」用的是同一個檔
const INSTALL_MARKER = "INSTALLATION_COMPLETE";

const env = process.env;
const truthy = (v) => !!v && !["0", "false", ""].includes(v.toLowerCase());
const mb = (bytes) => `${Math.round(bytes / 1024 / 1024)} MB`;
const speed = (bytesPerSec) =>
  bytesPerSec < 1024 * 1024 ? `${Math.round(bytesPerSec / 1024)} KB/s` : `${(bytesPerSec / 1024 / 1024).toFixed(1)} MB/s`;
const minutes = (ms) => `${Math.ceil(ms / 60_000)} 分鐘`;

function warn(reason) {
  console.warn(`[playwright-mcp] ⚠ 跳過 Chromium 下載：${reason}`);
  console.warn("[playwright-mcp]   catclaw 照常可用；只有 playwright MCP 開瀏覽器時會找不到執行檔。要補裝擇一（手動裝沒有時限）：");
  console.warn("[playwright-mcp]   - 公司有 proxy：export HTTPS_PROXY=http://<proxy>:<port> 後在 mcp/playwright 跑 npx playwright install chromium");
  console.warn("[playwright-mcp]   - 公司有內部鏡像：export PLAYWRIGHT_DOWNLOAD_HOST=<鏡像網址> 後同上");
  console.warn("[playwright-mcp]   - 用不到 playwright MCP：export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1，之後安裝直接略過不再試抓");
}

/** 解析 `playwright install --dry-run chromium`：每個項目的安裝位置與下載網址（ffmpeg 會列兩次，以安裝位置去重） */
function listInstallItems() {
  const result = spawnSync(process.execPath, [PLAYWRIGHT_CLI, "install", "--dry-run", "chromium"], {
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.status !== 0) throw new Error(`playwright install --dry-run 失敗（exit ${result.status ?? result.error?.message}）`);

  const items = new Map();
  let title = "";
  let current = null;
  for (const line of result.stdout.split(/\r?\n/)) {
    if (line.trim() && !/^\s/.test(line)) {
      title = line.trim(); // 不縮排的行是項目標題，例：Chrome for Testing 147.0.7727.15 (playwright chromium v1217)
      current = null;
      continue;
    }
    const location = line.match(/^\s+Install location:\s+(.+?)\s*$/);
    if (location) {
      current = items.get(location[1]) ?? { title, dir: location[1], urls: [] };
      items.set(current.dir, current);
      continue;
    }
    const url = line.match(/^\s+Download (?:url|fallback \d+):\s+(\S+)/);
    if (url && current && !current.urls.includes(url[1])) current.urls.push(url[1]);
  }
  return [...items.values()];
}

/** 試抓一個網址：自己一站站跟轉址（失敗時才報得出卡在哪一站），回 { bytesPerSec, totalBytes } */
async function sampleDownload(startUrl) {
  let url = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const result = await sampleHop(url);
    if (!result.redirectTo) return result;
    url = result.redirectTo;
  }
  throw new Error(`轉址超過 ${MAX_REDIRECTS} 次（${new URL(url).host}）`);
}

/** 試抓單一站：轉址回 { redirectTo }；200 回量到的速度；其他情況 throw 白話原因 */
async function sampleHop(url) {
  const host = new URL(url).host;
  const controller = new AbortController();
  const firstByteTimer = setTimeout(() => controller.abort("first-byte"), FIRST_BYTE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { redirect: "manual", signal: controller.signal });
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) return { redirectTo: new URL(location, url).href };
    if (res.status !== 200) throw new Error(`${host} 回應 HTTP ${res.status}`);
    return await measureSpeed(res, controller, firstByteTimer);
  } catch (err) {
    throw new Error(explainFetchError(err, controller.signal, host));
  } finally {
    clearTimeout(firstByteTimer);
    controller.abort("done"); // 斷線，不收剩下的檔案
  }
}

/** 讀回應量速度：第一筆資料仍受 firstByteTimer 管，收到後再讀 SPEED_SAMPLE_MS 就主動中斷 */
async function measureSpeed(res, controller, firstByteTimer) {
  const totalBytes = Number(res.headers.get("content-length")) || 0;
  const chunks = res.body[Symbol.asyncIterator]();
  const first = await chunks.next();
  clearTimeout(firstByteTimer);
  if (first.done) throw new Error(`${new URL(res.url).host} 回應 200 但沒有內容`);

  const firstByteAt = Date.now();
  let bytes = first.value.length;
  const sampleTimer = setTimeout(() => controller.abort("sampled"), SPEED_SAMPLE_MS);
  try {
    for await (const chunk of chunks) bytes += chunk.length;
  } catch (err) {
    if (controller.signal.reason !== "sampled") throw err; // 量滿時間主動中斷是正常結束
  } finally {
    clearTimeout(sampleTimer);
  }
  return { bytesPerSec: (bytes * 1000) / Math.max(Date.now() - firstByteAt, 1), totalBytes };
}

/** fetch／讀取失敗轉成白話：哪一站、卡在哪 */
function explainFetchError(err, signal, host) {
  if (signal.reason === "first-byte") return `${FIRST_BYTE_TIMEOUT_MS / 1000} 秒內沒收到資料（${host}）`;
  if (err instanceof TypeError && err.cause) return `${host} 連線失敗（${err.cause.code ?? err.cause.message}）`;
  return err?.message ?? String(err);
}

/** 依序試一個項目的下載網址（主站 + 備援），第一個抓得到的就算數 */
async function sampleItem(item) {
  const reasons = [];
  for (const url of item.urls) {
    try {
      return await sampleDownload(url);
    } catch (err) {
      reasons.push(err.message);
    }
  }
  throw new Error(`${item.title}：${reasons.join("；") || "dry-run 沒列出下載網址"}`);
}

/** 超時中止後 playwright 的暫存資料夾（os.tmpdir()/playwright-download-*）不會自己清；只刪這次開始後建立的 */
function removeTempDownloads(since) {
  const tmp = os.tmpdir();
  for (const name of readdirSync(tmp)) {
    if (!name.startsWith("playwright-download-")) continue;
    const dir = path.join(tmp, name);
    if (statSync(dir).mtimeMs < since) continue;
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 先 SIGTERM（讓 playwright 釋放安裝鎖），KILL_GRACE_MS 後還在就 SIGKILL */
function stopChild(child) {
  child.kill("SIGTERM");
  setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS).unref();
}

/** 跑 playwright install chromium，限時 INSTALL_DEADLINE_MS；成功回 null，失敗回原因 */
async function installWithDeadline() {
  const startedAt = Date.now();
  const child = spawn(process.execPath, [PLAYWRIGHT_CLI, "install", "chromium"], { stdio: "inherit" });
  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    stopChild(child);
  }, INSTALL_DEADLINE_MS);

  let code, signal;
  try {
    [code, signal] = await once(child, "exit");
  } catch (err) {
    return `無法執行 playwright install（${err.message}）`;
  } finally {
    clearTimeout(deadline);
  }
  if (!timedOut) return code === 0 ? null : `playwright install 失敗（exit ${code ?? signal}）`;

  try {
    removeTempDownloads(startedAt);
  } catch (err) {
    console.warn(`[playwright-mcp] ⚠ 暫存下載檔清不掉，請手動刪 ${os.tmpdir()}/playwright-download-*（${err.message}）`);
  }
  return `下載超過 ${minutes(INSTALL_DEADLINE_MS)}仍未完成，已中止`;
}

async function main() {
  if (truthy(env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD)) {
    console.log("[playwright-mcp] PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD 已設，跳過 Chromium 下載");
    return;
  }

  const items = listInstallItems();
  if (!items.length) return warn("playwright install --dry-run 沒列出任何項目，無法判斷要下載什麼");
  const missing = items.filter((item) => !existsSync(path.join(item.dir, INSTALL_MARKER)));
  if (!missing.length) {
    console.log("[playwright-mcp] Chromium 已安裝，跳過下載");
    return;
  }

  const proxyVar = PROXY_VARS.find((name) => env[name]);
  if (proxyVar) {
    console.log(`[playwright-mcp] 偵測到 ${proxyVar}，不試抓直接下載（限時 ${minutes(INSTALL_DEADLINE_MS)}）`);
  } else {
    let samples;
    try {
      samples = await Promise.all(missing.map(sampleItem));
    } catch (err) {
      return warn(`試抓下載網址失敗，網路可能被擋——${err.message}`);
    }
    // 各項目同時試抓、共用頻寬，所以整組時間 ≈ 總大小 ÷ 總速度
    const totalBytes = samples.reduce((sum, s) => sum + s.totalBytes, 0);
    const bytesPerSec = samples.reduce((sum, s) => sum + s.bytesPerSec, 0);
    const estimateMs = (totalBytes / bytesPerSec) * 1000;
    if (estimateMs > MAX_ESTIMATE_MS) {
      return warn(`下載速度約 ${speed(bytesPerSec)}，共 ${mb(totalBytes)} 預估要 ${minutes(estimateMs)}，超過 ${minutes(MAX_ESTIMATE_MS)}上限`);
    }
    console.log(`[playwright-mcp] 下載 ${mb(totalBytes)}，速度約 ${speed(bytesPerSec)}（限時 ${minutes(INSTALL_DEADLINE_MS)}）`);
  }

  const failure = await installWithDeadline();
  if (failure) warn(failure);
}

main().catch((err) => warn(err?.message ?? String(err)));
