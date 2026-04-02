/**
 * @file core/dashboard.ts
 * @description Web Dashboard — 多分頁監控 + 操作面板
 *
 * 分頁：概覽 | Sessions | 日誌 | 操作 | Config
 * 端點：GET /  GET /api/usage  GET /api/sessions  GET /api/status
 *        GET /api/logs  POST /api/restart  GET /api/subagents
 *        GET /api/config  POST /api/config
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, writeFileSync, readdirSync, unlinkSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { dirname, basename, join, join as pathJoin, resolve } from "node:path";
import { homedir } from "node:os";
import { log } from "../logger.js";
import { getTurnAuditLog, type TurnAuditEntry } from "./turn-audit-log.js";

// ── Config 備份 ──────────────────────────────────────────────────────────────
const BACKUP_KEEP = 5;

/** 將提交資料中仍為 "***" 的敏感欄位還原為原始值 */
function restoreMasked(submitted: unknown, original: unknown): unknown {
  if (Array.isArray(submitted)) {
    return submitted.map((item, i) => restoreMasked(item, Array.isArray(original) ? original[i] : undefined));
  }
  if (submitted && typeof submitted === "object" && original && typeof original === "object") {
    const r: Record<string, unknown> = {};
    const orig = original as Record<string, unknown>;
    for (const [k, v] of Object.entries(submitted as Record<string, unknown>)) {
      if (SENSITIVE_KEYS.has(k) && v === "***" && typeof orig[k] === "string") {
        r[k] = orig[k]; // 未變動，還原原始值
      } else {
        r[k] = restoreMasked(v, orig[k]);
      }
    }
    return r;
  }
  return submitted;
}

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
const SENSITIVE_KEYS = new Set(["token", "apiKey", "api_key", "password", "credential"]);
function maskConfig(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(maskConfig);
  if (obj && typeof obj === "object") {
    const r: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>))
      r[k] = SENSITIVE_KEYS.has(k) && typeof v === "string" ? "***" : maskConfig(v);
    return r;
  }
  return obj;
}

// ── Log tail helper ──────────────────────────────────────────────────────────
function tailLog(lines = 100): string {
  const candidates = [
    pathJoin(homedir(), ".pm2", "logs", "catclaw-out.log"),
    pathJoin(homedir(), ".pm2", "logs", "catclaw-test-out.log"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        const content = readFileSync(p, "utf-8");
        const all = content.split("\n");
        return all.slice(-lines).join("\n");
      } catch { /* 忽略 */ }
    }
  }
  return "(log file not found)";
}

// ── Signal restart ───────────────────────────────────────────────────────────
function touchRestart(): boolean {
  const candidates = [
    resolve(process.cwd(), "signal", "RESTART"),
    resolve(homedir(), "project", "catclaw", "signal", "RESTART"),
  ];
  for (const p of candidates) {
    try {
      writeFileSync(p, new Date().toISOString(), "utf-8");
      return true;
    } catch { /* try next */ }
  }
  return false;
}

// ── API Data Builders ────────────────────────────────────────────────────────

function buildApiData(days = 7) {
  const auditLog = getTurnAuditLog();
  if (!auditLog) return { error: "TurnAuditLog not initialized" };

  const cutoff = Date.now() - days * 86400_000;
  const entries = auditLog.recent(100000, (e) => new Date(e.ts).getTime() >= cutoff);

  const totalInput = entries.reduce((s, e) => s + (e.inputTokens ?? 0), 0);
  const totalOutput = entries.reduce((s, e) => s + (e.outputTokens ?? 0), 0);
  const totalCacheRead = entries.reduce((s, e) => s + (e.cacheRead ?? 0), 0);
  const totalCacheWrite = entries.reduce((s, e) => s + (e.cacheWrite ?? 0), 0);
  const ceEntries = entries.filter(e => e.ceApplied.length > 0);
  const avgTokensSaved = ceEntries.length > 0
    ? Math.round(ceEntries.reduce((s, e) =>
        s + ((e.tokensBeforeCE ?? 0) - (e.tokensAfterCE ?? 0)), 0) / ceEntries.length)
    : 0;

  // provider 分布統計
  const providerCounts: Record<string, { turns: number; input: number; output: number }> = {};
  for (const e of entries) {
    const key = e.providerType ?? "unknown";
    const p = providerCounts[key] ??= { turns: 0, input: 0, output: 0 };
    p.turns++;
    p.input += e.inputTokens ?? 0;
    p.output += e.outputTokens ?? 0;
  }

  const dailyMap = new Map<string, { input: number; output: number; cacheRead: number; cacheWrite: number; ceTokensSaved: number }>();
  for (const e of entries) {
    const date = e.ts.slice(0, 10);
    const d = dailyMap.get(date) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ceTokensSaved: 0 };
    d.input += e.inputTokens ?? 0;
    d.output += e.outputTokens ?? 0;
    d.cacheRead += e.cacheRead ?? 0;
    d.cacheWrite += e.cacheWrite ?? 0;
    if (e.ceApplied.length > 0) {
      d.ceTokensSaved += (e.tokensBeforeCE ?? 0) - (e.tokensAfterCE ?? 0);
    }
    dailyMap.set(date, d);
  }
  const daily = Array.from(dailyMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, v]) => ({ date, ...v }));

  const recentTurns: TurnAuditEntry[] = entries.slice(0, 20);

  return {
    totalInput, totalOutput, totalCacheRead, totalCacheWrite,
    totalTokens: totalInput + totalOutput,
    totalTurns: entries.length, ceTriggers: ceEntries.length, avgTokensSaved,
    providerCounts, daily, recentTurns,
  };
}

function buildSessionsData() {
  const auditLog = getTurnAuditLog();
  if (!auditLog) return { error: "TurnAuditLog not initialized" };

  const entries = auditLog.recent(100000);
  const sessMap = new Map<string, {
    sessionKey: string; turns: number; inputTokens: number; outputTokens: number;
    cacheRead: number; cacheWrite: number;
    firstTs: string; lastTs: string; ceTriggers: number;
    providers: Set<string>; models: Set<string>;
    recentTurns: TurnAuditEntry[];
  }>();

  for (const e of entries) {
    const k = e.sessionKey;
    const s = sessMap.get(k) ?? {
      sessionKey: k, turns: 0, inputTokens: 0, outputTokens: 0,
      cacheRead: 0, cacheWrite: 0,
      firstTs: e.ts, lastTs: e.ts, ceTriggers: 0,
      providers: new Set<string>(), models: new Set<string>(),
      recentTurns: [],
    };
    s.turns++;
    s.inputTokens += e.inputTokens ?? 0;
    s.outputTokens += e.outputTokens ?? 0;
    s.cacheRead += e.cacheRead ?? 0;
    s.cacheWrite += e.cacheWrite ?? 0;
    if (e.providerType) s.providers.add(e.providerType);
    if (e.model) s.models.add(e.model);
    if (e.ceApplied.length > 0) s.ceTriggers++;
    if (e.ts < s.firstTs) s.firstTs = e.ts;
    if (e.ts > s.lastTs) s.lastTs = e.ts;
    if (s.recentTurns.length < 10) s.recentTurns.push(e);
    sessMap.set(k, s);
  }

  const sessions = Array.from(sessMap.values())
    .sort((a, b) => b.lastTs.localeCompare(a.lastTs))
    .slice(0, 50)
    .map(s => ({
      ...s,
      providers: Array.from(s.providers),
      models: Array.from(s.models),
    }));

  return { sessions };
}

// ── Dashboard HTML ────────────────────────────────────────────────────────────

