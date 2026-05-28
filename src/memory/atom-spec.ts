/**
 * @file memory/atom-spec.ts
 * @description V5 P5 — atom 合法性規則的單一來源
 *
 * 純資料 + 純函式（零 IO），被 atom.ts / atom-write.ts / atom-io.ts / consolidate.ts
 * 共用 import，避免規則漂移。對拍 upstream `~/.claude/lib/atom_spec.py`，
 * catclaw schema 變體（用 `confidence`，無 `scope` 強制必填）。
 */

import type { AtomConfidence, AtomScope } from "./atom.js";

// ── 目錄/檔名 跳過清單 ─────────────────────────────────────────────────────

/** 子目錄跳過清單（rglob 掃描 atom 時用） */
export const SKIP_DIRS: ReadonlySet<string> = new Set([
  // memory 子目錄
  "_meta", "_reference", "_staging", "_vectordb", "_distant",
  "episodic", "templates", "personal", "wisdom", "_pending_review",
  "failures",
  // 防止掃進非 memory 區域（migration script / readAllAtoms 對寬 root 時）
  "node_modules", "dist", "build", "out", ".git", "__pycache__", ".pytest_cache",
  ".venv", "venv", "coverage",
]);

/** 系統檔前綴（檔名等級跳過） */
export const SKIP_PREFIXES: readonly string[] = ["SPEC_", "_"] as const;

// ── 索引檔 ─────────────────────────────────────────────────────────────────

export const MEMORY_INDEX = "MEMORY.md";
export const ATOM_INDEX_JSON = "_atom_index.json";

// ── Metadata 欄位 ─────────────────────────────────────────────────────────

/**
 * Wave 2 後 `Last-used` / `Confirmations` / `ReadHits` 抽到 `<atom>.access.json`，
 * 故 atom .md 不再要求這些欄位（OPTIONAL_METADATA 仍接受 legacy 欄位過渡）。
 */
export const REQUIRED_METADATA: ReadonlySet<string> = new Set([
  "Confidence", "Trigger",
]);

export const OPTIONAL_METADATA: ReadonlySet<string> = new Set([
  // legacy 過渡欄；Phase 3 migration 後可清空
  "Last-used", "Confirmations", "ReadHits",
  "Scope", "Created-at",
  "Description", "Related", "Source", "Type", "Tags", "Supersedes",
  "Quality", "Audience", "Author", "TTL", "Expires-at",
  "Pending-review-by", "Merge-strategy", "Privacy",
]);

// ── 章節 ────────────────────────────────────────────────────────────────────

export const REQUIRED_SECTIONS: ReadonlySet<string> = new Set(["知識"]);
export const KNOWLEDGE_SECTIONS: ReadonlySet<string> = new Set(["知識", "印象", "行動"]);

// ── 值域 ────────────────────────────────────────────────────────────────────

export const VALID_CONFIDENCE: ReadonlySet<AtomConfidence> = new Set(["[固]", "[觀]", "[臨]"]);
export const VALID_SCOPES: ReadonlySet<AtomScope> = new Set(["global", "project", "account", "agent"]);

// ── 數值限制 ─────────────────────────────────────────────────────────────────

export const TRIGGER_MIN = 1;
export const TRIGGER_MAX = 12;
export const ATOM_MAX_LINES = 200;
export const INDEX_MAX_LINES = 40;

// ── slugify / 構造 / validate ─────────────────────────────────────────────────

const SLUG_OK_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * 將 atom name 正規化為 kebab-case。
 *
 * 與 `atom-write.ts:49` 的 regex 一致：必須 `^[a-z0-9][a-z0-9-]*$`。
 *
 * 對非 ASCII 輸入（例如中文）僅做極輕度處理：lower-case + 連續空白/底線轉 dash；
 * 若仍不合法回傳 null（caller 應 error 而非靜默改寫）。
 */
export function slugify(input: string): string | null {
  if (!input) return null;
  const s = input
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return SLUG_OK_RE.test(s) ? s : null;
}

export interface AtomMetaForBuild {
  name: string;
  scope?: AtomScope;
  confidence?: AtomConfidence;
  triggers?: string[];
  related?: string[];
  description?: string;
}

/**
 * 構造 atom .md 字串（不含遙測欄）。
 *
 * Wave 2 後 `Last-used` / `Confirmations` 不再寫入 .md；
 * `Created-at` 保留作為「atom 創建時間」單一來源（access.json 的 first_seen 為遙測補強）。
 */
