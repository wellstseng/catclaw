/**
 * @file memory/atom-index-json.ts
 * @description V5 P3b — `_atom_index.json` Single Source of Truth
 *
 * Schema v1.0（與 ~/.claude/lib/atom_index_json.py 結構同形）：
 *   {
 *     "version": "1.0",
 *     "atoms": [
 *       { "name": string, "path": string, "triggers": string[], "confidence": string }
 *     ]
 *   }
 *
 * 與 Python 版差異：catclaw 用 `confidence`（取代 Python 的 `scope`/`last_used`），
 * 因 catclaw 已透過獨立 MEMORY.md per memory dir 處理層級隔離。
 *
 * 唯一機器源為 JSON；MEMORY.md 降級為自動產生的人類可讀鏡像，
 * 在每次 upsert/delete 後同步重生。
 */

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// ── 常數 ─────────────────────────────────────────────────────────────────────

export const ATOM_INDEX_JSON = "_atom_index.json";
export const ATOM_INDEX_MD = "MEMORY.md";
/**
 * Schema version。
 *
 * 注意：catclaw 與 ~/.claude（Python）SPEC 並非完全同形——
 *   - Python 版：`atoms[].scope`（必填）+ `atoms[].last_used`（optional）
 *   - catclaw  ：`atoms[].confidence`（必填）；scope 由獨立 MEMORY.md per dir 隱含
 *
 * 用 `1.0-catclaw` 標籤明確區分變體，避免與 SPEC §3.1 凍結的 Python `1.0`
 * 混淆。未來新增欄位需 bump 為 `1.1-catclaw`。
 */
export const SCHEMA_VERSION = "1.0-catclaw";

// ── 型別 ─────────────────────────────────────────────────────────────────────

export interface AtomIndexEntry {
  name: string;
  path: string;
  triggers: string[];
  confidence: string;
}

export interface AtomIndexData {
  version: string;
  atoms: AtomIndexEntry[];
}

// ── 內部工具 ─────────────────────────────────────────────────────────────────

function emptyIndex(): AtomIndexData {
  return { version: SCHEMA_VERSION, atoms: [] };
}

function entryEqual(a: AtomIndexEntry, b: AtomIndexEntry): boolean {
  if (a.name !== b.name || a.path !== b.path || a.confidence !== b.confidence) return false;
  if (a.triggers.length !== b.triggers.length) return false;
  for (let i = 0; i < a.triggers.length; i++) {
    if (a.triggers[i] !== b.triggers[i]) return false;
  }
  return true;
}

function normalizeTriggers(triggers: string[] | undefined | null): string[] {
  if (!Array.isArray(triggers)) return [];
  return triggers.map(t => (typeof t === "string" ? t.trim() : "")).filter(Boolean);
}

// ── 載入 / 儲存 ───────────────────────────────────────────────────────────────

export function loadAtomIndexJson(memDir: string): AtomIndexData {
  const p = join(memDir, ATOM_INDEX_JSON);
  if (!existsSync(p)) return emptyIndex();
  try {
    const raw = readFileSync(p, "utf-8");
    const data = JSON.parse(raw) as unknown;
    if (
      !data ||
      typeof data !== "object" ||
      !Array.isArray((data as { atoms?: unknown }).atoms)
    ) {
      return emptyIndex();
    }
    return data as AtomIndexData;
  } catch {
    return emptyIndex();
  }
}

export function saveAtomIndexJson(memDir: string, data: AtomIndexData): void {
  mkdirSync(memDir, { recursive: true });
  const p = join(memDir, ATOM_INDEX_JSON);
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  renameSync(tmp, p);
}

// ── 主要 API ─────────────────────────────────────────────────────────────────

/**
 * Upsert atom entry. 回傳 true 表示有實際變更（內容有差異或為新增）。
 * 變更後自動重生 MEMORY.md 鏡像。
 */
export function upsertAtom(memDir: string, entry: AtomIndexEntry): boolean {
  const data = loadAtomIndexJson(memDir);
  const normalized: AtomIndexEntry = {
    name: entry.name,
    path: entry.path,
    triggers: normalizeTriggers(entry.triggers),
    confidence: entry.confidence ?? "",
  };

  const idx = data.atoms.findIndex(a => a.name === normalized.name);
  if (idx >= 0) {
    if (entryEqual(data.atoms[idx], normalized)) return false;
    data.atoms[idx] = normalized;
  } else {
    data.atoms.push(normalized);
  }

  saveAtomIndexJson(memDir, data);
  regenerateAtomIndexMd(memDir);
  return true;
}

/**
 * 刪除 atom entry。回傳 true 表示有移除。
 */
export function deleteAtom(memDir: string, name: string): boolean {
  const data = loadAtomIndexJson(memDir);
  const before = data.atoms.length;
  data.atoms = data.atoms.filter(a => a.name !== name);
  if (data.atoms.length === before) return false;
  saveAtomIndexJson(memDir, data);
  regenerateAtomIndexMd(memDir);
  return true;
}

/**
 * 從 JSON 重生 MEMORY.md 鏡像（人類可讀，自動產生）。
 */
