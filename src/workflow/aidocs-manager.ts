/**
 * @file workflow/aidocs-manager.ts
 * @description AIDocs 維護管理 — file:modified 後提醒同步 _AIDocs
 *
 * 邏輯：
 *   - file:modified 觸發時，若工作目錄有 _AIDocs/，記錄哪些檔案被修改
 *   - turn:after 後若有待記錄的修改，emit workflow:sync_needed（帶有 _AIDocs hint）
 *
 * 注意：實際 _AIDocs 更新由 LLM 執行，此模組只做追蹤 + 提醒
 *
 * 對應架構文件第 9 節「AIDocs 維護」
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { log } from "../logger.js";
import type { CatClawEvents } from "../core/event-bus.js";

type EventBus = {
  on<K extends keyof CatClawEvents>(event: K, listener: (...args: CatClawEvents[K]) => void): unknown;
  emit<K extends keyof CatClawEvents>(event: K, ...args: CatClawEvents[K]): boolean;
};

// ── 狀態 ──────────────────────────────────────────────────────────────────────

/** 本 session 中被修改且應更新 _AIDocs 的檔案 */
const _pendingAidocs = new Set<string>();

/** src/腳本有改動但 README/WIKI/_AIDocs 尚未同步 */
let _srcChanged = false;
let _docsTouched = false;

let _projectRoots: string[] = [process.cwd()];

// ── 公開 API ──────────────────────────────────────────────────────────────────

export function setProjectRoots(roots: string[]): void {
  _projectRoots = roots;
}

export function getPendingAidocsFiles(): string[] {
  return [..._pendingAidocs];
}

export function clearPendingAidocs(): void {
  _pendingAidocs.clear();
  _srcChanged = false;
  _docsTouched = false;
}

// ── AIDocs 存在性檢查 ─────────────────────────────────────────────────────────

function hasAidocs(): boolean {
  return _projectRoots.some(root => existsSync(join(root, "_AIDocs")));
}

// ── 初始化 ────────────────────────────────────────────────────────────────────

export function initAidocsManager(eventBus: EventBus, projectRoot?: string): void {
  if (projectRoot) _projectRoots = [projectRoot];

  const DOCS_PATTERNS = ["README", "_AIDocs/", "WIKI"];
  const SRC_TRIGGERS = ["/src/", "setup.sh", "setup.ps1", "catclaw.js", "ecosystem.config.cjs"];

  eventBus.on("file:modified", (path, _tool, _accountId) => {
    if (!hasAidocs()) return;

    const norm = path.replace(/\\/g, "/");

    // Docs-sync 追蹤：src/腳本改動 vs 文件改動
    if (SRC_TRIGGERS.some(p => norm.includes(p))) _srcChanged = true;
    if (DOCS_PATTERNS.some(p => norm.includes(p))) _docsTouched = true;

    // 排除 _AIDocs 自身修改（避免迴圈）
    if (path.includes("_AIDocs")) return;

    // 排除非程式碼檔案（.ts/.js/.json/.yaml 才需要 AIDocs 追蹤）
    const tracked = [".ts", ".js", ".json", ".yaml", ".yml", ".md"].some(ext => path.endsWith(ext));
    if (tracked) {
      _pendingAidocs.add(path);
      log.debug(`[aidocs-manager] 記錄待更新：${path}`);
    }
  });

  eventBus.on("session:end", (_sessionId) => {
    clearPendingAidocs();
  });

  log.info("[aidocs-manager] 初始化完成");
}

/**
 * 取得 AIDocs 同步提醒文字（供注入 system prompt）
 * 若無待更新或無 _AIDocs → 回傳空字串
 */
export function getAidocsSyncHint(): string {
  if (_pendingAidocs.size === 0 || !hasAidocs()) return "";
  const files = [..._pendingAidocs].slice(0, 5);
  const extra = _pendingAidocs.size > 5 ? `（共 ${_pendingAidocs.size} 個）` : "";
  let hint = `\n\n[AIDocs] 下列檔案已修改，完成後記得更新 _AIDocs：${files.map(f => `\n- ${f}`).join("")}${extra}`;

  // Docs-sync 警告：src 改了但文件沒動
  if (_srcChanged && !_docsTouched) {
    hint += `\n\n[Docs-Sync] src/腳本有異動但尚未更新文件。記得同步 README（中英版）、WIKI、_AIDocs。`;
  }

  return hint;
}

/** 查詢 docs-sync 狀態 */
export function getDocsSyncStatus(): { srcChanged: boolean; docsTouched: boolean } {
  return { srcChanged: _srcChanged, docsTouched: _docsTouched };
}
