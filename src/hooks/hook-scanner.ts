/**
 * @file hooks/hook-scanner.ts
 * @description 掃描 hooks 資料夾 → 抽取 metadata → 產生 HookDefinition[]
 *
 * 掃描兩層：
 * - 全域：~/.catclaw/workspace/hooks/*.{ts,js,sh,bat,ps1}
 * - Agent：agents/{id}/hooks/*.{ts,js,sh,bat,ps1}
 *
 * 檔名規則：
 * - `{event}.{name}.ext` — event 從檔名取，name 為剩下部分
 * - 純 `{name}.ext` — 必須在檔內 metadata 指定 event
 * - `*.disabled.ext` — 自動跳過
 *
 * fs.watch 監聽變更，呼叫 onChange callback 觸發 registry.reload。
 */

import { promises as fs, watch as fsWatch, type FSWatcher } from "node:fs";
import { join, basename, extname } from "node:path";
import { log } from "../logger.js";
import {
  detectScriptKind, deriveFromFilename, parseShellMetadata, parseScriptMetadata,
} from "./metadata-parser.js";
import type { HookDefinition } from "./types.js";

const SUPPORTED_EXTS = new Set([".ts", ".js", ".mjs", ".cjs", ".sh", ".bat", ".ps1"]);

export interface ScanResult {
  global: HookDefinition[];
  byAgent: Map<string, HookDefinition[]>;
}

export interface ScannerOptions {
  globalDir: string;
  /** Map agentId → agent hooks 目錄 */
  agentDirs: Map<string, string>;
  /** 變更通知（debounced） */
  onChange?: () => void;
}

export class HookScanner {
  private watchers: FSWatcher[] = [];
  private debounceTimer: NodeJS.Timeout | null = null;

  constructor(private opts: ScannerOptions) {}

  /** 掃所有資料夾 → HookDefinition[] */
  async scan(): Promise<ScanResult> {
    const global = await this._scanDir(this.opts.globalDir, "global");
    const byAgent = new Map<string, HookDefinition[]>();
    for (const [agentId, dir] of this.opts.agentDirs.entries()) {
      const defs = await this._scanDir(dir, "agent", agentId);
      if (defs.length > 0) byAgent.set(agentId, defs);
    }
    log.info(`[hook-scanner] 掃描完成：global=${global.length}, agents=${byAgent.size}`);
    return { global, byAgent };
  }

  /** 啟動 fs.watch */
  startWatching(): void {
    const watchDir = (dir: string) => {
      try {
        const w = fsWatch(dir, { persistent: false }, () => this._notifyChange());
        this.watchers.push(w);
      } catch (err) {
        log.debug(`[hook-scanner] watch 失敗 ${dir}: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    watchDir(this.opts.globalDir);
    for (const dir of this.opts.agentDirs.values()) watchDir(dir);
  }

  /** 停止監聽 */
  stop(): void {
    for (const w of this.watchers) {
      try { w.close(); } catch { /* ignore */ }
    }
    this.watchers = [];
    if (this.debounceTimer) { clearTimeout(this.debounceTimer); this.debounceTimer = null; }
  }

  private _notifyChange(): void {
    if (!this.opts.onChange) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.opts.onChange?.();
    }, 300);
  }

  private async _scanDir(dir: string, scope: "global" | "agent", agentId?: string): Promise<HookDefinition[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return [];
    }

    const defs: HookDefinition[] = [];
    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      const ext = extname(entry).toLowerCase();
      if (!SUPPORTED_EXTS.has(ext)) continue;
      const base = basename(entry, ext);
      if (base.endsWith(".disabled")) continue;

      const filePath = join(dir, entry);
      const def = await this._loadOne(filePath, scope, agentId);
      if (def) defs.push(def);
    }
    return defs;
  }

  private async _loadOne(filePath: string, scope: "global" | "agent", agentId?: string): Promise<HookDefinition | null> {
    const kind = detectScriptKind(filePath);
    const { name, eventHint } = deriveFromFilename(filePath);

    let metadata: Partial<import("./sdk.js").HookMetadata> | null = null;
    if (kind === "ts" || kind === "js") {
      metadata = await parseScriptMetadata(filePath, kind);
    } else if (kind === "shell") {
      metadata = await parseShellMetadata(filePath);
    }

    const event = metadata?.event ?? eventHint;
    if (!event) {
      log.warn(`[hook-scanner] 略過 ${filePath}：無法判定 event（檔案 metadata 與檔名都沒指定）`);
      return null;
    }

    return {
      name,
      event,
      scriptPath: filePath,
      runtime: kind === "ts" ? "ts" : kind === "js" ? "node" : "shell",
      timeoutMs: metadata?.timeoutMs,
      toolFilter: metadata?.toolFilter,
      enabled: metadata?.enabled ?? true,
      scope,
      agentId,
    };
  }
}
