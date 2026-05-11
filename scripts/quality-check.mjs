#!/usr/bin/env node
/**
 * quality-check.mjs — CatClaw 執行品質自檢
 *
 * 掃 ~/.catclaw/workspace/data/traces/*.jsonl，找出幻覺/異常 pattern。
 *
 * 用法：
 *   node scripts/quality-check.mjs                  # 最近 7 天，Markdown
 *   node scripts/quality-check.mjs --days 30        # 最近 30 天
 *   node scripts/quality-check.mjs --channel 12345  # 過濾 channel
 *   node scripts/quality-check.mjs --json           # JSON 輸出
 *   node scripts/quality-check.mjs --min med        # 只顯示 med/high 嚴重度
 *
 * 偵測規則：
 *   R1 empty-result-confident   HIGH  — tool 全 empty 但 LLM 仍下確定結論
 *   R2 externalization-recursion HIGH — 讀外部化檔得到再轉義內容（套娃 bug）
 *   R3 cross-turn-repeat        MED   — 同 tool+params 在單 trace 內 ≥3 次
 *   R4 output-size-anomaly      MED   — 同 tool 結果 size 偏離 session 中位數 ≥5×
 *   R5 tool-error-ignored       MED   — tool exitCode≠0 但下一輪沒重試/換路
 *
 * Exit code: 0 = 無 HIGH；1 = 有 HIGH
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

// ── CLI ──────────────────────────────────────────────────────────────────────

const args = parseArgs(process.argv.slice(2));
const DAYS = Number(args.days ?? 7);
const CHANNEL = args.channel ?? null;
const JSON_OUT = !!args.json;
const MIN_SEVERITY = args["min"] ?? "low"; // low | med | high
const TRACES_DIR = join(
  process.env.CATCLAW_HOME ?? join(homedir(), ".catclaw"),
  "workspace", "data", "traces",
);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) { out[key] = next; i++; }
      else out[key] = true;
    }
  }
  return out;
}

// ── 載入 trace ───────────────────────────────────────────────────────────────

function loadTraces() {
  if (!safeExists(TRACES_DIR)) {
    fail(`Traces dir not found: ${TRACES_DIR}`);
  }
  const cutoffMs = Date.now() - DAYS * 86400_000;
  const traces = [];
  for (const f of readdirSync(TRACES_DIR).sort()) {
    if (!f.endsWith(".jsonl")) continue;
    const fp = join(TRACES_DIR, f);
    const stat = statSync(fp);
    if (stat.mtimeMs < cutoffMs) continue;
    const txt = readFileSync(fp, "utf-8");
    for (const line of txt.split("\n")) {
      if (!line.trim()) continue;
      try {
        const t = JSON.parse(line);
        if (CHANNEL && !String(t.channelId ?? "").includes(CHANNEL)) continue;
        const ts = Date.parse(t.ts ?? "");
        if (Number.isFinite(ts) && ts < cutoffMs) continue;
        traces.push({ ...t, _sourceFile: f });
      } catch { /* skip malformed */ }
    }
  }
  return traces;
}

function safeExists(p) { try { statSync(p); return true; } catch { return false; } }
function fail(msg) { console.error(`[quality-check] ${msg}`); process.exit(2); }

// ── 規則引擎 ─────────────────────────────────────────────────────────────────

const SEVERITY_RANK = { low: 0, med: 1, high: 2 };

function emptyResult(rp) {
  if (typeof rp !== "string") return false;
  return (
    /"total"\s*:\s*0/.test(rp) ||
    /"matches"\s*:\s*\[\s*\]/.test(rp) ||
    /"paths"\s*:\s*\[\s*\]/.test(rp) ||
    /"hits"\s*:\s*\[\s*\]/.test(rp) ||
    /"returned"\s*:\s*0/.test(rp)
  );
}

function isExitNonZero(rp) {
  if (typeof rp !== "string") return false;
  const m = rp.match(/"exitCode"\s*:\s*(-?\d+)/);
  return m ? Number(m[1]) !== 0 : false;
}

function paramsHash(name, params) {
  return createHash("sha1").update(`${name}|${String(params ?? "")}`).digest("hex").slice(0, 12);
}

