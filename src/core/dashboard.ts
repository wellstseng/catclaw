/**
 * @file core/dashboard.ts
 * @description Token Usage Web Dashboard（minimal, no external deps）
 *
 * 啟動後開一個 HTTP server，提供：
 *   GET /          → 靜態 HTML 儀表板（Chart.js from CDN）
 *   GET /api/usage → JSON：最近 7 天 token 統計 + CE 效果
 *
 * 設定：catclaw.json → dashboard.port（預設 8088）
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, writeFileSync, readdirSync, unlinkSync, renameSync } from "node:fs";
import { dirname, basename, join as pathJoin } from "node:path";
import { log } from "../logger.js";
import { getTurnAuditLog, type TurnAuditEntry } from "./turn-audit-log.js";

// ── Config 備份 ──────────────────────────────────────────────────────────────
const BACKUP_KEEP = 5;

function backupConfig(configPath: string): void {
  const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const backupPath = `${configPath}.bak.${ts}`;
  writeFileSync(backupPath, readFileSync(configPath, "utf-8"), "utf-8");
  const dir = dirname(configPath);
  const base = basename(configPath);
  const old = readdirSync(dir).filter(f => f.startsWith(`${base}.bak.`)).sort().reverse();
  for (const f of old.slice(BACKUP_KEEP)) {
    try { unlinkSync(pathJoin(dir, f)); } catch { /* 忽略 */ }
  }
}

// ── Config 敏感欄位遮罩 ───────────────────────────────────────────────────────
const SENSITIVE_KEYS = new Set(["token", "apiKey", "api_key"]);
function maskConfig(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(maskConfig);
  if (obj && typeof obj === "object") {
    const r: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>))
      r[k] = SENSITIVE_KEYS.has(k) ? "***" : maskConfig(v);
    return r;
  }
  return obj;
}

// ── Dashboard HTML ────────────────────────────────────────────────────────────