const HTML = `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>CatClaw Dashboard</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: system-ui, sans-serif; background: #0f1117; color: #e0e0e0; }
.topbar { background: #1a1d2e; padding: 12px 20px; display: flex; align-items: center; gap: 12px; border-bottom: 1px solid #2a2d3e; }
.topbar h1 { font-size: 1.1rem; color: #a78bfa; flex: 1; }
.tabs { display: flex; gap: 2px; background: #0f1117; padding: 0 20px; border-bottom: 1px solid #2a2d3e; }
.tab { padding: 10px 16px; cursor: pointer; font-size: 0.85rem; color: #888; border-bottom: 2px solid transparent; }
.tab.active { color: #a78bfa; border-bottom-color: #a78bfa; }
.tab:hover:not(.active) { color: #ccc; }
.pane { display: none; padding: 20px; }
.pane.active { display: block; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; }
.card { background: #1e2130; border-radius: 8px; padding: 16px; }
.card h2 { font-size: 0.9rem; color: #818cf8; margin-bottom: 10px; }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 8px; margin-bottom: 16px; }
.stat { background: #1e2130; border-radius: 8px; padding: 12px; text-align: center; }
.stat-val { font-size: 1.3rem; font-weight: bold; color: #a78bfa; }
.stat-lbl { font-size: 0.72rem; color: #888; margin-top: 4px; }
canvas { max-height: 200px; }
.tbl { width: 100%; border-collapse: collapse; font-size: 0.78rem; }
.tbl th, .tbl td { padding: 6px 8px; border-bottom: 1px solid #2a2d3e; text-align: left; }
.tbl th { color: #818cf8; background: #161827; }
.tbl tr:hover td { background: #1e2130; }
.btn { background: #4c1d95; border: none; color: white; padding: 6px 14px; border-radius: 6px; cursor: pointer; font-size: 0.8rem; }
.btn:hover { background: #5b21b6; }
.btn-green { background: #065f46; } .btn-green:hover { background: #047857; }
.btn-red { background: #7f1d1d; } .btn-red:hover { background: #991b1b; }
.btn-sm { padding: 3px 8px; font-size: 0.72rem; }
.msg { font-size: 0.8rem; margin: 6px 0; }
.msg.ok { color: #34d399; } .msg.err { color: #f87171; }
.badge { display: inline-block; padding: 2px 6px; border-radius: 4px; font-size: 0.7rem; }
.badge-run { background: #065f46; color: #34d399; }
.badge-done { background: #1e3a5f; color: #60a5fa; }
.badge-err { background: #7f1d1d; color: #f87171; }
textarea { width: 100%; background: #0f1117; color: #e0e0e0; border: 1px solid #2a2d3e; border-radius: 6px; padding: 8px; font-family: monospace; font-size: 0.78rem; resize: vertical; }
details summary { cursor: pointer; color: #818cf8; font-size: 0.78rem; padding: 4px 0; }
details[open] summary { margin-bottom: 6px; }
.cfg-section { margin-bottom: 12px; }
.cfg-section summary { font-size: 0.88rem; font-weight: bold; color: #a78bfa; cursor: pointer; padding: 8px 12px; background: #161827; border-radius: 6px; }
.cfg-section[open] summary { border-radius: 6px 6px 0 0; }
.cfg-fields { padding: 12px; background: #1a1d2e; border-radius: 0 0 6px 6px; }
.cfg-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; }
.cfg-row label { min-width: 180px; font-size: 0.78rem; color: #aaa; }
.cfg-row input[type=text], .cfg-row input[type=number], .cfg-row input[type=password], .cfg-row select {
  flex: 1; min-width: 160px; background: #0f1117; color: #e0e0e0; border: 1px solid #2a2d3e; border-radius: 4px; padding: 4px 8px; font-size: 0.78rem; font-family: monospace;
}
.cfg-row input[type=number] { max-width: 120px; }
.cfg-toggle { position: relative; display: inline-block; width: 36px; min-width: 36px; height: 20px; flex-shrink: 0; }
.cfg-toggle input { opacity: 0; width: 0; height: 0; }
.cfg-toggle .slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background: #333; border-radius: 10px; transition: .2s; }
.cfg-toggle .slider:before { content: ""; position: absolute; height: 14px; width: 14px; left: 3px; bottom: 3px; background: #888; border-radius: 50%; transition: .2s; }
.cfg-toggle input:checked + .slider { background: #065f46; }
.cfg-toggle input:checked + .slider:before { transform: translateX(16px); background: #34d399; }
.cfg-map { width: 100%; }
.cfg-map-row { display: flex; gap: 4px; margin-bottom: 4px; align-items: center; }
.cfg-map-row input { flex: 1; background: #0f1117; color: #e0e0e0; border: 1px solid #2a2d3e; border-radius: 4px; padding: 3px 6px; font-size: 0.75rem; font-family: monospace; }
.cfg-map-row .btn-x { background: #7f1d1d; border: none; color: #f87171; width: 22px; height: 22px; border-radius: 4px; cursor: pointer; font-size: 0.7rem; }
.cfg-add { background: #1e3a5f; border: none; color: #60a5fa; padding: 3px 8px; border-radius: 4px; cursor: pointer; font-size: 0.72rem; margin-top: 4px; }
.cfg-list { width: 100%; }
.cfg-list-item { display: flex; gap: 4px; margin-bottom: 4px; }
.cfg-list-item input { flex: 1; background: #0f1117; color: #e0e0e0; border: 1px solid #2a2d3e; border-radius: 4px; padding: 3px 6px; font-size: 0.75rem; font-family: monospace; }
.cfg-sub { margin-left: 16px; border-left: 2px solid #2a2d3e; padding-left: 12px; margin-top: 6px; margin-bottom: 6px; }
.cfg-dynamic-entry { background: #161827; border-radius: 6px; padding: 10px; margin-bottom: 8px; }
.cfg-dynamic-entry .entry-header { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.cfg-dynamic-entry .entry-header input { flex: 1; font-weight: bold; }
.cfg-hint { font-size: 0.68rem; color: #666; margin-left: 4px; }
</style>
</head>
<body>
<div class="topbar">
  <h1>🐱 CatClaw Dashboard</h1>
  <button class="btn btn-sm" onclick="refreshAll()">↻ 全部刷新</button>
</div>
<div class="tabs">
  <div class="tab active" onclick="switchTab('overview',this)">概覽</div>
  <div class="tab" onclick="switchTab('sessions',this)">Sessions</div>
  <div class="tab" onclick="switchTab('logs',this)">日誌</div>
  <div class="tab" onclick="switchTab('ops',this)">操作</div>
  <div class="tab" onclick="switchTab('cron',this)">排程</div>
  <div class="tab" onclick="switchTab('auth',this)">Auth Profiles</div>
  <div class="tab" onclick="switchTab('config',this)">Config</div>
</div>

<!-- 概覽 -->
<div id="pane-overview" class="pane active">
  <div class="stats" id="stats"></div>
  <div class="card" style="margin-bottom:16px">
    <h2>Provider 分布</h2>
    <div id="provider-dist" style="font-size:0.82rem;padding:4px 0;color:#ccc"></div>
  </div>
  <div class="card" style="margin-bottom:16px">
    <h2>Bot 狀態</h2>
    <div id="status-grid" class="stats" style="margin-bottom:0"></div>
  </div>
  <div class="grid">
    <div class="card"><h2>每日 Token 用量（含 Cache）</h2><canvas id="tokenChart"></canvas></div>
    <div class="card"><h2>CE 壓縮效果</h2><canvas id="ceChart"></canvas></div>
  </div>
  <div class="card" style="margin-top:16px">
    <h2>最近 Turns</h2>
    <div id="turns"></div>
  </div>
</div>

<!-- Sessions -->
<div id="pane-sessions" class="pane">
  <div class="card">
    <h2>Sessions（最近 50）<button class="btn btn-sm" style="float:right" onclick="loadSessions()">↻</button></h2>
    <div id="sessions-list"></div>
  </div>
</div>

<!-- 日誌 -->
<div id="pane-logs" class="pane">
  <div class="card">
    <h2>PM2 日誌（最近 200 行）
      <button class="btn btn-sm" style="float:right;margin-left:4px" onclick="startLogRefresh()">▶ 自動刷新</button>
      <button class="btn btn-sm" style="float:right" onclick="loadLogs()">↻ 讀取</button>
    </h2>
    <textarea id="log-area" rows="30" readonly></textarea>
  </div>
</div>

<!-- 操作 -->
<div id="pane-ops" class="pane">
  <div class="grid">
    <div class="card">
      <h2>Bot 控制</h2>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
        <button class="btn btn-red" onclick="doRestart()">⟳ 重啟 Bot</button>
      </div>
      <div id="ops-msg" class="msg"></div>
    </div>
    <div class="card">
      <h2>Active Subagents</h2>
      <div id="subagents-list"></div>
    </div>
  </div>
</div>

<!-- 排程 -->
<div id="pane-cron" class="pane">
  <div class="card">
    <h2>Cron Jobs
      <button class="btn btn-sm" style="float:right;margin-left:4px" onclick="showCronAdd()">+ 新增</button>
      <button class="btn btn-sm" style="float:right" onclick="loadCron()">↻</button>
    </h2>
    <div id="cron-msg" class="msg"></div>
    <div id="cron-list"><p style="color:#888;font-size:0.8rem">載入中...</p></div>
  </div>
  <div id="cron-add-panel" class="card" style="margin-top:16px;display:none">
    <h2>新增 Job（JSON）</h2>
    <p style="font-size:0.72rem;color:#888;margin-bottom:6px">格式：{"name":"...","schedule":{"kind":"cron","expr":"0 9 * * *"},"action":{"type":"message","channelId":"...","text":"..."}}</p>
    <textarea id="cron-add-json" rows="8" placeholder='{"name":"my-job","enabled":true,"schedule":{"kind":"cron","expr":"0 9 * * *"},"action":{"type":"message","channelId":"CHANNEL_ID","text":"hello"}}'></textarea>
    <div style="margin-top:8px;display:flex;gap:8px">
      <button class="btn btn-green" onclick="addCronJob()">新增</button>
      <button class="btn" onclick="hideCronAdd()">取消</button>
    </div>
  </div>
</div>

<!-- Auth Profiles -->
<div id="pane-auth" class="pane">
  <div class="card">
    <h2>Auth Profiles（OAuth 憑證管理）
      <button class="btn btn-sm" style="float:right" onclick="loadAuthProfiles()">↻ 讀取</button>
    </h2>
    <div id="auth-msg" class="msg"></div>
    <div id="auth-creds"></div>
    <div style="margin-top:12px;padding-top:12px;border-top:1px solid #2a2d3e">
      <h3 style="font-size:0.82rem;color:#818cf8;margin-bottom:8px">新增憑證</h3>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <input id="auth-new-id" placeholder="ID (如 key-3)" style="flex:0 0 120px;background:#0f1117;color:#e0e0e0;border:1px solid #2a2d3e;border-radius:4px;padding:4px 8px;font-size:0.78rem;font-family:monospace">
        <input id="auth-new-cred" type="password" placeholder="Credential (sk-ant-oat...)" style="flex:1;min-width:200px;background:#0f1117;color:#e0e0e0;border:1px solid #2a2d3e;border-radius:4px;padding:4px 8px;font-size:0.78rem;font-family:monospace">
        <button class="btn btn-green btn-sm" onclick="addAuthProfile()">+ 新增</button>
      </div>
    </div>
  </div>
  <div class="card" style="margin-top:16px">
    <h2>Provider 狀態（Cooldown / Round-Robin）</h2>
    <div id="auth-statuses"></div>
  </div>
</div>

<!-- Config -->
<div id="pane-config" class="pane">
  <div style="margin-bottom:12px;display:flex;gap:8px;align-items:center">
    <button class="btn" onclick="loadCfg()">↻ 讀取</button>
    <button class="btn btn-green" onclick="saveCfg()">💾 備份後儲存</button>
    <div id="cfg-msg" class="msg" style="flex:1"></div>
    <p style="font-size:0.72rem;color:#f59e0b;margin:0">⚠ 敏感欄位顯示 ***，儲存前請手動還原</p>
  </div>
  <div id="cfg-gui"></div>
</div>

<script>
let tokenChart, ceChart;
let logTimer = null;

function fmtK(n) { return n >= 10000 ? (n/1000).toFixed(1)+'k' : n.toLocaleString(); }
function fmtCache(r, w) {
  if (!r && !w) return '-';
  return \`📖\${fmtK(r||0)} / ✏️\${fmtK(w||0)}\`;
}

function switchTab(id, el) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.pane').forEach(p => p.classList.remove('active'));
  el.classList.add('active');
  document.getElementById('pane-' + id).classList.add('active');
  if (id === 'sessions') loadSessions();
  if (id === 'logs') loadLogs();
  if (id === 'ops') { loadSubagents(); }
  if (id === 'auth') loadAuthProfiles();
  if (id === 'cron') loadCron();
  if (id === 'config') loadCfg();
}

function refreshAll() { loadOverview(); loadStatus(); }

// ── 概覽 ─────────────────────────────────────────────────────────────────────
async function loadStatus() {
  try {
    const d = await fetch('/api/status').then(r => r.json());
    document.getElementById('status-grid').innerHTML = [
      ['Uptime', d.uptimeStr], ['Memory', d.memoryMB + ' MB'],
      ['Heap', d.heapUsedMB + ' MB'], ['PID', d.pid],
    ].map(([l,v]) => \`<div class="stat"><div class="stat-val" style="font-size:1rem">\${v}</div><div class="stat-lbl">\${l}</div></div>\`).join('');
  } catch {}
}

async function loadOverview() {
  try {
    const d = await fetch('/api/usage').then(r => r.json());
    document.getElementById('stats').innerHTML = [
      ['合計 Tokens', (d.totalTokens||0).toLocaleString()],
      ['輸入', (d.totalInput||0).toLocaleString()],
      ['輸出', (d.totalOutput||0).toLocaleString()],
      ['📖 Cache Read', fmtK(d.totalCacheRead||0)],
      ['✏️ Cache Write', fmtK(d.totalCacheWrite||0)],
      ['CE 觸發', d.ceTriggers||0],
      ['平均省 Tokens', (d.avgTokensSaved||0).toLocaleString()],
      ['Turns', d.totalTurns||0],
    ].map(([l,v]) => \`<div class="stat"><div class="stat-val">\${v}</div><div class="stat-lbl">\${l}</div></div>\`).join('');

    // Provider 分布
    const pc = d.providerCounts || {};
    const provHtml = Object.entries(pc).map(([k,v]) =>
      \`<span style="margin-right:12px"><b>\${k}</b> \${v.turns}t ↑\${v.input.toLocaleString()}/↓\${v.output.toLocaleString()}</span>\`
    ).join('');
    const provEl = document.getElementById('provider-dist');
    if (provEl) provEl.innerHTML = provHtml || '<span style="color:#888">無資料</span>';

    const labels = d.daily.map(x => x.date.slice(5));
    if (tokenChart) tokenChart.destroy();
    tokenChart = new Chart(document.getElementById('tokenChart'), {
      type:'bar', data:{ labels, datasets:[
        {label:'輸入',data:d.daily.map(x=>x.input),backgroundColor:'#4c1d95'},
        {label:'輸出',data:d.daily.map(x=>x.output),backgroundColor:'#1d4ed8'},
        {label:'📖 Cache Read',data:d.daily.map(x=>x.cacheRead||0),backgroundColor:'#0d9488'},
        {label:'✏️ Cache Write',data:d.daily.map(x=>x.cacheWrite||0),backgroundColor:'#d97706'},
      ]},
      options:{responsive:true,scales:{x:{stacked:true},y:{stacked:true}},plugins:{legend:{labels:{color:'#ccc'}}}},
    });

    if (ceChart) ceChart.destroy();
    ceChart = new Chart(document.getElementById('ceChart'), {
      type:'bar', data:{labels,datasets:[{label:'省 Tokens',data:d.daily.map(x=>x.ceTokensSaved),backgroundColor:'#065f46'}]},
      options:{responsive:true,plugins:{legend:{labels:{color:'#ccc'}}}},
    });

    const rows = (d.recentTurns||[]).map(e => {
      const ts = new Date(e.ts).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false});
      const inp = e.inputTokens != null ? e.inputTokens.toLocaleString() : '-';
      const out = (e.outputTokens??0).toLocaleString();
      const cache = fmtCache(e.cacheRead, e.cacheWrite);
      const dur = e.durationMs != null ? \`\${(e.durationMs/1000).toFixed(1)}s\` : '-';
      const sk = (e.sessionKey||'').slice(-16);
      const mdl = e.model ? \`<span title="\${e.model}">\${e.model.length>18?e.model.slice(0,18)+'…':e.model}</span>\` : '-';
      const prov = e.providerType || '-';
      const est = e.estimated ? '~' : '';
      return \`<tr><td>\${ts}</td><td title="\${e.sessionKey}">\${sk}</td><td>\${prov}</td><td>\${mdl}</td><td>\${est}↑\${inp}</td><td>↓\${out}</td><td>\${cache}</td><td>\${e.ceApplied?.join('+')||'-'}</td><td>\${dur}</td></tr>\`;
    }).join('');
    document.getElementById('turns').innerHTML =
      \`<table class="tbl"><thead><tr><th>時間</th><th>Session</th><th>Provider</th><th>Model</th><th>輸入</th><th>輸出</th><th>Cache</th><th>CE</th><th>耗時</th></tr></thead><tbody>\${rows}</tbody></table>\`;
  } catch(e) { console.error(e); }
}

// ── Sessions ─────────────────────────────────────────────────────────────────
async function loadSessions() {
  try {
    const d = await fetch('/api/sessions').then(r => r.json());
    if (!d.sessions?.length) { document.getElementById('sessions-list').innerHTML = '<p style="color:#888;font-size:0.8rem">無資料</p>'; return; }
    const rows = d.sessions.map(s => {
      const last = new Date(s.lastTs).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false});
      const tok = \`↑\${s.inputTokens.toLocaleString()}/↓\${s.outputTokens.toLocaleString()}\`;
      const cache = fmtCache(s.cacheRead, s.cacheWrite);
      const provs = (s.providers||[]).join(', ') || '-';
      const mdls = (s.models||[]).map(m => m.length>20?m.slice(0,20)+'…':m).join(', ') || '-';
      const turnsHtml = s.recentTurns.map(e => {
        const ts2 = new Date(e.ts).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false});
        const dur = e.durationMs != null ? \`\${(e.durationMs/1000).toFixed(1)}s\` : '-';
        const eProv = e.providerType || '-';
        const eCache = fmtCache(e.cacheRead, e.cacheWrite);
        const est = e.estimated ? '~' : '';
        return \`<tr><td>\${ts2}</td><td>\${eProv}</td><td>\${est}\${e.inputTokens??'-'}/\${e.outputTokens??'-'}</td><td>\${eCache}</td><td>\${e.ceApplied?.join('+')||'-'}</td><td>\${dur}</td></tr>\`;
      }).join('');
      const detail = \`<details><summary>展開 \${s.turns} turns</summary><table class="tbl"><thead><tr><th>時間</th><th>Provider</th><th>Tokens</th><th>Cache</th><th>CE</th><th>耗時</th></tr></thead><tbody>\${turnsHtml}</tbody></table></details>\`;
      return \`<tr><td title="\${s.sessionKey}">\${s.sessionKey.slice(-24)}</td><td>\${last}</td><td>\${s.turns}</td><td>\${tok}</td><td>\${cache}</td><td title="\${mdls}">\${provs}</td><td>\${s.ceTriggers}</td><td>\${detail}</td></tr>\`;
    }).join('');
    document.getElementById('sessions-list').innerHTML =
      \`<table class="tbl"><thead><tr><th>Session</th><th>最後活躍</th><th>Turns</th><th>Tokens</th><th>Cache</th><th>Provider</th><th>CE</th><th>詳細</th></tr></thead><tbody>\${rows}</tbody></table>\`;
  } catch(e) { document.getElementById('sessions-list').innerHTML = '讀取失敗：' + e; }
}

// ── 日誌 ─────────────────────────────────────────────────────────────────────
async function loadLogs() {
  try {
    const text = await fetch('/api/logs?lines=200').then(r => r.text());
    const el = document.getElementById('log-area');
    el.value = text;
    el.scrollTop = el.scrollHeight;
  } catch(e) { document.getElementById('log-area').value = '讀取失敗：' + e; }
}

function startLogRefresh() {
  if (logTimer) { clearInterval(logTimer); logTimer = null; return; }
  loadLogs();
  logTimer = setInterval(loadLogs, 5000);
}

// ── 操作 ─────────────────────────────────────────────────────────────────────
async function doRestart() {
  if (!confirm('確定重啟 Bot？')) return;
  try {
    const d = await fetch('/api/restart', {method:'POST'}).then(r => r.json());
    const el = document.getElementById('ops-msg');
    el.className = 'msg ' + (d.success ? 'ok' : 'err');
    el.textContent = d.success ? '✓ 重啟信號已送出' : '錯誤：' + d.error;
  } catch(e) { const el = document.getElementById('ops-msg'); el.className='msg err'; el.textContent='失敗：'+e; }
}

async function loadSubagents() {
  try {
    const d = await fetch('/api/subagents').then(r => r.json());
    if (!d.subagents?.length) { document.getElementById('subagents-list').innerHTML = '<p style="color:#888;font-size:0.8rem">無 subagent 記錄</p>'; return; }
    const rows = d.subagents.slice(0, 30).map(s => {
      const badge = s.status === 'running' ? 'badge-run' : s.status === 'completed' ? 'badge-done' : 'badge-err';
      const dur = s.endedAt ? ((s.endedAt - s.createdAt)/1000).toFixed(1)+'s' : s.status === 'running' ? ((Date.now()-s.createdAt)/1000).toFixed(0)+'s...' : '-';
      const task = (s.task || '-').slice(0, 40);
      const killBtn = s.status === 'running' ? \`<button class="btn btn-sm btn-red" onclick="killSubagent('\${s.runId}')">✕</button>\` : '';
      return \`<tr>
        <td title="\${s.runId}">\${(s.label||s.runId).slice(-12)}</td>
        <td><span class="badge \${badge}">\${s.status}</span></td>
        <td style="font-size:0.72rem" title="\${s.task}">\${task}</td>
        <td>\${s.turns||0}</td>
        <td style="font-size:0.72rem">\${dur}</td>
        <td>\${killBtn}</td>
      </tr>\`;
    }).join('');
    document.getElementById('subagents-list').innerHTML =
      \`<table class="tbl"><thead><tr><th>Label</th><th>狀態</th><th>Task</th><th>Turns</th><th>時長</th><th></th></tr></thead><tbody>\${rows}</tbody></table>\`;
  } catch {}
}

async function killSubagent(runId) {
  if (!confirm('確定強制中止 ' + runId + '？')) return;
  try {
    const d = await fetch('/api/subagents/kill',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({runId})}).then(r=>r.json());
    const el = document.getElementById('ops-msg');
    el.className = 'msg ' + (d.success ? 'ok' : 'err');
    el.textContent = d.success ? '✓ 已中止 ' + runId : '錯誤：' + d.error;
    loadSubagents();
  } catch(e) { const el = document.getElementById('ops-msg'); el.className='msg err'; el.textContent='失敗：'+e; }
}

// ── 排程 ─────────────────────────────────────────────────────────────────────
async function loadCron() {
  try {
    const d = await fetch('/api/cron').then(r => r.json());
    const jobs = d.jobs || {};
    const entries = Object.entries(jobs);
    if (!entries.length) { document.getElementById('cron-list').innerHTML = '<p style="color:#888;font-size:0.8rem">無 cron job</p>'; return; }
    const rows = entries.map(([id, job]) => {
      const j = job;
      const schedStr = j.schedule.kind === 'cron' ? j.schedule.expr
        : j.schedule.kind === 'every' ? ('每 ' + Math.round(j.schedule.everyMs/1000) + 's')
        : (j.schedule.at || '-');
      const lastRun = j.lastRunAtMs ? new Date(j.lastRunAtMs).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false}) : '-';
      const nextRun = j.nextRunAtMs && j.nextRunAtMs < 9e15 ? new Date(j.nextRunAtMs).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false}) : '-';
      const resultBadge = j.lastResult === 'success' ? '<span class="badge badge-done">✓</span>' : j.lastResult === 'error' ? '<span class="badge badge-err">✗</span>' : '-';
      const enCls = j.enabled !== false ? 'badge-done' : 'badge-err';
      const enLabel = j.enabled !== false ? '啟用' : '停用';
      return \`<tr>
        <td title="\${id}">\${id.slice(-8)}</td>
        <td>\${j.name||'-'}</td>
        <td style="font-size:0.72rem;font-family:monospace">\${schedStr}</td>
        <td><span class="badge \${enCls}">\${enLabel}</span></td>
        <td style="font-size:0.72rem">\${lastRun}</td>
        <td>\${resultBadge}</td>
        <td style="font-size:0.72rem">\${nextRun}</td>
        <td style="white-space:nowrap">
          <button class="btn btn-sm btn-green" onclick="triggerCronJob('\${id}')">▶</button>
          <button class="btn btn-sm" onclick="toggleCronJob('\${id}', \${j.enabled === false})">⊘</button>
          <button class="btn btn-sm btn-red" onclick="deleteCronJob('\${id}')">✕</button>
        </td>\`;
    }).join('');
    document.getElementById('cron-list').innerHTML =
      \`<table class="tbl"><thead><tr><th>ID</th><th>名稱</th><th>排程</th><th>狀態</th><th>上次執行</th><th>結果</th><th>下次執行</th><th>操作</th></tr></thead><tbody>\${rows}</tbody></table>\`;
  } catch(e) { document.getElementById('cron-list').innerHTML = '讀取失敗：' + e; }
}

function showCronAdd() { document.getElementById('cron-add-panel').style.display = ''; }
function hideCronAdd() { document.getElementById('cron-add-panel').style.display = 'none'; }

async function addCronJob() {
  const raw = document.getElementById('cron-add-json').value.trim();
  try { JSON.parse(raw); } catch(e) { showCronMsg('JSON 格式錯誤：' + e, false); return; }
  try {
    const d = await fetch('/api/cron',{method:'POST',headers:{'Content-Type':'application/json'},body:raw}).then(r=>r.json());
    if (d.success) { showCronMsg('✓ 已新增', true); hideCronAdd(); loadCron(); }
    else showCronMsg('錯誤：' + d.error, false);
  } catch(e) { showCronMsg('失敗：' + e, false); }
}

async function deleteCronJob(id) {
  if (!confirm('確定刪除 job ' + id + '？')) return;
  try {
    const d = await fetch('/api/cron/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id})}).then(r=>r.json());
    if (d.success) { showCronMsg('✓ 已刪除', true); loadCron(); }
    else showCronMsg('錯誤：' + d.error, false);
  } catch(e) { showCronMsg('失敗：' + e, false); }
}

async function triggerCronJob(id) {
  try {
    const d = await fetch('/api/cron/trigger',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id})}).then(r=>r.json());
    if (d.success) { showCronMsg('✓ 已排入立即執行（下次 tick 生效）', true); loadCron(); }
    else showCronMsg('錯誤：' + d.error, false);
  } catch(e) { showCronMsg('失敗：' + e, false); }
}

async function toggleCronJob(id, enable) {
  try {
    const d = await fetch('/api/cron/toggle',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,enabled:enable})}).then(r=>r.json());
    if (d.success) { loadCron(); }
    else showCronMsg('錯誤：' + d.error, false);
  } catch(e) { showCronMsg('失敗：' + e, false); }
}

function showCronMsg(msg, ok) {
  const el = document.getElementById('cron-msg');
  el.className = 'msg ' + (ok ? 'ok' : 'err');
  el.textContent = msg;
}

// ── Config GUI ───────────────────────────────────────────────────────────────
let _cfgData = null;

// Schema: 描述 config 結構，驅動表單生成
const CFG_SCHEMA = [
  { key:'_basic', label:'基本設定', fields:[
    {k:'provider',t:'text',l:'預設 Provider ID',d:'所有頻道預設使用的 LLM provider'},
    {k:'logLevel',t:'select',l:'Log Level',opts:['debug','info','warn','error'],d:'日誌等級'},
    {k:'turnTimeoutMs',t:'num',l:'Turn Timeout (ms)',d:'單次 turn 最長執行時間'},
    {k:'turnTimeoutToolCallMs',t:'num',l:'Tool Call Timeout (ms)',d:'含 tool call 的 turn 最長時間'},
    {k:'debounceMs',t:'num',l:'Debounce (ms)',d:'連續訊息合併延遲'},
    {k:'fileUploadThreshold',t:'num',l:'File Upload Threshold',d:'回覆超過此字數改上傳檔案'},
    {k:'showToolCalls',t:'select',l:'Show Tool Calls',opts:['all','summary','none'],d:'Discord 是否顯示 tool 呼叫'},
    {k:'showThinking',t:'bool',l:'Show Thinking',d:'是否顯示 AI 推理過程'},
    {k:'streamingReply',t:'bool',l:'串流回覆',d:'逐字串流 vs 完成後一次送出'},
  ]},
  { key:'discord', label:'Discord', fields:[
    {k:'discord.token',t:'pw',l:'Token'},
    {k:'discord.dm.enabled',t:'bool',l:'DM 啟用'},
    {k:'admin.allowedUserIds',t:'list',l:'管理員 User IDs'},
  ]},
  { key:'providers', label:'Providers', dynamic:true, entryFields:[
    {k:'type',t:'select',l:'Type',opts:['','claude','claude-oauth','openai','openai-compat','codex-oauth','ollama'],d:'Provider 型別（空 = 自動偵測）'},
    {k:'mode',t:'select',l:'Auth Mode',opts:['','token','api','password'],d:'token=OAuth, api=API Key, password=Basic Auth'},
    {k:'token',t:'pw',l:'Token / API Key',d:'支援環境變數展開'},
    {k:'model',t:'text',l:'Model',d:'模型 ID'},
    {k:'baseUrl',t:'text',l:'Base URL',d:'OpenAI 相容端點'},
    {k:'host',t:'text',l:'Host',d:'Ollama host (如 http://localhost:11434)'},
    {k:'think',t:'bool',l:'Think Mode',d:'Ollama thinking 模式（qwen3 等）'},
    {k:'thinking',t:'bool',l:'Extended Thinking',d:'Claude extended thinking'},
    {k:'numPredict',t:'num',l:'Num Predict',d:'Ollama 最大輸出 token'},
    {k:'username',t:'text',l:'Username',d:'Basic Auth 帳號'},
    {k:'password',t:'pw',l:'Password',d:'Basic Auth 密碼'},
    {k:'wsUrl',t:'text',l:'WebSocket URL',d:'OpenClaw WS URL'},
    {k:'agentId',t:'text',l:'Agent ID',d:'OpenClaw agent ID'},
    {k:'oauthTokenPath',t:'text',l:'OAuth Token Path',d:'Codex OAuth 檔案路徑'},
    {k:'oauthRefreshUrl',t:'text',l:'OAuth Refresh URL'},
    {k:'oauthClientId',t:'text',l:'OAuth Client ID'},
  ]},
  { key:'providerRouting', label:'Provider Routing', fields:[
    {k:'providerRouting.failoverChain',t:'list',l:'Failover Chain'},
  ], maps:[
    {k:'providerRouting.channels',l:'Channel → Provider'},
    {k:'providerRouting.roles',l:'Role → Provider'},
    {k:'providerRouting.projects',l:'Project → Provider'},
  ], sub:[
    {k:'providerRouting.circuitBreaker',l:'Circuit Breaker',fields:[
      {k:'errorThreshold',t:'num',l:'Error Threshold'},
      {k:'windowMs',t:'num',l:'Window (ms)'},
      {k:'cooldownMs',t:'num',l:'Cooldown (ms)'},
    ]},
  ]},
  { key:'guilds', label:'Guilds', dynamicPath:'discord.guilds', entryFields:[
    {k:'allow',t:'bool',l:'Allow'},
    {k:'requireMention',t:'bool',l:'Require Mention'},
    {k:'allowBot',t:'bool',l:'Allow Bot'},
    {k:'blockGroupMentions',t:'bool',l:'Block Group Mentions'},
    {k:'allowFrom',t:'list',l:'Allow From (IDs)'},
  ], hasChannels:true, channelFields:[
    {k:'allow',t:'bool',l:'Allow'},
    {k:'requireMention',t:'bool',l:'Require Mention'},
    {k:'allowBot',t:'bool',l:'Allow Bot'},
    {k:'provider',t:'text',l:'Provider'},
    {k:'boundProject',t:'text',l:'Bound Project'},
    {k:'blockGroupMentions',t:'bool',l:'Block Group Mentions'},
    {k:'interruptOnNewMessage',t:'bool',l:'Interrupt On New Message'},
    {k:'autoThread',t:'bool',l:'Auto Thread'},
    {k:'allowFrom',t:'list',l:'Allow From (IDs)'},
  ]},
  { key:'session', label:'Session', fields:[
    {k:'session.ttlHours',t:'num',l:'TTL (hours)'},
    {k:'session.maxHistoryTurns',t:'num',l:'Max History Turns'},
    {k:'session.compactAfterTurns',t:'num',l:'Compact After Turns'},
    {k:'session.persistPath',t:'text',l:'Persist Path'},
  ]},
  { key:'memory', label:'Memory', fields:[
    {k:'memory.enabled',t:'bool',l:'啟用',d:'記憶系統總開關'},
    {k:'memory.root',t:'text',l:'Root Path',d:'記憶 atom 儲存根目錄'},
    {k:'memory.vectorDbPath',t:'text',l:'Vector DB Path',d:'LanceDB 向量索引路徑'},
    {k:'memory.contextBudget',t:'num',l:'Context Budget (tokens)',d:'每次 turn 注入的記憶 token 上限'},
  ], sub:[
    {k:'memory.contextBudgetRatio',l:'Context Budget Ratio',fields:[
      {k:'global',t:'num',l:'Global',step:'0.1'},
      {k:'project',t:'num',l:'Project',step:'0.1'},
      {k:'account',t:'num',l:'Account',step:'0.1'},
    ]},
    {k:'memory.writeGate',l:'Write Gate',fields:[
      {k:'enabled',t:'bool',l:'啟用'},
      {k:'dedupThreshold',t:'num',l:'Dedup Threshold',step:'0.01'},
    ]},
    {k:'memory.recall',l:'Recall',fields:[
      {k:'triggerMatch',t:'bool',l:'Trigger Match'},
      {k:'vectorSearch',t:'bool',l:'Vector Search'},
      {k:'relatedEdgeSpreading',t:'bool',l:'Related Edge Spreading'},
      {k:'vectorMinScore',t:'num',l:'Vector Min Score',step:'0.01'},
      {k:'vectorTopK',t:'num',l:'Vector Top K'},
      {k:'llmSelect',t:'bool',l:'LLM Select'},
      {k:'llmSelectMax',t:'num',l:'LLM Select Max'},
    ]},
    {k:'memory.extract',l:'Extract',fields:[
      {k:'enabled',t:'bool',l:'啟用'},
      {k:'perTurn',t:'bool',l:'Per Turn'},
      {k:'onSessionEnd',t:'bool',l:'On Session End'},
      {k:'maxItemsPerTurn',t:'num',l:'Max Items Per Turn'},
      {k:'maxItemsSessionEnd',t:'num',l:'Max Items Session End'},
      {k:'minNewChars',t:'num',l:'Min New Chars'},
    ]},
    {k:'memory.consolidate',l:'Consolidate',fields:[
      {k:'autoPromoteThreshold',t:'num',l:'Auto Promote Threshold'},
      {k:'suggestPromoteThreshold',t:'num',l:'Suggest Promote Threshold'},
    ]},
    {k:'memory.consolidate.decay',l:'Decay',fields:[
      {k:'enabled',t:'bool',l:'啟用'},
      {k:'halfLifeDays',t:'num',l:'Half Life (days)'},
      {k:'archiveThreshold',t:'num',l:'Archive Threshold',step:'0.01'},
    ]},
    {k:'memory.episodic',l:'Episodic',fields:[
      {k:'enabled',t:'bool',l:'啟用'},
      {k:'ttlDays',t:'num',l:'TTL (days)'},
    ]},
    {k:'memory.rutDetection',l:'Rut Detection',fields:[
      {k:'enabled',t:'bool',l:'啟用'},
      {k:'windowSize',t:'num',l:'Window Size'},
      {k:'minOccurrences',t:'num',l:'Min Occurrences'},
    ]},
    {k:'memory.oscillation',l:'Oscillation',fields:[
      {k:'enabled',t:'bool',l:'啟用'},
    ]},
    {k:'memory.sessionMemory',l:'Session Memory',fields:[
      {k:'enabled',t:'bool',l:'啟用'},
      {k:'intervalTurns',t:'num',l:'Interval Turns'},
      {k:'maxHistoryTurns',t:'num',l:'Max History Turns'},
    ]},
  ]},
  { key:'ollama', label:'Ollama (Dual Backend)', fields:[
    {k:'ollama.enabled',t:'bool',l:'啟用'},
    {k:'ollama.failover',t:'bool',l:'Auto Failover'},
    {k:'ollama.thinkMode',t:'bool',l:'Think Mode'},
    {k:'ollama.numPredict',t:'num',l:'Num Predict'},
    {k:'ollama.timeout',t:'num',l:'Timeout (ms)'},
  ], sub:[
    {k:'ollama.primary',l:'Primary',fields:[
      {k:'host',t:'text',l:'Host'},
      {k:'model',t:'text',l:'Model'},
      {k:'embeddingModel',t:'text',l:'Embedding Model'},
    ]},
    {k:'ollama.fallback',l:'Fallback',fields:[
      {k:'host',t:'text',l:'Host'},
      {k:'model',t:'text',l:'Model'},
    ]},
  ]},
  { key:'safety', label:'Safety', fields:[
    {k:'safety.enabled',t:'bool',l:'啟用',d:'安全系統總開關（禁止關閉）'},
    {k:'safety.selfProtect',t:'bool',l:'Self Protect',d:'保護 catclaw.json 等核心設定不被 AI 修改'},
    {k:'safety.bash.blacklist',t:'list',l:'Bash Blacklist'},
    {k:'safety.filesystem.protectedPaths',t:'list',l:'Protected Paths'},
    {k:'safety.filesystem.credentialPatterns',t:'list',l:'Credential Patterns'},
  ], sub:[
    {k:'safety.execApproval',l:'Exec Approval',fields:[
      {k:'enabled',t:'bool',l:'啟用'},
      {k:'dmUserId',t:'text',l:'DM User ID'},
      {k:'timeoutMs',t:'num',l:'Timeout (ms)'},
      {k:'allowedPatterns',t:'list',l:'Allowed Patterns'},
    ]},
    {k:'safety.toolPermissions',l:'Tool Permissions',fields:[
      {k:'defaultAllow',t:'bool',l:'Default Allow'},
    ]},
  ]},
  { key:'workflow', label:'Workflow', sub:[
    {k:'workflow.guardian',l:'Guardian',fields:[
      {k:'enabled',t:'bool',l:'啟用'},
      {k:'syncReminder',t:'bool',l:'Sync Reminder'},
      {k:'fileTracking',t:'bool',l:'File Tracking'},
    ]},
    {k:'workflow.fixEscalation',l:'Fix Escalation',fields:[
      {k:'enabled',t:'bool',l:'啟用'},
      {k:'retryThreshold',t:'num',l:'Retry Threshold'},
    ]},
    {k:'workflow.wisdomEngine',l:'Wisdom Engine',fields:[
      {k:'enabled',t:'bool',l:'啟用'},
    ]},
    {k:'workflow.aidocs',l:'AIDocs',fields:[
      {k:'enabled',t:'bool',l:'啟用'},
      {k:'contentGate',t:'bool',l:'Content Gate'},
    ]},
  ]},
  { key:'accounts', label:'Accounts', fields:[
    {k:'accounts.registrationMode',t:'select',l:'Registration Mode',opts:['open','invite','closed']},
    {k:'accounts.defaultRole',t:'text',l:'Default Role'},
    {k:'accounts.pairingEnabled',t:'bool',l:'Pairing Enabled'},
    {k:'accounts.pairingExpireMinutes',t:'num',l:'Pairing Expire (min)'},
  ]},
  { key:'cron', label:'Cron', fields:[
    {k:'cron.enabled',t:'bool',l:'啟用'},
    {k:'cron.maxConcurrentRuns',t:'num',l:'Max Concurrent Runs'},
    {k:'cron.defaultAccountId',t:'text',l:'Default Account ID'},
    {k:'cron.defaultProvider',t:'text',l:'Default Provider'},
  ]},
  { key:'contextEngineering', label:'Context Engineering', fields:[
    {k:'contextEngineering.enabled',t:'bool',l:'啟用'},
  ], sub:[
    {k:'contextEngineering.strategies.compaction',l:'Compaction',fields:[
      {k:'enabled',t:'bool',l:'啟用'},
      {k:'model',t:'text',l:'Model'},
      {k:'triggerTurns',t:'num',l:'Trigger Turns'},
      {k:'preserveRecentTurns',t:'num',l:'Preserve Recent Turns'},
    ]},
    {k:'contextEngineering.strategies.budgetGuard',l:'Budget Guard',fields:[
      {k:'enabled',t:'bool',l:'啟用'},
      {k:'maxUtilization',t:'num',l:'Max Utilization',step:'0.01'},
      {k:'contextWindowTokens',t:'num',l:'Context Window Tokens'},
    ]},
    {k:'contextEngineering.strategies.slidingWindow',l:'Sliding Window',fields:[
      {k:'enabled',t:'bool',l:'啟用'},
      {k:'maxTurns',t:'num',l:'Max Turns'},
    ]},
  ]},
  { key:'inboundHistory', label:'Inbound History', fields:[
    {k:'inboundHistory.enabled',t:'bool',l:'啟用'},
    {k:'inboundHistory.fullWindowHours',t:'num',l:'Full Window (hours)'},
    {k:'inboundHistory.decayWindowHours',t:'num',l:'Decay Window (hours)'},
    {k:'inboundHistory.bucketBTokenCap',t:'num',l:'Bucket B Token Cap'},
    {k:'inboundHistory.decayIITokenCap',t:'num',l:'Decay II Token Cap'},
    {k:'inboundHistory.inject.enabled',t:'bool',l:'Inject Enabled'},
  ]},
  { key:'homeClaudeCode', label:'Home Claude Code', fields:[
    {k:'homeClaudeCode.enabled',t:'bool',l:'啟用'},
    {k:'homeClaudeCode.path',t:'text',l:'Path'},
  ]},
  { key:'dashboard', label:'Dashboard', fields:[
    {k:'dashboard.enabled',t:'bool',l:'啟用'},
    {k:'dashboard.port',t:'num',l:'Port'},
  ]},
  { key:'toolBudget', label:'Tool Budget', fields:[
    {k:'toolBudget.resultTokenCap',t:'num',l:'Result Token Cap'},
    {k:'toolBudget.perTurnTotalCap',t:'num',l:'Per Turn Total Cap'},
    {k:'toolBudget.toolTimeoutMs',t:'num',l:'Tool Timeout (ms)'},
  ]},
  { key:'subagents', label:'Subagents', fields:[
    {k:'subagents.maxConcurrent',t:'num',l:'Max Concurrent'},
    {k:'subagents.defaultTimeoutMs',t:'num',l:'Default Timeout (ms)'},
    {k:'subagents.defaultKeepSession',t:'bool',l:'Default Keep Session'},
  ]},
  { key:'rateLimit', label:'Rate Limit', dynamic:true, dynamicPath:'rateLimit', entryFields:[
    {k:'requestsPerMinute',t:'num',l:'Requests Per Minute'},
  ]},
  { key:'mcpServers', label:'MCP Servers', dynamic:true, dynamicPath:'mcpServers', entryFields:[
    {k:'command',t:'text',l:'Command'},
    {k:'args',t:'list',l:'Args'},
    {k:'tier',t:'select',l:'Tier',opts:['public','standard','elevated','admin','owner']},
  ]},
];

// ── 工具函式 ──
function getPath(obj, path) {
  return path.split('.').reduce((o, k) => o?.[k], obj);
}
function setPath(obj, path, val) {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] == null) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = val;
}

// ── 表單欄位渲染 ──
function renderField(f, val, prefix) {
  const id = prefix + '__' + f.k;
  const v = val ?? '';
  const hint = f.d ? \`<span class="cfg-hint" title="\${esc(f.d)}">ℹ️ \${f.d}</span>\` : '';
  if (f.t === 'bool') {
    return \`<div class="cfg-row"><label>\${f.l}\${hint}</label><label class="cfg-toggle"><input type="checkbox" data-path="\${id}" \${v ? 'checked' : ''}><span class="slider"></span></label></div>\`;
  }
  if (f.t === 'select') {
    const opts = (f.opts||[]).map(o => \`<option value="\${o}" \${v===o?'selected':''}>\${o||'(auto)'}</option>\`).join('');
    return \`<div class="cfg-row"><label>\${f.l}\${hint}</label><select data-path="\${id}">\${opts}</select></div>\`;
  }
  if (f.t === 'list') {
    const items = Array.isArray(val) ? val : [];
    const rows = items.map((item, i) =>
      \`<div class="cfg-list-item"><input value="\${esc(item)}" data-path="\${id}[\${i}]"><button class="btn-x" onclick="this.parentElement.remove()">✕</button></div>\`
    ).join('');
    return \`<div class="cfg-row" style="align-items:start"><label>\${f.l}\${hint}</label><div class="cfg-list" id="list_\${id}">\${rows}<button class="cfg-add" onclick="addListItem('list_\${id}','\${id}')">+ 新增</button></div></div>\`;
  }
  const inputType = f.t === 'pw' ? 'password' : f.t === 'num' ? 'number' : 'text';
  const step = f.step ? \` step="\${f.step}"\` : '';
  return \`<div class="cfg-row"><label>\${f.l}\${hint}</label><input type="\${inputType}" data-path="\${id}" value="\${esc(String(v ?? ''))}"\${step}></div>\`;
}

function esc(s) { return s.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;'); }

function addListItem(containerId, pathPrefix) {
  const c = document.getElementById(containerId);
  const items = c.querySelectorAll('.cfg-list-item');
  const idx = items.length;
  const div = document.createElement('div');
  div.className = 'cfg-list-item';
  div.innerHTML = \`<input value="" data-path="\${pathPrefix}[\${idx}]"><button class="btn-x" onclick="this.parentElement.remove()">✕</button>\`;
  c.insertBefore(div, c.querySelector('.cfg-add'));
}

// ── Map 欄位（key→value） ──
function renderMap(m, data, prefix) {
  const obj = getPath(data, m.k) || {};
  const id = prefix + '__' + m.k.replace(/\\./g,'_');
  let rows = Object.entries(obj).map(([k,v]) =>
    \`<div class="cfg-map-row"><input value="\${esc(k)}" class="map-key" placeholder="key"><input value="\${esc(String(v))}" class="map-val" placeholder="value"><button class="btn-x" onclick="this.parentElement.remove()">✕</button></div>\`
  ).join('');
  return \`<div class="cfg-row" style="align-items:start"><label>\${m.l}</label><div class="cfg-map" id="map_\${id}" data-map-path="\${m.k}">\${rows}<button class="cfg-add" onclick="addMapRow('map_\${id}')">+ 新增</button></div></div>\`;
}

function addMapRow(containerId) {
  const c = document.getElementById(containerId);
  const div = document.createElement('div');
  div.className = 'cfg-map-row';
  div.innerHTML = '<input value="" class="map-key" placeholder="key"><input value="" class="map-val" placeholder="value"><button class="btn-x" onclick="this.parentElement.remove()">✕</button>';
  c.insertBefore(div, c.querySelector('.cfg-add'));
}

// ── Sub section ──
function renderSub(s, data) {
  const subData = getPath(data, s.k) || {};
  const fields = (s.fields||[]).map(f => renderField(f, subData[f.k], s.k)).join('');
  return \`<div class="cfg-sub"><div style="font-size:0.78rem;color:#818cf8;margin-bottom:6px;font-weight:bold">\${s.l}</div>\${fields}</div>\`;
}

// ── Dynamic entries (providers, guilds, mcpServers, rateLimit) ──
function renderDynamic(section, data) {
  const path = section.dynamicPath || section.key;
  const obj = getPath(data, path) || {};
  let html = '';
  const secId = path.replace(/\\./g, '_');
  for (const [entryKey, entryVal] of Object.entries(obj)) {
    const ev = entryVal || {};
    let fieldsHtml = (section.entryFields||[]).map(f => renderField(f, ev[f.k], path+'.'+entryKey)).join('');
    // Guilds 有 channels 子區塊
    if (section.hasChannels && ev.channels) {
      let chHtml = '';
      for (const [chId, chVal] of Object.entries(ev.channels)) {
        const cv = chVal || {};
        const chFields = (section.channelFields||[]).map(f => renderField(f, cv[f.k], path+'.'+entryKey+'.channels.'+chId)).join('');
        chHtml += \`<div class="cfg-dynamic-entry" style="background:#0f1117"><div class="entry-header"><span style="color:#60a5fa;font-size:0.75rem">📌 Channel</span><input value="\${esc(chId)}" class="dyn-key" style="font-size:0.75rem" disabled></div>\${chFields}</div>\`;
      }
      fieldsHtml += \`<div class="cfg-sub"><div style="font-size:0.75rem;color:#60a5fa;margin-bottom:6px">Channels</div>\${chHtml}</div>\`;
    }
    html += \`<div class="cfg-dynamic-entry" id="dyn_\${secId}_\${esc(entryKey)}"><div class="entry-header"><span style="color:#a78bfa;font-size:0.75rem">🔑</span><input value="\${esc(entryKey)}" class="dyn-key" disabled style="color:#a78bfa;background:transparent;border:none;font-size:0.82rem;flex:1"><button class="btn btn-red btn-sm" onclick="removeDynEntry('\${secId}','\${esc(entryKey)}',this)">刪除</button></div>\${fieldsHtml}</div>\`;
  }
  html += \`<div style="margin-top:8px"><input id="new_dyn_\${secId}" placeholder="新 ID" style="background:#0f1117;color:#e0e0e0;border:1px solid #2a2d3e;border-radius:4px;padding:4px 8px;font-size:0.78rem;font-family:monospace;width:200px"><button class="cfg-add" style="margin-left:8px" onclick="addDynEntry('\${secId}','\${path}')">+ 新增</button></div>\`;
  return html;
}

function addDynEntry(secId, path) {
  const input = document.getElementById('new_dyn_' + secId);
  const id = input.value.trim();
  if (!id) return;
  // 在 _cfgData 中加入空 entry，重新渲染整個 config GUI
  const obj = getPath(_cfgData, path) || {};
  obj[id] = {};
  setPath(_cfgData, path, obj);
  input.value = '';
  document.getElementById('cfg-gui').innerHTML = renderConfigGUI(_cfgData);
}

function removeDynEntry(secId, key, btn) {
  if (!confirm('確定刪除 ' + key + '？')) return;
  btn.closest('.cfg-dynamic-entry').remove();
  // 同步從 _cfgData 移除
  const path = secId.replace(/_/g, '.');
  const obj = getPath(_cfgData, path);
  if (obj) delete obj[key];
}

// ── 完整 GUI 渲染 ──
function renderConfigGUI(data) {
  let html = '';
  for (const sec of CFG_SCHEMA) {
    let content = '';
    // 一般欄位
    if (sec.fields) {
      content += sec.fields.map(f => {
        const val = f.k.includes('.') ? getPath(data, f.k) : data[f.k];
        return renderField(f, val, sec.key);
      }).join('');
    }
    // Maps
    if (sec.maps) content += sec.maps.map(m => renderMap(m, data, sec.key)).join('');
    // Sub sections
    if (sec.sub) content += sec.sub.map(s => renderSub(s, data)).join('');
    // Dynamic entries
    if (sec.dynamic) content += renderDynamic(sec, data);

    html += \`<details class="cfg-section" \${sec.key==='_basic'?'open':''}><summary>\${sec.label}</summary><div class="cfg-fields">\${content}</div></details>\`;
  }
  return html;
}

// ── 收集表單值回 JSON ──
function collectConfigJSON() {
  const result = JSON.parse(JSON.stringify(_cfgData)); // deep clone
  // 收集所有 data-path input/select/checkbox
  document.querySelectorAll('#cfg-gui [data-path]').forEach(el => {
    const rawPath = el.dataset.path;
    // 跳過 dynamic entry 中的 list index — 由 list 收集器處理
    const listMatch = rawPath.match(/^(.+)\\[(\\d+)\\]\$/);
    if (listMatch) return; // list items 下面統一處理

    // 將 section__key 轉回 dot path
    const path = rawPath.replace(/__/g, '.');
    let val;
    if (el.type === 'checkbox') val = el.checked;
    else if (el.type === 'number') val = el.value === '' ? undefined : Number(el.value);
    else val = el.value;
    if (val !== undefined && val !== '') setPath(result, path, val);
  });

  // 收集 list 欄位
  document.querySelectorAll('#cfg-gui .cfg-list').forEach(listEl => {
    const items = listEl.querySelectorAll('.cfg-list-item input');
    const firstItem = items[0];
    if (!firstItem) return;
    const basePath = firstItem.dataset.path.replace(/\\[\\d+\\]\$/, '').replace(/__/g, '.');
    const arr = Array.from(items).map(i => i.value).filter(v => v !== '');
    setPath(result, basePath, arr);
  });

  // 收集 map 欄位
  document.querySelectorAll('#cfg-gui .cfg-map').forEach(mapEl => {
    const path = mapEl.dataset.mapPath;
    const obj = {};
    mapEl.querySelectorAll('.cfg-map-row').forEach(row => {
      const k = row.querySelector('.map-key')?.value;
      const v = row.querySelector('.map-val')?.value;
      if (k) obj[k] = v;
    });
    setPath(result, path, obj);
  });

  return result;
}

async function loadCfg() {
  try {
    const text = await fetch('/api/config').then(r => r.text());
    _cfgData = JSON.parse(text);
    document.getElementById('cfg-gui').innerHTML = renderConfigGUI(_cfgData);
    showCfgMsg('', true);
  } catch(e) { showCfgMsg('讀取失敗：' + e, false); }
}

async function saveCfg() {
  if (!_cfgData) { showCfgMsg('請先讀取 config', false); return; }
  try {
    const body = JSON.stringify(collectConfigJSON(), null, 2);
    const d = await fetch('/api/config',{method:'POST',headers:{'Content-Type':'application/json'},body}).then(r=>r.json());
    showCfgMsg(d.success ? '✓ 已備份並儲存' : '錯誤：' + d.error, d.success);
  } catch(e) { showCfgMsg('儲存失敗：' + e, false); }
}

function showCfgMsg(msg, ok) {
  const el = document.getElementById('cfg-msg');
  el.className = 'msg ' + (ok ? 'ok' : 'err');
  el.textContent = msg;
}

// ── Auth Profiles ────────────────────────────────────────────────────────────
async function loadAuthProfiles() {
  try {
    const d = await fetch('/api/auth-profiles').then(r => r.json());
    // 憑證列表
    const credsHtml = (d.credentials||[]).map(c =>
      \`<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;padding:6px;background:#161827;border-radius:4px">
        <span style="font-weight:bold;color:#a78bfa;min-width:80px">\${c.id}</span>
        <code style="flex:1;font-size:0.75rem;color:#888">\${c.credential}</code>
        <button class="btn btn-red btn-sm" onclick="removeAuthProfile('\${c.id}')">刪除</button>
      </div>\`
    ).join('') || '<p style="color:#888;font-size:0.8rem">無憑證</p>';
    document.getElementById('auth-creds').innerHTML = credsHtml;

    // Provider 狀態
    let statusHtml = '';
    for (const [providerId, profiles] of Object.entries(d.statuses||{})) {
      const rows = (profiles||[]).map(p => {
        const lu = p.lastUsed ? new Date(p.lastUsed).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false}) : '-';
        const cd = p.cooldownUntil > Date.now() ? new Date(p.cooldownUntil).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false}) : '-';
        const status = p.disabled ? '<span class="badge badge-err">停用</span>'
          : p.cooldownUntil > Date.now() ? \`<span class="badge badge-run">CD: \${p.cooldownReason||'?'}</span>\`
          : '<span class="badge badge-done">可用</span>';
        const clearBtn = (p.disabled || p.cooldownUntil > Date.now())
          ? \`<button class="btn btn-sm" onclick="clearCooldown('\${providerId}','\${p.id}')">解除</button>\` : '';
        return \`<tr><td>\${p.id}</td><td>\${status}</td><td>\${lu}</td><td>\${cd}</td><td>\${clearBtn}</td></tr>\`;
      }).join('');
      statusHtml += \`<h3 style="font-size:0.82rem;color:#a78bfa;margin:12px 0 6px">Provider: \${providerId}</h3>
        <table class="tbl"><thead><tr><th>ID</th><th>狀態</th><th>Last Used</th><th>Cooldown Until</th><th></th></tr></thead><tbody>\${rows}</tbody></table>\`;
    }
    document.getElementById('auth-statuses').innerHTML = statusHtml || '<p style="color:#888;font-size:0.8rem">無 provider 狀態</p>';
    document.getElementById('auth-msg').textContent = '';
  } catch(e) { document.getElementById('auth-msg').className = 'msg err'; document.getElementById('auth-msg').textContent = '讀取失敗：' + e; }
}

async function addAuthProfile() {
  const id = document.getElementById('auth-new-id').value.trim();
  const cred = document.getElementById('auth-new-cred').value.trim();
  if (!id || !cred) { document.getElementById('auth-msg').className = 'msg err'; document.getElementById('auth-msg').textContent = 'ID 和 Credential 都要填'; return; }
  try {
    const d = await fetch('/api/auth-profiles',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'add',id,credential:cred})}).then(r=>r.json());
    if (d.success) { document.getElementById('auth-new-id').value = ''; document.getElementById('auth-new-cred').value = ''; loadAuthProfiles(); }
    else { document.getElementById('auth-msg').className = 'msg err'; document.getElementById('auth-msg').textContent = d.error; }
  } catch(e) { document.getElementById('auth-msg').className = 'msg err'; document.getElementById('auth-msg').textContent = '失敗：' + e; }
}

async function removeAuthProfile(id) {
  if (!confirm(\`確定刪除憑證 \${id}？\`)) return;
  try {
    await fetch('/api/auth-profiles',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'remove',id})});
    loadAuthProfiles();
  } catch(e) { document.getElementById('auth-msg').className = 'msg err'; document.getElementById('auth-msg').textContent = '失敗：' + e; }
}

async function clearCooldown(providerId, profileId) {
  try {
    await fetch('/api/auth-profiles/clear-cooldown',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({providerId,profileId})});
    loadAuthProfiles();
  } catch(e) { document.getElementById('auth-msg').className = 'msg err'; document.getElementById('auth-msg').textContent = '失敗：' + e; }
}

// ── 初始化 ───────────────────────────────────────────────────────────────────
loadOverview();
loadStatus();
setInterval(loadStatus, 30000);
</script>
</body>
</html>`;

