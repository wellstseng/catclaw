/**
 * @file memory/index-manager.ts
 * @description V5 P3b — atom index 管理門面（轉接 JSON SoT）
 *
 * 機器源已遷至 `_atom_index.json`（同層 MEMORY.md 之目錄）。
 * MEMORY.md 降級為自動產生的人類可讀鏡像。
 *
 * 對外簽名不變（loadIndex / matchTriggers / upsertIndex / removeIndex），
 * 三個 caller（atom.ts / atom-delete.ts / recall.ts）零修改。
 *
 * Fallback：若 `_atom_index.json` 缺失但 MEMORY.md 仍是手寫 table → loadIndex
 * 仍能 parse 舊格式，確保升級過渡期不中斷。
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { log } from "../logger.js";
import {
  ATOM_INDEX_JSON,
  loadAtomIndexJson,
  parseLegacyMemoryMd,
  upsertAtom,
  deleteAtom,
  type AtomIndexEntry,
} from "./atom-index-json.js";

// ── 型別定義（對外不變）─────────────────────────────────────────────────────

export interface IndexEntry {
  /** Atom 名稱 */
  name: string;
  /** Atom 檔案路徑（相對於 MEMORY.md 所在目錄） */
  path: string;
  /** 觸發關鍵詞列表 */
  triggers: string[];
  /** 信心等級 */
  confidence: string;
}

// ── 內部 helpers ─────────────────────────────────────────────────────────────

function memDirOf(memoryMdPath: string): string {
  return dirname(memoryMdPath);
}

function toIndexEntry(a: AtomIndexEntry): IndexEntry {
  return {
    name: a.name,
    path: a.path,
    triggers: [...a.triggers],
    confidence: a.confidence ?? "",
  };
}

// ── 公開 API ─────────────────────────────────────────────────────────────────

/**
 * 讀取 atom index。優先 `_atom_index.json`；若缺則 fallback 解析舊 MEMORY.md。
 */
export function loadIndex(memoryMdPath: string): IndexEntry[] {
  const memDir = memDirOf(memoryMdPath);

  // 主路徑：JSON SoT
  const jsonPath = join(memDir, ATOM_INDEX_JSON);
  if (existsSync(jsonPath)) {
    try {
      const data = loadAtomIndexJson(memDir);
      const entries = data.atoms.map(toIndexEntry);
      log.debug(`[index-manager] 載入 ${jsonPath}：${entries.length} 筆 (JSON SoT)`);
      return entries;
    } catch (err) {
      log.warn(`[index-manager] JSON 讀取失敗，fallback 到 MEMORY.md：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Fallback：舊 MEMORY.md（升級過渡期 / 未跑 migration）
  if (!existsSync(memoryMdPath)) return [];
  try {
    const atoms = parseLegacyMemoryMd(memoryMdPath);
    const entries = atoms.map(toIndexEntry);
    log.debug(`[index-manager] 載入 ${memoryMdPath}：${entries.length} 筆 (legacy MD fallback)`);
    return entries;
  } catch (err) {
    log.warn(`[index-manager] 讀取失敗 ${memoryMdPath}：${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Trigger 關鍵詞匹配（全詞 substring 大小寫不敏感）。
 */
export function matchTriggers(prompt: string, entries: IndexEntry[]): IndexEntry[] {
  const lower = prompt.toLowerCase();
  return entries.filter(e =>
    e.triggers.some(t => lower.includes(t.toLowerCase()))
  );
}

/**
 * Upsert atom entry：寫 JSON SoT + 同步重生 MEMORY.md 鏡像。
 */
export function upsertIndex(memoryMdPath: string, entry: IndexEntry): void {
  const memDir = memDirOf(memoryMdPath);
  try {
    const changed = upsertAtom(memDir, {
      name: entry.name,
      path: entry.path,
      triggers: entry.triggers,
      confidence: entry.confidence,
    });
    if (changed) {
      log.debug(`[index-manager] upsert ${entry.name} (JSON SoT)`);
    }
  } catch (err) {
    log.warn(`[index-manager] upsertIndex 失敗：${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * 移除 atom entry：寫 JSON SoT + 同步重生 MEMORY.md 鏡像。
 */
export function removeIndex(memoryMdPath: string, atomName: string): void {
  const memDir = memDirOf(memoryMdPath);
  try {
    deleteAtom(memDir, atomName);
  } catch (err) {
    log.warn(`[index-manager] removeIndex 失敗：${err instanceof Error ? err.message : String(err)}`);
  }
}