const HTML = `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>CatClaw Token Dashboard</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, sans-serif; background: #0f1117; color: #e0e0e0; padding: 20px; }
  h1 { font-size: 1.2rem; margin-bottom: 16px; color: #a78bfa; }
  h2 { font-size: 0.95rem; margin-bottom: 8px; color: #818cf8; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; }
  .card { background: #1e2130; border-radius: 8px; padding: 16px; }
  .stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 16px; }
  .stat { background: #1e2130; border-radius: 8px; padding: 12px; text-align: center; }
  .stat-val { font-size: 1.4rem; font-weight: bold; color: #a78bfa; }
  .stat-lbl { font-size: 0.75rem; color: #888; margin-top: 4px; }
  canvas { max-height: 200px; }
  .table { width: 100%; border-collapse: collapse; font-size: 0.8rem; }
  .table th, .table td { padding: 6px 8px; border-bottom: 1px solid #2a2d3e; text-align: left; }
  .table th { color: #818cf8; }
  .refresh-btn { background: #4c1d95; border: none; color: white; padding: 6px 14px;
    border-radius: 6px; cursor: pointer; font-size: 0.8rem; float: right; }
  .refresh-btn:hover { background: #5b21b6; }
</style>
</head>
<body>
<h1>🐱 CatClaw Token Dashboard <button class="refresh-btn" onclick="load()">↻ 刷新</button></h1>
<div class="stats" id="stats"></div>
<div class="card" id="status-card" style="margin-bottom:16px">
  <h2>Bot 狀態</h2>
  <div id="status-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;margin-top:8px"></div>
</div>
<div class="grid">
  <div class="card">
    <h2>每日 Token 用量</h2>
    <canvas id="tokenChart"></canvas>
  </div>
  <div class="card">
    <h2>CE 壓縮效果</h2>
    <canvas id="ceChart"></canvas>
  </div>
</div>
<div class="card" style="margin-top:16px">
  <h2>最近 Turns</h2>
  <div id="turns"></div>
</div>
<div class="card" style="margin-top:16px">
  <h2>Config 編輯器
    <button class="refresh-btn" onclick="loadCfg()" style="float:none;margin-left:8px">↻ 讀取</button>
    <button class="refresh-btn" onclick="saveCfg()" style="float:none;margin-left:4px;background:#065f46">備份後儲存</button>
  </h2>
  <p style="font-size:0.75rem;color:#f59e0b;margin:6px 0">⚠ token 等敏感欄位顯示 ***，儲存前請手動還原實際值</p>
  <div id="cfg-msg" style="font-size:0.8rem;margin:4px 0"></div>
  <textarea id="cfg-editor" style="width:100%;height:300px;background:#0f1117;color:#e0e0e0;border:1px solid #2a2d3e;border-radius:6px;padding:8px;font-family:monospace;font-size:0.8rem;resize:vertical"></textarea>
</div>
<script>
let tokenChart, ceChart;

async function loadStatus() {
  try {
    const r = await fetch('/api/status');
    const d = await r.json();
    document.getElementById('status-grid').innerHTML = [
      ['Uptime', d.uptimeStr],
      ['Memory', d.memoryMB + ' MB'],
      ['Heap', d.heapUsedMB + ' MB'],
      ['Node', d.nodeVersion],
      ['PID', d.pid],
    ].map(([lbl, val]) =>
      \`<div class="stat"><div class="stat-val" style="font-size:1rem">\${val}</div><div class="stat-lbl">\${lbl}</div></div>\`
    ).join('');
  } catch(e) { /* 忽略 */ }
}

async function loadCfg() {
  try {
    const r = await fetch('/api/config');
    const text = await r.text();
    document.getElementById('cfg-editor').value = text;
    document.getElementById('cfg-msg').textContent = '';
  } catch(e) {
    document.getElementById('cfg-msg').textContent = '讀取失敗：' + e;
  }
}

async function saveCfg() {
  const body = document.getElementById('cfg-editor').value;
  try {
    JSON.parse(body); // 客端先驗
  } catch(e) {
    document.getElementById('cfg-msg').textContent = 'JSON 格式錯誤：' + e;
    return;
  }
  try {
    const r = await fetch('/api/config', { method:'POST', headers:{'Content-Type':'application/json'}, body });
    const d = await r.json();
    if (d.success) {
      document.getElementById('cfg-msg').style.color = '#34d399';
      document.getElementById('cfg-msg').textContent = '✓ 已備份並儲存';
    } else {
      document.getElementById('cfg-msg').style.color = '#f87171';
      document.getElementById('cfg-msg').textContent = '錯誤：' + d.error;
    }
  } catch(e) {
    document.getElementById('cfg-msg').style.color = '#f87171';
    document.getElementById('cfg-msg').textContent = '儲存失敗：' + e;
  }
}

async function load() {
  const r = await fetch('/api/usage');
  const d = await r.json();

  // Stats bar
  document.getElementById('stats').innerHTML = [
    ['合計 Tokens', (d.totalTokens||0).toLocaleString(), 'total'],
    ['輸入 Tokens', (d.totalInput||0).toLocaleString(), 'input'],
    ['輸出 Tokens', (d.totalOutput||0).toLocaleString(), 'output'],
    ['CE 觸發次數', d.ceTriggers||0, 'ce-triggers'],
    ['平均省 Tokens', (d.avgTokensSaved||0).toLocaleString(), 'ce-saved'],
    ['總 Turns', d.totalTurns||0, 'turns'],
  ].map(([lbl, val]) =>
    \`<div class="stat"><div class="stat-val">\${val}</div><div class="stat-lbl">\${lbl}</div></div>\`
  ).join('');

  // Token bar chart
  const labels = d.daily.map(x => x.date.slice(5)); // MM-DD
  const inputData = d.daily.map(x => x.input);
  const outputData = d.daily.map(x => x.output);

  if (tokenChart) tokenChart.destroy();
  tokenChart = new Chart(document.getElementById('tokenChart'), {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: '輸入', data: inputData, backgroundColor: '#4c1d95' },
        { label: '輸出', data: outputData, backgroundColor: '#1d4ed8' },
      ]
    },
    options: { responsive: true, scales: { x: { stacked: true }, y: { stacked: true } },
      plugins: { legend: { labels: { color: '#ccc' } } },
    }
  });

  // CE bar chart
  const ceLabels = d.daily.map(x => x.date.slice(5));
  const ceTokensSaved = d.daily.map(x => x.ceTokensSaved);
  if (ceChart) ceChart.destroy();
  ceChart = new Chart(document.getElementById('ceChart'), {
    type: 'bar',
    data: {
      labels: ceLabels,
      datasets: [{ label: '省 Tokens', data: ceTokensSaved, backgroundColor: '#065f46' }]
    },
    options: { responsive: true, plugins: { legend: { labels: { color: '#ccc' } } } }
  });

  // Recent turns table
  const rows = (d.recentTurns||[]).map(e => {
    const ts = new Date(e.ts).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });
    const ce = e.ceApplied?.length ? e.ceApplied.join('+') : '-';
    const tok = e.inputTokens != null ? \`↑\${e.inputTokens}/↓\${e.outputTokens??0}\` : '-';
    const dur = e.durationMs != null ? \`\${(e.durationMs/1000).toFixed(1)}s\` : '-';
    return \`<tr><td>\${ts}</td><td>\${(e.sessionKey||'').slice(-20)}</td><td>\${tok}</td><td>\${ce}</td><td>\${dur}</td></tr>\`;
  }).join('');
  document.getElementById('turns').innerHTML =
    \`<table class="table"><thead><tr><th>時間</th><th>Session</th><th>Tokens</th><th>CE</th><th>耗時</th></tr></thead><tbody>\${rows}</tbody></table>\`;
}

load();
loadStatus();
</script>
</body>
</html>`;

// ── API Handler ───────────────────────────────────────────────────────────────

