/**
 * @file memory/atom-io.ts
 * @description V5 P4 — 全系統 atom 寫入/刪除/更新唯一 funnel + audit log
 *
 * 對拍 upstream `~/.claude/lib/atom_io.py`（catclaw 變體）。
 *
 * 設計目標：
 *   - 所有 atom .md 寫入/刪除/更新都走這層
 *   - 每次操作記入 `<memDir>/_meta/atom_io_audit.jsonl`
 *   - 可被 caller 透過 `source` 標記來源（追溯誰寫的）
 *
 * Audit log 格式（每行一筆 JSON）：
 *   { id, ts, source, action, atom_name, dir, scope?, bytes?, dry_run? }
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  unlinkSync,
  mkdirSync,
  appendFileSync,
  renameSync,
} from "node:fs";
import { join, dirname, basename } from "node:path";
import { randomBytes } from "node:crypto";
import { log } from "../logger.js";
import { buildAtomContent } from "./atom-spec.js";
import { initAccess, deleteAccess, recordPromotion } from "./atom-access.js";
import { invalidate as invalidateBm25 } from "./bm25-service.js";
import type { AtomConfidence, AtomScope } from "./atom.js";

// ── 常數 ─────────────────────────────────────────────────────────────────────

export const AUDIT_RELATIVE_PATH = "_meta/atom_io_audit.jsonl";

export const VALID_SOURCES: ReadonlySet<string> = new Set([
  "mcp",
  "hook:atom-inject",
  "hook:episodic",
  "hook:episodic-confirm",
  "hook:user-extract",
  "hook:extract-worker",
  "tool:atom-write",
  "tool:atom-delete",
  "tool:atom-move",
  "tool:consolidate-promote",
  "tool:memory-audit",
  "tool:memory-cleanup",
  "tool:migrate",
  "tool:sync-atom-index",
  "tool:sync-memory-index",
  "tool:undo",
  "test",
]);

// ── 型別 ─────────────────────────────────────────────────────────────────────

export type AtomAction =
  | "write" | "delete" | "update-confidence" | "rename" | "raw-write";

export interface AuditRecord {
  id: string;
  ts: number;
  source: string;
  action: AtomAction;
  atom_name: string;
  dir: string;
  scope?: AtomScope;
  bytes?: number;
  dry_run?: boolean;
}

export interface WriteOpts {
  /** memory dir（dirname of atom path） */
  dir: string;
  /** atom slug name（無 .md） */
  name: string;
  /** atom 內容（## 知識 章節之後的純內容） */
  content: string;
  scope?: AtomScope;
  confidence?: AtomConfidence;
  triggers?: string[];
  related?: string[];
  description?: string;
  /** caller 標記 — 必須屬於 VALID_SOURCES */
  source: string;
  /** dry-run：算路徑 + 記 audit 但不落檔 */
  dryRun?: boolean;
}

export interface WriteResult {
  path: string;
  bytes: number;
  auditId: string;
  dryRun: boolean;
}

// ── 內部 helpers ─────────────────────────────────────────────────────────────

function genAuditId(): string {
  return randomBytes(8).toString("hex");
}

function auditPath(memDir: string): string {
  return join(memDir, AUDIT_RELATIVE_PATH);
}

function appendAudit(memDir: string, record: AuditRecord): void {
  const p = auditPath(memDir);
  try {
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, JSON.stringify(record) + "\n", "utf-8");
  } catch (err) {
    log.warn(`[atom-io] audit 寫入失敗 ${p}：${err instanceof Error ? err.message : String(err)}`);
  }
}

function assertSource(source: string): void {
  if (!VALID_SOURCES.has(source)) {
    throw new Error(`[atom-io] invalid source: ${source}（合法列見 VALID_SOURCES）`);
  }
}

function memDirOf(atomPath: string): string {
  return dirname(atomPath);
}

function atomNameOf(atomPath: string): string {
  return basename(atomPath, ".md");
}

// ── 主 API ──────────────────────────────────────────────────────────────────

/**
 * 寫入 atom .md。一律走此 funnel。
 *
 * 行為：
 *   1. 用 atom-spec.buildAtomContent 構造內容
 *   2. atomic write (tmp + rename)
 *   3. 同步 init access.json（V5 P3）
 *   4. 記 audit log
 */
