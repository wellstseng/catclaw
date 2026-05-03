/**
 * @file core/context-references.ts
 * @description Inline Context References — `@file:` / `@folder:` / `@git:` / `@url:` / `@diff` / `@staged` 語法（項目 8）
 *
 * 使用者訊息含 @-references 時 pipeline 預處理：
 *   1. 解析 ref pattern（不自動偵測檔名，必須顯式 @）
 *   2. 安全邊界檢查（路徑逃逸、敏感 pattern、size 上限、URL scheme）
 *   3. 展開：保留原 @xxx 字樣，在訊息末尾附加 [inline-ref kind@target] block
 *   4. 失敗：保留原字樣 + 在 block 內標記失敗原因
 *
 * 與 message-pipeline 整合：discord/api 訊息進 sanitizeMemoryText 後立即跑 expandReferences。
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { log } from "../logger.js";

// ── 型別 ─────────────────────────────────────────────────────────────────────

export type ReferenceKind = "file" | "folder" | "git" | "url" | "diff" | "staged";

export interface ExpandedReference {
  kind: ReferenceKind;
  /** 原 @xxx 字樣（含前綴 @） */
  raw: string;
  /** 展開的目標（path / commitish / url；diff/staged 為空字串） */
  target: string;
  ok: boolean;
  /** 成功時為展開內容（含 [inline-ref] 包裝）；失敗時為錯誤說明 */
  content: string;
  /** 展開內容的 byte size（成功時計） */
  sizeBytes?: number;
}

// ── Regex ─────────────────────────────────────────────────────────────────────

/**
 * @diff / @staged → 完整 keyword
 * @file:"path[:lineRange]" 或 @file:path（不含空格）
 * @folder:"path" 或 @folder:path
 * @git:<commitish>
 * @url:<url>
 *
 * Negative lookbehind `(?<![\w/])` 避免 emails (foo@bar.com) 與 path/file@x 誤觸。
 * 結尾 char class 排除中文標點（，。；）以利使用者中文句中夾用 @ref。
 */
const REF_REGEX = /(?<![\w/])@(diff\b|staged\b|file:(?:"[^"]+"|[^\s,。；]+)|folder:(?:"[^"]+"|[^\s,。；]+)|git:[^\s,。；]+|url:[^\s,。；]+)/g;

const HAS_REF_PATTERN = /(?<![\w/])@(?:diff\b|staged\b|file:|folder:|git:|url:)/;

// ── 安全限制 ──────────────────────────────────────────────────────────────────

const MAX_FILE_BYTES = 50 * 1024;
const MAX_FOLDER_ENTRIES = 200;
const MAX_GIT_DIFF_BYTES = 100 * 1024;
const MAX_URL_BYTES = 50 * 1024;
const URL_TIMEOUT_MS = 10_000;
const FOLDER_DEPTH_LIMIT = 2;

const SENSITIVE_PATH_PATTERNS = [
  /(^|\/)\.ssh(\/|$)/,
  /(^|\/)\.aws(\/|$)/,
  /(^|\/)\.gnupg(\/|$)/,
  /(^|\/)id_rsa(\b|$)/,
  /(^|\/)\.env(\.|$|\/)/,
  /password|secret|credentials/i,
];

function isPathSafe(p: string): { ok: boolean; reason?: string } {
  // .. 逃逸（任何 segment 為 ..）
  if (p.split("/").some(seg => seg === "..")) {
    return { ok: false, reason: "路徑含 .. 不允許" };
  }
  if (SENSITIVE_PATH_PATTERNS.some(re => re.test(p))) {
    return { ok: false, reason: "路徑含敏感字眼（ssh/aws/env/secret 等）" };
  }
  return { ok: true };
}

function stripQuotes(s: string): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  return s;
}

// ── File ─────────────────────────────────────────────────────────────────────

function parseFileRef(rest: string): { path: string; lineStart?: number; lineEnd?: number } {
  // rest 可能是 "src/foo.ts" 或 "src/foo.ts:120-150" 或 "src/foo.ts:120"
  const parts = rest.split(":");
  if (parts.length === 1) return { path: parts[0]! };
  const last = parts[parts.length - 1]!;
  if (/^\d+(-\d+)?$/.test(last)) {
    const path = parts.slice(0, -1).join(":");
    const [s, e] = last.split("-");
    const lineStart = parseInt(s!, 10);
    const lineEnd = e ? parseInt(e, 10) : lineStart;
    return { path, lineStart, lineEnd };
  }
  return { path: rest };
}