// ── DashboardServer ───────────────────────────────────────────────────────────

export class DashboardServer {
  private port: number;

  constructor(port = 8088) {
    this.port = port;
  }

  start(): void {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = req.url ?? "/";
      const method = req.method ?? "GET";

      if (url === "/" || url === "/index.html") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(HTML);
        return;
      }

      // GET /api/usage
      if (url.startsWith("/api/usage")) {
        const daysMatch = url.match(/[?&]days=(\d+)/);
        const days = daysMatch ? parseInt(daysMatch[1]!, 10) : 7;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(buildApiData(days)));
        return;
      }

      // GET /api/sessions
      if (url === "/api/sessions" && method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(buildSessionsData()));
        return;
      }

      // GET /api/status
      if (url === "/api/status" && method === "GET") {
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

      // GET /api/logs
      if (url.startsWith("/api/logs") && method === "GET") {
        const linesMatch = url.match(/[?&]lines=(\d+)/);
        const lines = linesMatch ? parseInt(linesMatch[1]!, 10) : 100;
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(tailLog(lines));
        return;
      }

      // POST /api/restart
      if (url === "/api/restart" && method === "POST") {
        const ok = touchRestart();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(ok ? { success: true } : { success: false, error: "signal/RESTART not found" }));
        return;
      }

      // GET /api/cron
      if (url === "/api/cron" && method === "GET") {
        void (async () => {
          try {
            const { getCronStorePath } = await import("../cron.js");
            const p = getCronStorePath();
            const data = existsSync(p) ? JSON.parse(readFileSync(p, "utf-8")) : { version: 1, jobs: {} };
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ jobs: (data.jobs ?? {}) }));
          } catch (err) { res.writeHead(500); res.end(JSON.stringify({ error: String(err) })); }
        })();
        return;
      }

      // POST /api/cron, /api/cron/delete, /api/cron/trigger, /api/cron/toggle
      if (url.startsWith("/api/cron") && method === "POST") {
        const chunks: Buffer[] = [];
        let sz = 0;
        req.on("data", (c: Buffer) => { sz += c.length; if (sz < 131072) chunks.push(c); });
        req.on("end", () => {
          void (async () => {
            try {
              const body = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as Record<string, unknown>;
              const { getCronStorePath } = await import("../cron.js");
              const p = getCronStorePath();
              const store = existsSync(p) ? JSON.parse(readFileSync(p, "utf-8")) : { version: 1, jobs: {} };
              const jobs = store.jobs as Record<string, Record<string, unknown>>;

              if (url === "/api/cron") {
                // create
                const id = `job-${Date.now()}`;
                jobs[id] = body as Record<string, unknown>;
              } else if (url === "/api/cron/delete") {
                const id = String(body["id"] ?? "");
                if (!jobs[id]) throw new Error(`Job not found: ${id}`);
                delete jobs[id];
              } else if (url === "/api/cron/trigger") {
                const id = String(body["id"] ?? "");
                if (!jobs[id]) throw new Error(`Job not found: ${id}`);
                jobs[id]!["nextRunAtMs"] = Date.now() - 1;
              } else if (url === "/api/cron/toggle") {
                const id = String(body["id"] ?? "");
                if (!jobs[id]) throw new Error(`Job not found: ${id}`);
                jobs[id]!["enabled"] = Boolean(body["enabled"]);
              }

              const tmp = p + ".tmp";
              writeFileSync(tmp, JSON.stringify(store, null, 2), "utf-8");
              renameSync(tmp, p);
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ success: true }));
            } catch (err) {
              res.writeHead(400); res.end(JSON.stringify({ success: false, error: String(err) }));
            }
          })();
        });
        return;
      }

      // GET /api/subagents
      if (url === "/api/subagents" && method === "GET") {
        void (async () => {
          try {
            const { getSubagentRegistry } = await import("./subagent-registry.js");
            const reg = getSubagentRegistry();
            const all = reg ? Array.from(reg["records"].values() as IterableIterator<Record<string, unknown>>) : [];
            const subagents = (all as Record<string, unknown>[]).map(r => ({
              runId: r["runId"], label: r["label"], status: r["status"],
              turns: r["turns"], createdAt: r["createdAt"], endedAt: r["endedAt"],
              task: r["task"], parentSessionKey: r["parentSessionKey"],
            }));
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ subagents }));
          } catch (err) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ subagents: [], error: String(err) }));
          }
        })();
        return;
      }

      // POST /api/subagents/kill
      if (url === "/api/subagents/kill" && method === "POST") {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          void (async () => {
            try {
              const { runId } = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as { runId: string };
              const { getSubagentRegistry } = await import("./subagent-registry.js");
              const reg = getSubagentRegistry();
              const ok = reg ? reg.kill(runId) : false;
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify(ok ? { success: true } : { success: false, error: "not found or not running" }));
            } catch (err) {
              res.writeHead(400); res.end(JSON.stringify({ success: false, error: String(err) }));
            }
          })();
        });
        return;
      }

      // GET /api/config — 回傳 runtime config（含 defaults），確保 GUI 顯示正確狀態
      if (url === "/api/config" && method === "GET") {
        void (async () => {
          try {
            const { config: runtimeConfig } = await import("./config.js");
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(maskConfig(runtimeConfig), null, 2));
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
              const { resolveConfigPath } = await import("./config.js");
              const cp = resolveConfigPath();
              // 讀取原始 config，將 *** 還原為原始值
              const originalRaw = JSON.parse(readFileSync(cp, "utf-8")) as unknown;
              const restored = restoreMasked(parsed, originalRaw) as Record<string, unknown>;
              const discord = restored?.discord as Record<string, unknown> | undefined;
              if (!discord?.token) throw new Error("缺少必要欄位 discord.token");
              backupConfig(cp);
              const tmp = cp + ".tmp";
              writeFileSync(tmp, JSON.stringify(restored, null, 2), "utf-8");
              renameSync(tmp, cp);
              res.writeHead(200); res.end(JSON.stringify({ success: true }));
            } catch (err) {
              res.writeHead(400); res.end(JSON.stringify({ error: String(err) }));
            }
          })();
        });
        return;
      }

      // GET /api/auth-profiles
      if (url === "/api/auth-profiles" && method === "GET") {
        void (async () => {
          try {
            const { resolveWorkspaceDirSafe } = await import("./config.js");
            const ws = resolveWorkspaceDirSafe();
            const credPath = join(ws, "agents", "default", "auth-profile.json");
            const creds: Array<{ id: string; credential: string }> = existsSync(credPath)
              ? JSON.parse(readFileSync(credPath, "utf-8"))
              : [];
            // 遮罩 credential
            const masked = creds.map(c => ({
              id: c.id,
              credential: c.credential ? c.credential.slice(0, 12) + "..." + c.credential.slice(-4) : "",
            }));
            // 讀取各 provider 的 profiles 狀態
            const profilesDir = join(ws, "data", "auth-profiles");
            const statuses: Record<string, unknown[]> = {};
            if (existsSync(profilesDir)) {
              for (const f of readdirSync(profilesDir).filter(f => f.endsWith("-profiles.json"))) {
                try {
                  const data = JSON.parse(readFileSync(join(profilesDir, f), "utf-8"));
                  const providerId = data.providerId ?? f.replace("-profiles.json", "");
                  statuses[providerId] = (data.profiles ?? []).map((p: Record<string, unknown>) => ({
                    id: p.id, lastUsed: p.lastUsed, cooldownUntil: p.cooldownUntil,
                    cooldownReason: p.cooldownReason, disabled: p.disabled,
                  }));
                } catch { /* skip */ }
              }
            }
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ credentials: masked, statuses, credentialsPath: credPath }));
          } catch (err) {
            res.writeHead(500); res.end(JSON.stringify({ error: String(err) }));
          }
        })();
        return;
      }

      // POST /api/auth-profiles (新增/刪除 credential)
      if (url === "/api/auth-profiles" && method === "POST") {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          void (async () => {
            try {
              const { resolveWorkspaceDirSafe } = await import("./config.js");
              const ws = resolveWorkspaceDirSafe();
              const credPath = join(ws, "agents", "default", "auth-profile.json");
              const body = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as {
                action: "add" | "remove" | "set";
                id?: string;
                credential?: string;
                credentials?: Array<{ id: string; credential: string }>;
              };
              let creds: Array<{ id: string; credential: string }> = existsSync(credPath)
                ? JSON.parse(readFileSync(credPath, "utf-8"))
                : [];
              if (body.action === "add" && body.id && body.credential) {
                const existing = creds.find(c => c.id === body.id);
                if (existing) existing.credential = body.credential;
                else creds.push({ id: body.id, credential: body.credential });
              } else if (body.action === "remove" && body.id) {
                creds = creds.filter(c => c.id !== body.id);
              } else if (body.action === "set" && body.credentials) {
                creds = body.credentials;
              } else {
                throw new Error("無效操作");
              }
              mkdirSync(dirname(credPath), { recursive: true });
              const tmp = credPath + ".tmp";
              writeFileSync(tmp, JSON.stringify(creds, null, 2), "utf-8");
              renameSync(tmp, credPath);
              res.writeHead(200); res.end(JSON.stringify({ success: true, count: creds.length }));
            } catch (err) {
              res.writeHead(400); res.end(JSON.stringify({ error: String(err) }));
            }
          })();
        });
        return;
      }

      // POST /api/auth-profiles/clear-cooldown
      if (url === "/api/auth-profiles/clear-cooldown" && method === "POST") {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          void (async () => {
            try {
              const { resolveWorkspaceDirSafe } = await import("./config.js");
              const ws = resolveWorkspaceDirSafe();
              const body = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as { providerId: string; profileId: string };
              const fp = join(ws, "data", "auth-profiles", `${body.providerId}-profiles.json`);
              if (!existsSync(fp)) throw new Error("Profile 不存在");
              const data = JSON.parse(readFileSync(fp, "utf-8"));
              const profile = (data.profiles ?? []).find((p: Record<string, unknown>) => p.id === body.profileId);
              if (!profile) throw new Error("Profile ID 不存在");
              profile.cooldownUntil = 0;
              profile.cooldownReason = undefined;
              profile.disabled = false;
              const tmp = fp + ".tmp";
              writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
              renameSync(tmp, fp);
              res.writeHead(200); res.end(JSON.stringify({ success: true }));
            } catch (err) {
              res.writeHead(400); res.end(JSON.stringify({ error: String(err) }));
            }
          })();
        });
        return;
      }

      res.writeHead(404); res.end("Not found");
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