export function buildAtomContent(meta: AtomMetaForBuild, content: string): string {
  const lines = [
    `# ${meta.name}`,
    "",
    `- Scope: ${meta.scope ?? "global"}`,
    `- Confidence: ${meta.confidence ?? "[臨]"}`,
    ...(meta.triggers?.length ? [`- Trigger: ${meta.triggers.join(", ")}`] : []),
    `- Created-at: ${Date.now()}`,
    ...(meta.related?.length ? [`- Related: ${meta.related.join(", ")}`] : []),
    "",
    `## 知識`,
    "",
    content,
    "",
  ];
  return lines.join("\n");
}

export interface ValidationError {
  kind: "missing-required-meta" | "unknown-meta" | "invalid-confidence" |
        "invalid-scope" | "too-many-triggers" | "too-few-triggers" |
        "over-max-lines" | "missing-section" | "empty-content";
  detail: string;
}

/**
 * 驗證 atom raw 文本是否符合 spec。回傳 error 列表（空 = ok）。
 *
 * 用於 `atom-write` tool 在 write-gate 前先擋掉格式問題的 atom，
 * 避免進到後續 pipeline 才在 silent fallback。
 */
export function validateAtomContent(raw: string): ValidationError[] {
  const errors: ValidationError[] = [];
  if (!raw || !raw.trim()) {
    errors.push({ kind: "empty-content", detail: "raw is empty" });
    return errors;
  }

  const lines = raw.split("\n");
  if (lines.length > ATOM_MAX_LINES) {
    errors.push({
      kind: "over-max-lines",
      detail: `${lines.length} > ${ATOM_MAX_LINES}`,
    });
  }

  // 找第一個 ## 之前的 metadata 區段
  const contentStartIdx = lines.findIndex((l, i) => i > 0 && l.startsWith("## "));
  const metaLines = contentStartIdx > 0 ? lines.slice(0, contentStartIdx) : lines;

  const seenMeta = new Set<string>();
  let confidenceVal: string | null = null;
  let scopeVal: string | null = null;
  let triggerCount = 0;

  for (const line of metaLines) {
    const m = line.match(/^-\s+([\w-]+):\s+(.+)$/);
    if (!m) continue;
    const [, key, val] = m;
    seenMeta.add(key);

    if (!REQUIRED_METADATA.has(key) && !OPTIONAL_METADATA.has(key)) {
      errors.push({ kind: "unknown-meta", detail: key });
    }
    if (key === "Confidence") confidenceVal = val.trim();
    if (key === "Scope") scopeVal = val.trim();
    if (key === "Trigger") {
      triggerCount = val.split(",").map(s => s.trim()).filter(Boolean).length;
    }
  }

  for (const req of REQUIRED_METADATA) {
    if (!seenMeta.has(req)) {
      errors.push({ kind: "missing-required-meta", detail: req });
    }
  }

  if (confidenceVal && !VALID_CONFIDENCE.has(confidenceVal as AtomConfidence)) {
    errors.push({ kind: "invalid-confidence", detail: confidenceVal });
  }
  if (scopeVal && !VALID_SCOPES.has(scopeVal as AtomScope)) {
    errors.push({ kind: "invalid-scope", detail: scopeVal });
  }

  if (triggerCount > TRIGGER_MAX) {
    errors.push({ kind: "too-many-triggers", detail: `${triggerCount} > ${TRIGGER_MAX}` });
  }
  // TRIGGER_MIN=1：Trigger 欄位是 optional 寫法時 triggerCount=0 不視為錯，
  // 只在「明寫 Trigger: 但內容空」會誤判為 0；該情境其實也合理擋，故下面 guard：
  if (seenMeta.has("Trigger") && triggerCount < TRIGGER_MIN) {
    errors.push({ kind: "too-few-triggers", detail: `${triggerCount} < ${TRIGGER_MIN}` });
  }

  // 至少要有一個知識章節
  const hasKnowledge = lines.some(l => {
    const m = l.match(/^##\s+(.+?)\s*$/);
    return m && KNOWLEDGE_SECTIONS.has(m[1]);
  });
  if (!hasKnowledge) {
    errors.push({ kind: "missing-section", detail: "至少需 ## 知識 / ## 印象 / ## 行動 之一" });
  }

  return errors;
}

/**
 * 簡易掃描跳過判定（給 readAllAtoms / atom-io 用）。
 *
 * @param entry  目錄 entry 名稱（檔案或目錄）
 * @returns true 表示應跳過
 */
export function shouldSkip(entry: string): boolean {
  if (SKIP_DIRS.has(entry)) return true;
  for (const prefix of SKIP_PREFIXES) {
    if (entry.startsWith(prefix)) return true;
  }
  if (entry === MEMORY_INDEX || entry === ATOM_INDEX_JSON) return true;
  return false;
}