function expandFile(rawRest: string): ExpandedReference {
  const rest = stripQuotes(rawRest);
  const parsed = parseFileRef(rest);
  const base: Pick<ExpandedReference, "kind" | "raw" | "target"> = {
    kind: "file",
    raw: `@file:${rawRest}`,
    target: parsed.path,
  };

  const safe = isPathSafe(parsed.path);
  if (!safe.ok) {
    return { ...base, ok: false, content: `路徑被拒絕：${safe.reason}` };
  }
  if (!existsSync(parsed.path)) {
    return { ...base, ok: false, content: `檔案不存在：${parsed.path}` };
  }

  try {
    const stat = statSync(parsed.path);
    if (!stat.isFile()) {
      return { ...base, ok: false, content: `路徑不是檔案：${parsed.path}` };
    }
    const fullText = readFileSync(parsed.path, "utf-8");
    let body: string;
    let suffix = "";
    if (parsed.lineStart != null) {
      const lines = fullText.split("\n");
      const start = Math.max(0, parsed.lineStart - 1);
      const end = Math.min(lines.length, parsed.lineEnd ?? lines.length);
      body = lines
        .slice(start, end)
        .map((l, i) => `${start + i + 1}\t${l}`)
        .join("\n");
      suffix = `:${parsed.lineStart}-${parsed.lineEnd ?? parsed.lineStart}`;
    } else {
      body = fullText
        .split("\n")
        .map((l, i) => `${i + 1}\t${l}`)
        .join("\n");
    }

    const sizeBytes = Buffer.byteLength(body, "utf-8");
    let warning = "";
    if (sizeBytes > MAX_FILE_BYTES) {
      body = body.slice(0, MAX_FILE_BYTES);
      warning = `\n[⚠️ inline-ref 已截斷：原 ${sizeBytes} bytes / 上限 ${MAX_FILE_BYTES} bytes，請帶行號範圍 @file:"${parsed.path}:start-end"]`;
    }
    const ext = parsed.path.split(".").pop() ?? "";
    const block = `[inline-ref file@${parsed.path}${suffix}]\n\`\`\`${ext}\n${body}\n\`\`\`${warning}\n[/inline-ref]`;
    return { ...base, ok: true, content: block, sizeBytes };
  } catch (err) {
    return { ...base, ok: false, content: `讀檔失敗：${err instanceof Error ? err.message : String(err)}` };
  }
}

// ── Folder ────────────────────────────────────────────────────────────────────

function expandFolder(rawRest: string): ExpandedReference {
  const rest = stripQuotes(rawRest);
  const base: Pick<ExpandedReference, "kind" | "raw" | "target"> = {
    kind: "folder",
    raw: `@folder:${rawRest}`,
    target: rest,
  };

  const safe = isPathSafe(rest);
  if (!safe.ok) return { ...base, ok: false, content: `路徑被拒絕：${safe.reason}` };
  if (!existsSync(rest)) return { ...base, ok: false, content: `資料夾不存在：${rest}` };

  try {
    const stat = statSync(rest);
    if (!stat.isDirectory()) return { ...base, ok: false, content: `路徑不是資料夾：${rest}` };

    const lines: string[] = [];
    const walk = (dir: string, depth: number, prefix: string): void => {
      if (depth > FOLDER_DEPTH_LIMIT) return;
      if (lines.length >= MAX_FOLDER_ENTRIES) return;
      let entries: string[];
      try {
        entries = readdirSync(dir).sort();
      } catch {
        return;
      }
      for (const entry of entries) {
        if (lines.length >= MAX_FOLDER_ENTRIES) {
          lines.push(`${prefix}…(已達 ${MAX_FOLDER_ENTRIES} 條上限)`);
          return;
        }
        if (entry.startsWith(".")) continue;
        const full = join(dir, entry);
        let isDir = false;
        try {
          isDir = statSync(full).isDirectory();
        } catch {
          continue;
        }
        lines.push(`${prefix}${isDir ? "📁" : "📄"} ${entry}`);
        if (isDir && depth < FOLDER_DEPTH_LIMIT) walk(full, depth + 1, prefix + "  ");
      }
    };
    walk(rest, 0, "");

    const tree = lines.join("\n");
    const block = `[inline-ref folder@${rest}]\n${tree}\n[/inline-ref]`;
    return { ...base, ok: true, content: block, sizeBytes: Buffer.byteLength(tree, "utf-8") };
  } catch (err) {
    return { ...base, ok: false, content: `列舉資料夾失敗：${err instanceof Error ? err.message : String(err)}` };
  }
}

// ── Git ──────────────────────────────────────────────────────────────────────

function expandGit(rawRest: string, cwd: string): ExpandedReference {
  const commitish = rawRest;
  const base: Pick<ExpandedReference, "kind" | "raw" | "target"> = {
    kind: "git",
    raw: `@git:${rawRest}`,
    target: commitish,
  };
  // 限定 commitish 字符集（避免 shell 注入）
  if (!/^[a-zA-Z0-9_./~@^-]+$/.test(commitish)) {
    return { ...base, ok: false, content: "commitish 含不允許字符" };
  }
  try {
    const out = execSync(`git show --stat ${commitish}`, {
      cwd,
      encoding: "utf-8",
      timeout: 5000,
      maxBuffer: MAX_GIT_DIFF_BYTES,
    });
    const trimmed = out.length > MAX_GIT_DIFF_BYTES ? out.slice(0, MAX_GIT_DIFF_BYTES) + "\n…(已截斷)" : out;
    const block = `[inline-ref git@${commitish}]\n${trimmed}\n[/inline-ref]`;
    return { ...base, ok: true, content: block, sizeBytes: Buffer.byteLength(out, "utf-8") };
  } catch (err) {
    return { ...base, ok: false, content: `git show 失敗：${err instanceof Error ? err.message : String(err)}` };
  }
}