export function regenerateAtomIndexMd(memDir: string): void {
  const data = loadAtomIndexJson(memDir);
  const lines: string[] = [
    "# Atom Index",
    "",
    "> **Auto-generated mirror.** Machine source: `_atom_index.json` (V5 P3b)。請勿手改。",
    "",
    "| Atom | Path | Trigger | Confidence |",
    "|------|------|---------|------------|",
  ];
  for (const a of data.atoms) {
    const triggers = a.triggers.join(", ");
    lines.push(`| ${a.name} | ${a.path} | ${triggers} | ${a.confidence} |`);
  }
  lines.push("");

  mkdirSync(memDir, { recursive: true });
  const mdPath = join(memDir, ATOM_INDEX_MD);
  const tmp = `${mdPath}.tmp`;
  writeFileSync(tmp, lines.join("\n"), "utf-8");
  renameSync(tmp, mdPath);
}

// ── Migration: 解析既有 MEMORY.md table ────────────────────────────────────

/**
 * One-shot 遷移用：parse 舊 MEMORY.md table → AtomIndexEntry[]
 * 容忍空表 / 缺欄；遇到非 table 行視為 table 結束。
 */
export function parseLegacyMemoryMd(mdPath: string): AtomIndexEntry[] {
  if (!existsSync(mdPath)) return [];
  let text: string;
  try {
    text = readFileSync(mdPath, "utf-8");
  } catch {
    return [];
  }

  const entries: AtomIndexEntry[] = [];
  let inTable = false;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!inTable) {
      if (/^\|\s*Atom\s*\|/i.test(line)) inTable = true;
      continue;
    }
    if (line.startsWith("|---") || line.startsWith("| ---")) continue;
    if (!line.startsWith("|")) {
      if (!line) continue;
      break;
    }
    const cells = line.split("|").map(c => c.trim()).filter(Boolean);
    if (cells.length < 2) continue;
    const name = cells[0];
    const path = cells[1];
    if (!name || !path) continue;
    if (name.toLowerCase() === "atom") continue;
    const triggers = cells.length >= 3
      ? cells[2].split(",").map(t => t.trim()).filter(Boolean)
      : [];
    const confidence = cells.length >= 4 ? cells[3] : "";
    entries.push({ name, path, triggers, confidence });
  }
  return entries;
}

/**
 * 從現有 MEMORY.md 產生 _atom_index.json。idempotent。
 * @returns 最終 data（已存在且未覆寫時直接回 load 結果）
 */
export function migrateMdToJson(
  memDir: string,
  opts: { overwrite?: boolean } = {},
): AtomIndexData {
  const jsonPath = join(memDir, ATOM_INDEX_JSON);
  if (existsSync(jsonPath) && !opts.overwrite) {
    return loadAtomIndexJson(memDir);
  }
  const mdPath = join(memDir, ATOM_INDEX_MD);
  const atoms = parseLegacyMemoryMd(mdPath);
  const data: AtomIndexData = { version: SCHEMA_VERSION, atoms };
  saveAtomIndexJson(memDir, data);
  return data;
}

// ── Schema validation ────────────────────────────────────────────────────────

/**
 * 驗證 _atom_index.json schema。回傳 error 列表（空陣列代表 ok）。
 * 用於 build-time check 或 pre-commit hook。
 */
export function validateIndex(memDir: string): string[] {
  const errors: string[] = [];
  const jsonPath = join(memDir, ATOM_INDEX_JSON);
  if (!existsSync(jsonPath)) {
    errors.push(`missing: ${jsonPath}`);
    return errors;
  }

  let raw: string;
  try {
    raw = readFileSync(jsonPath, "utf-8");
  } catch (e) {
    errors.push(`read error: ${e instanceof Error ? e.message : String(e)}`);
    return errors;
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    errors.push(`json parse error: ${e instanceof Error ? e.message : String(e)}`);
    return errors;
  }

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    errors.push("root is not object");
    return errors;
  }
  const obj = data as Record<string, unknown>;
  if (obj.version !== SCHEMA_VERSION) {
    errors.push(`version mismatch: expected ${SCHEMA_VERSION}, got ${JSON.stringify(obj.version)}`);
  }
  if (!Array.isArray(obj.atoms)) {
    errors.push("atoms is not a list");
    return errors;
  }

  const seenNames = new Set<string>();
  const seenPaths = new Set<string>();
  obj.atoms.forEach((a, i) => {
    if (!a || typeof a !== "object" || Array.isArray(a)) {
      errors.push(`atoms[${i}] is not object`);
      return;
    }
    const e = a as Record<string, unknown>;
    for (const k of ["name", "path", "triggers", "confidence"] as const) {
      if (!(k in e)) errors.push(`atoms[${i}] missing key: ${k}`);
    }
    const name = e.name as string | undefined;
    const path = e.path as string | undefined;
    if (typeof name !== "string" || name.length === 0) {
      errors.push(`atoms[${i}] empty or non-string name`);
    } else {
      if (seenNames.has(name)) errors.push(`duplicate name: ${name}`);
      seenNames.add(name);
    }
    if (typeof path !== "string" || path.length === 0) {
      errors.push(`atoms[${i}] empty or non-string path`);
    } else {
      if (seenPaths.has(path)) errors.push(`duplicate path: ${path}`);
      seenPaths.add(path);
    }
    if (!Array.isArray(e.triggers)) {
      errors.push(`atoms[${i}] triggers not list`);
    } else {
      for (const t of e.triggers) {
        if (typeof t !== "string") {
          errors.push(`atoms[${i}] trigger not string: ${JSON.stringify(t)}`);
        } else if (t.length > 30) {
          errors.push(`trigger too long (>30): ${name}: ${JSON.stringify(t)}`);
        }
      }
    }
  });

  return errors;
}

