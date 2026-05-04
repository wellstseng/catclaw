/**
 * @file skills/builtin/guardian-export.ts
 * @description /guardian-export skill — 把 trace 中的 guardianHits 倒成 jsonl
 *              （項目 12 階段 1 補洞）
 *
 * 用途：
 *   階段 1 累積 ≥100 標註樣本後，匯出給階段 2 trajectory-fingerprint 訓練資料源。
 *
 * 用法：
 *   /guardian-export             → 匯出最近 500 筆 trace 的 guardianHits
 *   /guardian-export 2000        → 匯出最近 2000 筆 trace 的 guardianHits
 *
 * 輸出：~/.catclaw/workspace/data/guardian-hits-{ts}.jsonl
 *   每行一筆 { traceId, sessionKey, ts, rule, confidence, falsePositive?, detail? }
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Skill } from "../types.js";

export const skill: Skill = {
  name: "guardian-export",
  description:
    "匯出 trace 中所有 guardianHits 為 jsonl（項目 12 階段 1 → 階段 2 訓練資料源）",
  tier: "elevated",
  trigger: ["/guardian-export"],

  async execute({ args }) {
    const limit = (() => {
      const n = parseInt(args.trim(), 10);
      return Number.isFinite(n) && n > 0 ? n : 500;
    })();

    const { getTraceStore } = await import("../../core/message-trace.js");
    const store = getTraceStore();
    if (!store) {
      return { text: "❌ TraceStore 未初始化（platform 未就緒）", isError: true };
    }

    const traces = store.recent(limit, e => Array.isArray(e.guardianHits) && e.guardianHits.length > 0);

    if (traces.length === 0) {
      return { text: `📊 最近 ${limit} 筆 trace 中無 guardianHits 樣本（catclaw 仍須累積使用）` };
    }

    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const outDir = join(
      process.env["CATCLAW_HOME"] ?? join(homedir(), ".catclaw"),
      "workspace",
      "data",
    );
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
    const outPath = join(outDir, `guardian-hits-${ts}.jsonl`);

    let lines = 0;
    const out: string[] = [];
    for (const t of traces) {
      for (const hit of t.guardianHits ?? []) {
        out.push(
          JSON.stringify({
            traceId: t.traceId,
            sessionKey: t.sessionKey,
            channelId: t.channelId,
            accountId: t.accountId,
            ts: hit.ts,
            rule: hit.rule,
            confidence: hit.confidence,
            falsePositive: hit.falsePositive,
            detail: hit.detail,
          }),
        );
        lines++;
      }
    }

    writeFileSync(outPath, out.join("\n") + "\n", "utf-8");

    const labeledCount = traces.reduce(
      (sum, t) => sum + (t.guardianHits ?? []).filter(h => h.falsePositive != null).length,
      0,
    );

    return {
      text:
        `📊 Guardian Hits 匯出完成\n` +
        `\n` +
        `- 來源：最近 ${limit} 筆 trace（${traces.length} 筆有命中）\n` +
        `- 樣本數：${lines}（其中 ${labeledCount} 筆已標 正確/誤報）\n` +
        `- 輸出：\`${outPath}\`\n` +
        `\n` +
        `用於項目 12 階段 2 trajectory-fingerprint 訓練資料源。\n` +
        `階段 2 啟動條件：≥100 標註樣本（驗證/訓練 80/20）。`,
    };
  },
};