function expandDiff(cwd: string, staged: boolean): ExpandedReference {
  const kind: ReferenceKind = staged ? "staged" : "diff";
  const raw = staged ? "@staged" : "@diff";
  const base: Pick<ExpandedReference, "kind" | "raw" | "target"> = { kind, raw, target: "" };
  try {
    const cmd = staged ? "git diff --staged" : "git diff";
    const out = execSync(cmd, {
      cwd,
      encoding: "utf-8",
      timeout: 5000,
      maxBuffer: MAX_GIT_DIFF_BYTES,
    });
    if (!out.trim()) {
      return { ...base, ok: true, content: `[inline-ref ${kind}]\n(no changes)\n[/inline-ref]`, sizeBytes: 0 };
    }
    const trimmed = out.length > MAX_GIT_DIFF_BYTES ? out.slice(0, MAX_GIT_DIFF_BYTES) + "\n…(已截斷)" : out;
    const block = `[inline-ref ${kind}]\n${trimmed}\n[/inline-ref]`;
    return { ...base, ok: true, content: block, sizeBytes: Buffer.byteLength(out, "utf-8") };
  } catch (err) {
    return { ...base, ok: false, content: `${kind} 失敗：${err instanceof Error ? err.message : String(err)}` };
  }
}

// ── URL ──────────────────────────────────────────────────────────────────────

async function expandUrl(url: string): Promise<ExpandedReference> {
  const base: Pick<ExpandedReference, "kind" | "raw" | "target"> = {
    kind: "url",
    raw: `@url:${url}`,
    target: url,
  };
  if (!/^https?:\/\//.test(url)) {
    return { ...base, ok: false, content: "URL 必須是 http/https" };
  }
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(URL_TIMEOUT_MS) });
    let text = await res.text();
    const origLen = text.length;
    let warning = "";
    if (text.length > MAX_URL_BYTES) {
      text = text.slice(0, MAX_URL_BYTES);
      warning = `\n[⚠️ inline-ref 已截斷：原 ${origLen} bytes / 上限 ${MAX_URL_BYTES} bytes]`;
    }
    const status = res.ok ? "" : ` [⚠️ HTTP ${res.status}]`;
    const block = `[inline-ref url@${url}${status}]\n${text}${warning}\n[/inline-ref]`;
    return { ...base, ok: true, content: block, sizeBytes: Buffer.byteLength(text, "utf-8") };
  } catch (err) {
    return { ...base, ok: false, content: `URL fetch 失敗：${err instanceof Error ? err.message : String(err)}` };
  }
}

// ── 主函式 ────────────────────────────────────────────────────────────────────

export interface ExpandReferencesOpts {
  /** Git / 路徑相對解析的工作目錄。預設 process.cwd() */
  cwd?: string;
}

export function hasReferences(prompt: string): boolean {
  return HAS_REF_PATTERN.test(prompt);
}

export async function expandReferences(
  prompt: string,
  opts: ExpandReferencesOpts = {},
): Promise<{ expanded: string; results: ExpandedReference[] }> {
  if (!hasReferences(prompt)) return { expanded: prompt, results: [] };

  const cwd = opts.cwd ?? process.cwd();
  const results: ExpandedReference[] = [];
  // 用 matchAll 取所有命中（每次拿 fresh iterator）
  const matches = [...prompt.matchAll(REF_REGEX)];

  for (const m of matches) {
    const inner = m[1]!;
    let result: ExpandedReference;
    if (inner === "diff") {
      result = expandDiff(cwd, false);
    } else if (inner === "staged") {
      result = expandDiff(cwd, true);
    } else if (inner.startsWith("file:")) {
      result = expandFile(inner.slice(5));
    } else if (inner.startsWith("folder:")) {
      result = expandFolder(inner.slice(7));
    } else if (inner.startsWith("git:")) {
      result = expandGit(inner.slice(4), cwd);
    } else if (inner.startsWith("url:")) {
      result = await expandUrl(inner.slice(4));
    } else {
      continue;
    }
    results.push(result);
  }

  if (results.length === 0) return { expanded: prompt, results: [] };

  // 在 prompt 末尾附加展開內容（保留原 @ref 字樣，讓 LLM 知道對應）
  const expansionBlock = results
    .map(r => (r.ok ? r.content : `[inline-ref ${r.kind}@${r.target} ⚠️ 失敗]\n${r.content}\n[/inline-ref]`))
    .join("\n\n");
  const expanded = `${prompt}\n\n${expansionBlock}`;

  log.debug(
    `[context-references] 展開 ${results.length} 個 ref（成功 ${results.filter(r => r.ok).length}）`,
  );
  return { expanded, results };
}