export function writeAtom(opts: WriteOpts): WriteResult {
  assertSource(opts.source);
  const id = genAuditId();
  const filePath = join(opts.dir, `${opts.name}.md`);
  const md = buildAtomContent(
    {
      name: opts.name,
      scope: opts.scope,
      confidence: opts.confidence,
      triggers: opts.triggers,
      related: opts.related,
      description: opts.description,
    },
    opts.content,
  );
  const bytes = Buffer.byteLength(md, "utf-8");
  const dryRun = opts.dryRun === true;

  if (!dryRun) {
    mkdirSync(opts.dir, { recursive: true });
    const tmp = `${filePath}.tmp`;
    writeFileSync(tmp, md, "utf-8");
    renameSync(tmp, filePath);
    try { initAccess(filePath); } catch { /* access 初始化失敗不阻擋主寫入 */ }
    try { invalidateBm25(opts.dir, opts.name); } catch { /* bm25 invalidate 失敗不阻擋 */ }
  }

  appendAudit(opts.dir, {
    id,
    ts: Date.now(),
    source: opts.source,
    action: "write",
    atom_name: opts.name,
    dir: opts.dir,
    scope: opts.scope,
    bytes,
    dry_run: dryRun || undefined,
  });

  return { path: filePath, bytes, auditId: id, dryRun };
}

/**
 * 刪除 atom .md + sibling .access.json + 記 audit。
 */
export function deleteAtom(atomPath: string, source: string, opts: { dryRun?: boolean } = {}): { deleted: boolean; auditId: string } {
  assertSource(source);
  const id = genAuditId();
  const dir = memDirOf(atomPath);
  const name = atomNameOf(atomPath);
  const dryRun = opts.dryRun === true;

  let deleted = false;
  if (!dryRun) {
    if (existsSync(atomPath)) {
      try {
        unlinkSync(atomPath);
        deleted = true;
      } catch (err) {
        log.warn(`[atom-io] unlink 失敗 ${atomPath}：${err instanceof Error ? err.message : String(err)}`);
      }
    }
    try { deleteAccess(atomPath); } catch { /* access 刪除失敗不阻擋 */ }
    try { invalidateBm25(dir, name); } catch { /* bm25 invalidate 失敗不阻擋 */ }
  }

  appendAudit(dir, {
    id,
    ts: Date.now(),
    source,
    action: "delete",
    atom_name: name,
    dir,
    dry_run: dryRun || undefined,
  });

  return { deleted, auditId: id };
}

/**
 * 更新 atom .md 的 Confidence 行（晉升 / 降級用）。
 * 同步：access.json `last_promoted_at`。
 */
export function updateAtomConfidence(
  atomPath: string,
  target: AtomConfidence,
  source: string,
): { changed: boolean; auditId: string } {
  assertSource(source);
  const id = genAuditId();
  const dir = memDirOf(atomPath);
  const name = atomNameOf(atomPath);

  let changed = false;
  if (existsSync(atomPath)) {
    try {
      const raw = readFileSync(atomPath, "utf-8");
      const updated = raw.replace(
        /^(-\s+Confidence:\s+)\[(?:固|觀|臨)\]/m,
        `$1${target}`,
      );
      if (updated !== raw) {
        const tmp = `${atomPath}.tmp`;
        writeFileSync(tmp, updated, "utf-8");
        renameSync(tmp, atomPath);
        try { recordPromotion(atomPath, target); } catch { /* access 記錄失敗不阻擋 */ }
        try { invalidateBm25(dir, name); } catch { /* bm25 invalidate 失敗不阻擋 */ }
        changed = true;
      }
    } catch (err) {
      log.warn(`[atom-io] updateAtomConfidence 失敗 ${atomPath}：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  appendAudit(dir, {
    id,
    ts: Date.now(),
    source,
    action: "update-confidence",
    atom_name: name,
    dir,
  });

  return { changed, auditId: id };
}

/**
 * 「raw write」— 給 episodic 等非 atom 格式的內容用：
 *   - 不套 buildAtomContent
 *   - 不 init access.json
 *   - 但仍記 audit（追溯誰寫的）
 */
export function rawWrite(
  filePath: string,
  content: string,
  source: string,
): { bytes: number; auditId: string } {
  assertSource(source);
  const id = genAuditId();
  const dir = dirname(filePath);
  const name = atomNameOf(filePath);
  const bytes = Buffer.byteLength(content, "utf-8");

  mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, content, "utf-8");
  renameSync(tmp, filePath);

  appendAudit(dir, {
    id,
    ts: Date.now(),
    source,
    action: "raw-write",
    atom_name: name,
    dir,
    bytes,
  });

  return { bytes, auditId: id };
}

// ── 讀 audit log（debug / test 用） ─────────────────────────────────────────

export function readAuditLog(memDir: string): AuditRecord[] {
  const p = auditPath(memDir);
  if (!existsSync(p)) return [];
  try {
    const raw = readFileSync(p, "utf-8");
    return raw
      .split("\n")
      .filter(Boolean)
      .map(line => {
        try { return JSON.parse(line) as AuditRecord; }
        catch { return null; }
      })
      .filter((r): r is AuditRecord => r !== null);
  } catch {
    return [];
  }
}