/** R1: 所有 iter 的工具都回 empty / 0 results，但 LLM 最終 response > 200 字且 stopReason=end_turn */
function detectEmptyConfident(trace) {
  const findings = [];
  const calls = trace.llmCalls ?? [];
  if (calls.length === 0) return findings;
  const last = calls[calls.length - 1];
  if (last.stopReason !== "end_turn") return findings;
  const responsePreview = trace.response?.textPreview ?? "";
  const responseLen = trace.response?.charCount ?? responsePreview.length;
  if (responseLen < 200) return findings;

  const allTools = calls.flatMap(c => c.toolCalls ?? []);
  if (allTools.length < 2) return findings; // 太少不算

  const emptyCount = allTools.filter(tc => emptyResult(tc.resultPreview)).length;
  const ratio = emptyCount / allTools.length;
  if (ratio < 0.6) return findings;

  // 確信語氣（中文無 word boundary，英文用 \b）
  const zhConfident = /(有的|找到|完整紀錄|已經有|盤點完|沒問題|確認過|的確|事實上)/.test(responsePreview);
  const enConfident = /\b(done|found|complete|verified|confirmed|exists)\b/i.test(responsePreview);
  const confident = zhConfident || enConfident;
  if (!confident) return findings;

  findings.push({
    rule: "empty-result-confident",
    severity: "high",
    traceId: trace.traceId,
    detail: `${emptyCount}/${allTools.length} 工具回空，response ${responseLen} 字仍下確定結論`,
    sample: responsePreview.slice(0, 120),
  });
  return findings;
}

