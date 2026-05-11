/**
 * @file workflow/consolidate-scheduler.ts
 * @description 定時觸發記憶 consolidate（促進 / 歸檔候選評估）
 *
 * 首次：5 分鐘後執行
 * 之後：每 6 小時
 *
 * 掃描範圍：current cfg 的 globalDir（含其 accounts/projects 子層），
 * 以及 ~/.catclaw/workspace/agents/<id>/memory/ 下所有 agent 個別記憶。
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { log } from "../logger.js";

const DELAY_MS    = 5 * 60_000;    // 首次 5 分鐘後執行
const INTERVAL_MS = 6 * 3600_000;  // 之後每 6 小時

/** 列舉所有 agent 的 memory 根目錄，過濾不存在 / 非目錄 / 無 .md 的 entry */
async function listAgentMemoryDirs(): Promise<string[]> {
  try {
    const { resolveWorkspaceDir } = await import("../core/config.js");
    const agentsRoot = join(resolveWorkspaceDir(), "agents");
    if (!existsSync(agentsRoot)) return [];
    return readdirSync(agentsRoot)
      .map(name => join(agentsRoot, name, "memory"))
      .filter(p => {
        try { return statSync(p).isDirectory(); } catch { return false; }
      });
  } catch (err) {
    log.debug(`[consolidate-scheduler] 列舉 agents 失敗：${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

async function run(): Promise<void> {
  try {
    const { getMemoryEngine } = await import("../memory/engine.js");
    const engine = getMemoryEngine();

    // 1. default — 預設 globalDir（其下含 accounts/projects 子目錄，readAllAtoms 已遞迴）
    const main = await engine.evaluatePromotions();
    let totalPromoted = main.promoted.length;
    let totalArchive = main.archiveCandidates.length;

    // 2. per-agent memory dirs（wendy / codex / ...）
    const agentDirs = await listAgentMemoryDirs();
    for (const dir of agentDirs) {
      try {
        const r = await engine.evaluatePromotions(dir);
        totalPromoted += r.promoted.length;
        totalArchive += r.archiveCandidates.length;
        if (r.promoted.length > 0 || r.archiveCandidates.length > 0) {
          log.info(`[consolidate-scheduler] ${dir} → promoted=${r.promoted.length} archive=${r.archiveCandidates.length}`);
        }
      } catch (err) {
        log.debug(`[consolidate-scheduler] ${dir} 失敗：${err instanceof Error ? err.message : String(err)}`);
      }
    }

    log.info(`[consolidate-scheduler] 完成：promoted=${totalPromoted} archive=${totalArchive}`);
  } catch (err) {
    log.warn(`[consolidate-scheduler] 執行失敗（graceful）：${err instanceof Error ? err.message : String(err)}`);
  }
}

export function scheduleConsolidate(): void {
  const t = setTimeout(() => {
    void run();
    setInterval(() => void run(), INTERVAL_MS).unref();
  }, DELAY_MS);
  t.unref();

  log.info("[consolidate-scheduler] 排程已設定（首次 5 分鐘後，之後每 6 小時）");
}