function buildApiData(days = 7) {
  const auditLog = getTurnAuditLog();
  if (!auditLog) return { error: "TurnAuditLog not initialized" };

  const cutoff = Date.now() - days * 86400_000;
  const entries = auditLog.recent(100000, (e) => new Date(e.ts).getTime() >= cutoff);

  const totalInput = entries.reduce((s, e) => s + (e.inputTokens ?? 0), 0);
  const totalOutput = entries.reduce((s, e) => s + (e.outputTokens ?? 0), 0);
  const ceEntries = entries.filter(e => e.ceApplied.length > 0);
  const avgTokensSaved = ceEntries.length > 0
    ? Math.round(ceEntries.reduce((s, e) =>
        s + ((e.tokensBeforeCE ?? 0) - (e.tokensAfterCE ?? 0)), 0) / ceEntries.length)
    : 0;

  // 按日聚合
  const dailyMap = new Map<string, { input: number; output: number; ceTokensSaved: number }>();
  for (const e of entries) {
    const date = e.ts.slice(0, 10);
    const d = dailyMap.get(date) ?? { input: 0, output: 0, ceTokensSaved: 0 };
    d.input += e.inputTokens ?? 0;
    d.output += e.outputTokens ?? 0;
    if (e.ceApplied.length > 0) {
      d.ceTokensSaved += (e.tokensBeforeCE ?? 0) - (e.tokensAfterCE ?? 0);
    }
    dailyMap.set(date, d);
  }
  const daily = Array.from(dailyMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, v]) => ({ date, ...v }));

  // 最近 20 turns（最新優先）
  const recentTurns: TurnAuditEntry[] = entries.slice(0, 20);

  return {
    totalInput,
    totalOutput,
    totalTokens: totalInput + totalOutput,
    totalTurns: entries.length,
    ceTriggers: ceEntries.length,
    avgTokensSaved,
    daily,
    recentTurns,
  };
}

// ── DashboardServer ───────────────────────────────────────────────────────────

export class DashboardServer {
  private port: number;

  constructor(port = 8088) {
    this.port = port;
  }

  start(): void {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = req.url ?? "/";

      if (url === "/" || url === "/index.html") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(HTML);
        return;
      }

      if (url.startsWith("/api/usage")) {
        const daysMatch = url.match(/[?&]days=(\d+)/);
        const days = daysMatch ? parseInt(daysMatch[1]!, 10) : 7;
        const data = buildApiData(days);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
        return;
      }

      const method = req.method ?? "GET";

      // GET /api/status
      if (url === "/api/status") {
        const uptime = Math.floor(process.uptime());
        const mem = process.memoryUsage();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          uptimeSec: uptime,
          uptimeStr: `${Math.floor(uptime/3600)}h ${Math.floor(uptime%3600/60)}m`,
          memoryMB: Math.round(mem.rss/1024/1024),
          heapUsedMB: Math.round(mem.heapUsed/1024/1024),
          nodeVersion: process.version,
          pid: process.pid,
        }));
        return;
      }

      // GET /api/config
      if (url === "/api/config" && method === "GET") {
        void (async () => {
          try {
            const { resolveConfigPath } = await import("./config.js");
            const raw = JSON.parse(readFileSync(resolveConfigPath(), "utf-8")) as unknown;
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(maskConfig(raw), null, 2));
          } catch (err) {
            res.writeHead(500); res.end(JSON.stringify({ error: String(err) }));
          }
        })();
        return;
      }

      // POST /api/config
      if (url === "/api/config" && method === "POST") {
        const chunks: Buffer[] = [];
        let size = 0;
        req.on("data", (c: Buffer) => { size += c.length; if (size < 131072) chunks.push(c); });
        req.on("end", () => {
          void (async () => {
            try {
              const body = Buffer.concat(chunks).toString("utf-8");
              const parsed = JSON.parse(body) as Record<string, unknown>;
              const discord = parsed?.discord as Record<string, unknown> | undefined;
              if (!discord?.token) throw new Error("缺少必要欄位 discord.token");
              const { resolveConfigPath } = await import("./config.js");
              const cp = resolveConfigPath();
              backupConfig(cp);
              const tmp = cp + ".tmp";
              writeFileSync(tmp, JSON.stringify(parsed, null, 2), "utf-8");
              renameSync(tmp, cp);
              res.writeHead(200); res.end(JSON.stringify({ success: true }));
            } catch (err) {
              res.writeHead(400); res.end(JSON.stringify({ error: String(err) }));
            }
          })();
        });
        return;
      }

      res.writeHead(404);
      res.end("Not found");
    });

    server.listen(this.port, "127.0.0.1", () => {
      log.info(`[dashboard] 啟動 http://127.0.0.1:${this.port}`);
    });

    server.on("error", (err) => {
      log.warn(`[dashboard] HTTP 錯誤：${err.message}`);
    });
  }
}

// ── 全域單例 ──────────────────────────────────────────────────────────────────

let _dashboard: DashboardServer | null = null;

export function initDashboard(port = 8088): DashboardServer {
  _dashboard = new DashboardServer(port);
  _dashboard.start();
  return _dashboard;
}

export function getDashboard(): DashboardServer | null {
  return _dashboard;
}