/** R2: 讀 tool-outputs/ 路徑 → 結果裡含過度轉義（`\\\"` 以上） */
function detectExternalizationRecursion(trace) {
  const findings = [];
  for (let i = 0; i < (trace.llmCalls ?? []).length; i++) {
    const c = trace.llmCalls[i];
    for (const tc of c.toolCalls ?? []) {
      if (tc.name !== "read_file" && tc.name !== "run_command") continue;
      const p = String(tc.paramsPreview ?? "");
      const r = String(tc.resultPreview ?? "");
      const readingExternalized = /tool-outputs\//.test(p);
      if (!readingExternalized) continue;
      // 偵測多層 escape: `\\\"` 或 `\\\\n`
      const hasDoubleEscape = /\\\\[\\"n]/.test(r) || /\\\\\\\\/.test(r);
      if (hasDoubleEscape) {
        findings.push({
          rule: "externalization-recursion",
          severity: "high",
          traceId: trace.traceId,
          detail: `iter ${i + 1} ${tc.name} 讀外部化檔取得多層轉義內容`,
          sample: p.slice(0, 120),
        });
      }
    }
  }
  return findings;
}

/** R3: 同 trace 內，相同 tool+params 出現 ≥3 次 */
function detectCrossTurnRepeat(trace) {
  const findings = [];
  const counter = new Map();
  for (let i = 0; i < (trace.llmCalls ?? []).length; i++) {
    for (const tc of trace.llmCalls[i].toolCalls ?? []) {
      const key = paramsHash(tc.name, tc.paramsPreview);
      const rec = counter.get(key) ?? { count: 0, sample: tc.paramsPreview ?? "", name: tc.name, iters: [] };
      rec.count++;
      rec.iters.push(i + 1);
      counter.set(key, rec);
    }
  }
  for (const rec of counter.values()) {
    if (rec.count >= 3) {
      findings.push({
        rule: "cross-turn-repeat",
        severity: "med",
        traceId: trace.traceId,
        detail: `${rec.name} 重複 ${rec.count} 次（iters: ${rec.iters.join(",")}）`,
        sample: String(rec.sample).slice(0, 120),
      });
    }
  }
  return findings;
}

/** R4: 同 trace 內、同 tool 結果 length 中位數對比，最大偏離 ≥5× 視為異常 */
function detectOutputSizeAnomaly(trace) {
  const findings = [];
  const byTool = new Map();
  for (let i = 0; i < (trace.llmCalls ?? []).length; i++) {
    for (const tc of trace.llmCalls[i].toolCalls ?? []) {
      const arr = byTool.get(tc.name) ?? [];
      arr.push({ iter: i + 1, len: String(tc.resultPreview ?? "").length });
      byTool.set(tc.name, arr);
    }
  }
  for (const [tool, arr] of byTool) {
    if (arr.length < 4) continue;
    const sorted = arr.map(x => x.len).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    if (median < 50) continue; // 過小避免 noise
    for (const r of arr) {
      const ratio = r.len / median;
      if (ratio >= 5 || (median / Math.max(r.len, 1)) >= 5) {
        findings.push({
          rule: "output-size-anomaly",
          severity: "med",
          traceId: trace.traceId,
          detail: `${tool} iter ${r.iter} size ${r.len}，session 中位數 ${median}（偏離 ${ratio.toFixed(1)}×）`,
          sample: `tool=${tool}`,
        });
        break; // 一個 tool 報一次
      }
    }
  }
  return findings;
}

/** R5: tool exitCode≠0，但下一輪沒重試該 tool（heuristic：下一 iter 不存在 OR 用 end_turn 收掉） */
function detectToolErrorIgnored(trace) {
  const findings = [];
  const calls = trace.llmCalls ?? [];
  for (let i = 0; i < calls.length; i++) {
    for (const tc of calls[i].toolCalls ?? []) {
      if (!isExitNonZero(tc.resultPreview)) continue;
      const next = calls[i + 1];
      if (!next || next.stopReason === "end_turn") {
        const responsePreview = trace.response?.textPreview ?? "";
        const acknowledged = /(失敗|錯誤|exit|失|error|沒成功|fail)/i.test(responsePreview);
        if (!acknowledged) {
          findings.push({
            rule: "tool-error-ignored",
            severity: "med",
            traceId: trace.traceId,
            detail: `iter ${i + 1} ${tc.name} exit≠0，後續 ${next ? "結束" : "無下一輪"}，response 未承認失敗`,
            sample: String(tc.paramsPreview ?? "").slice(0, 120),
          });
        }
      }
    }
  }
  return findings;
}

const RULES = [
  detectEmptyConfident,
  detectExternalizationRecursion,
  detectCrossTurnRepeat,
  detectOutputSizeAnomaly,
  detectToolErrorIgnored,
];

// ── 跑分析 ──────────────────────────────────────────────────────────────────

function analyze(traces) {
  const findings = [];
  for (const t of traces) {
    for (const rule of RULES) {
      try {
        findings.push(...rule(t));
      } catch (err) {
        // 規則本身不能掛掉
        process.stderr.write(`[quality-check] rule ${rule.name} on ${t.traceId}: ${err.message}\n`);
      }
    }
  }
  return findings.filter(f => SEVERITY_RANK[f.severity] >= SEVERITY_RANK[MIN_SEVERITY]);
}

// ── 輸出 ─────────────────────────────────────────────────────────────────────

function formatMarkdown(findings, traceCount) {
  const lines = [];
  lines.push(`# CatClaw Quality Check`);
  lines.push("");
  lines.push(`- 掃描範圍：最近 ${DAYS} 天${CHANNEL ? `，channel filter=${CHANNEL}` : ""}`);
  lines.push(`- Trace 總數：${traceCount}`);
  lines.push(`- Findings：${findings.length}`);
  lines.push(`- 最小嚴重度：${MIN_SEVERITY}`);
  lines.push("");

  // 規則總覽
  const byRule = new Map();
  for (const f of findings) {
    const cur = byRule.get(f.rule) ?? { count: 0, severity: f.severity };
    cur.count++;
    byRule.set(f.rule, cur);
  }
  lines.push(`## 規則命中`);
  lines.push("");
  lines.push(`| Rule | Severity | Hits |`);
  lines.push(`|------|----------|------|`);
  for (const [rule, v] of [...byRule.entries()].sort((a, b) => b[1].count - a[1].count)) {
    lines.push(`| ${rule} | ${v.severity} | ${v.count} |`);
  }
  lines.push("");

  // 受影響 trace TOP
  const byTrace = new Map();
  for (const f of findings) {
    const cur = byTrace.get(f.traceId) ?? { count: 0, maxSev: "low", rules: new Set() };
    cur.count++;
    cur.rules.add(f.rule);
    if (SEVERITY_RANK[f.severity] > SEVERITY_RANK[cur.maxSev]) cur.maxSev = f.severity;
    byTrace.set(f.traceId, cur);
  }
  const topTraces = [...byTrace.entries()]
    .sort((a, b) => SEVERITY_RANK[b[1].maxSev] - SEVERITY_RANK[a[1].maxSev] || b[1].count - a[1].count)
    .slice(0, 10);
  if (topTraces.length > 0) {
    lines.push(`## 受影響 Trace TOP 10`);
    lines.push("");
    lines.push(`| TraceId | MaxSev | Findings | Rules |`);
    lines.push(`|---------|--------|----------|-------|`);
    for (const [id, v] of topTraces) {
      lines.push(`| \`${id.slice(0, 8)}\` | ${v.maxSev} | ${v.count} | ${[...v.rules].join(", ")} |`);
    }
    lines.push("");
  }

  // 明細
  lines.push(`## 明細（按嚴重度）`);
  lines.push("");
  const sorted = [...findings].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
  for (const f of sorted) {
    lines.push(`### [${f.severity.toUpperCase()}] ${f.rule} — \`${f.traceId.slice(0, 8)}\``);
    lines.push(`- ${f.detail}`);
    if (f.sample) lines.push(`- sample: \`${escapeMd(f.sample)}\``);
    lines.push("");
  }

  return lines.join("\n");
}

function escapeMd(s) {
  return String(s).replace(/`/g, "\\`").replace(/\n/g, " ");
}

// ── main ────────────────────────────────────────────────────────────────────

const traces = loadTraces();
const findings = analyze(traces);

if (JSON_OUT) {
  process.stdout.write(JSON.stringify({
    scannedDays: DAYS, channel: CHANNEL, traceCount: traces.length,
    findings,
  }, null, 2));
  process.stdout.write("\n");
} else {
  process.stdout.write(formatMarkdown(findings, traces.length));
  process.stdout.write("\n");
}

const hasHigh = findings.some(f => f.severity === "high");
process.exit(hasHigh ? 1 : 0);
