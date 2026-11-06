/**
 * @file memory/write-gate.ts
 * @description Write Gate — 品質閘門，防止重複/注入知識持久化
 *
 * Q1: 向量相似度 ≥ 0.80 → 跳過（dedup）
 * Q2: 使用者明確說「記住」→ 跳過 gate（真實 token／私鑰例外：記憶會被注入送給模型供應商，一律不收）
 * Q4: Prompt Injection 過濾
 * 敏感字眼（findSensitiveWords）：不擋，交呼叫端決定（背景萃取命中就不寫進 global／project 層）
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { log } from "../logger.js";

// ── Threat Pattern 分類偵測（擴充自原 INJECTION） ─────────────────────────────

const INJECTION_PATTERNS = [
  /ignore\s+(previous|all|above|prior)\s+instructions?/i,
  /forget\s+(everything|all|your|previous)/i,
  /you\s+are\s+now\s+(a|an)\s+/i,
  /pretend\s+(you|to)\s+(are|be)/i,
  /act\s+as\s+(if\s+you\s+are|a\s+)/i,
  /your\s+new\s+(role|persona|instruction)/i,
  /system\s+prompt/i,
  /<\|?(im_start|im_end|user|assistant|system)\|?>/i,
  /\[INST\]|\[\/INST\]/,
  /###\s+(Human|Assistant|System):/,
];

const EXFILTRATION_PATTERNS = [
  /curl\s+[^\n]*[\$\{]\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i,
  /wget\s+[^\n]*[\$\{]\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i,
  /cat\s+[^\n]*(\.env|credentials|\.netrc|\.pgpass|\.npmrc|\.pypirc)/i,
  /cat\s+[^\n]*(~|\$HOME)\/\.(ssh|aws|gnupg|kube|docker|azure)/i,
];

const PERSISTENCE_PATTERNS = [
  /authorized_keys/i,
  /(~|\$HOME)\/\.ssh(\/|$)/i,
  /(~|\$HOME)\/\.catclaw\/\.env/i,
  /\.(zshrc|bashrc|profile|bash_profile|zprofile)/i,
  /crontab\s+-e|\/etc\/cron/i,
];

const SECRET_PATTERNS = [
  /\bsk-[a-zA-Z0-9]{32,}\b/,
  /\bsk-ant-[a-zA-Z0-9_-]{32,}\b/,
  /BEGIN\s+(?:RSA\s+|DSA\s+|EC\s+|OPENSSH\s+|ENCRYPTED\s+)?PRIVATE\s+KEY/,
  /\beyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b/,   // JWT：header 是 base64 的 {"，一定 eyJ 開頭（不認 eyJ 時長套件名也會被當成 token）
  /\bgh[pousr]_[a-zA-Z0-9]{30,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bglpat-[A-Za-z0-9_-]{16,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[bpsa]-[a-zA-Z0-9-]{10,}\b/,
];

/**
 * 個人隱私／內網位址的字眼（對拍 ~/.claude lib/sensitive_gate.py SENSITIVE_WORD_RE）。
 * 一般技術知識也會提到，所以只回報、不擋；由呼叫端依情境決定（背景萃取沒人能判 → 不進大家都撈得到的層）。
 */
const SENSITIVE_WORD_RE = new RegExp(
  [
    "密碼(?!學)", "(?<![a-z0-9])passwords?\\b", "passwd", "私鑰", "金鑰", "憑證", "credentials?\\b",   // 密碼學、1Password 不算
    "api[_ -]?key", "access[_ -]?token", "private[_ -]?token",
    "身分證", "身份證", "手機號碼", "信用卡", "銀行帳號", "住家地址", "薪資",
    "\\\\\\\\[A-Za-z0-9][\\w.-]*\\\\[^\\s\\\\]+",          // 內網共用資料夾 \\host\share
    "(?<![:\\w/.\"'=(])//[A-Za-z0-9][\\w.-]*/[\\w$.-]+",   // 同一條路徑的正斜線寫法；https://host/path、src=\"//cdn…\" 不算
    "(?<![\\d.])(?:192\\.168|10\\.\\d{1,3}|172\\.(?:1[6-9]|2\\d|3[01]))\\.\\d{1,3}\\.\\d{1,3}(?![.\\d])", // 內網 IP（前後接數字或點的不算）
  ].join("|"),
  "gi",
);

/** 回傳命中的敏感字眼（小寫、去重、保序）；沒命中回空陣列。 */
export function findSensitiveWords(text: string): string[] {
  const hits = (text ?? "").match(SENSITIVE_WORD_RE) ?? [];
  return [...new Set(hits.map(h => h.toLowerCase()))];
}

export type ThreatCategory = "prompt_injection" | "exfiltration" | "persistence" | "secret";

export interface ThreatMatch {
  category: ThreatCategory;
  patternIndex: number;
  snippet: string;
}

/** 掃描文字，回傳所有命中的威脅 pattern。 */
export function scanThreats(text: string): ThreatMatch[] {
  const matches: ThreatMatch[] = [];
  const groups: Array<[ThreatCategory, RegExp[]]> = [
    ["prompt_injection", INJECTION_PATTERNS],
    ["exfiltration", EXFILTRATION_PATTERNS],
    ["persistence", PERSISTENCE_PATTERNS],
    ["secret", SECRET_PATTERNS],
  ];
  for (const [cat, pats] of groups) {
    for (let i = 0; i < pats.length; i++) {
      const m = text.match(pats[i]!);
      if (m) matches.push({ category: cat, patternIndex: i, snippet: m[0].slice(0, 80) });
    }
  }
  return matches;
}

/** 向後相容 — 舊呼叫端仍可用。內部走新 scanThreats。 */
export function hasInjectionPattern(text: string): boolean {
  return scanThreats(text).some(t => t.category === "prompt_injection");
}

// ── 主要 Write Gate 邏輯 ──────────────────────────────────────────────────────

export interface WriteGateOpts {
  /** 若 true，跳過向量 dedup（使用者明確說「記住」） */
  bypass?: boolean;
  /** dedup 向量相似度門檻（預設 0.80） */
  dedupThreshold?: number;
  /** 向量搜尋 namespace */
  namespace?: string;
}

export interface WriteGateResult {
  allowed: boolean;
  reason: "bypass" | "injection" | "secret" | "duplicate" | "ok" | "quarantine";
  similarity?: number;
  /** 偵測到的威脅清單（reason=injection / secret / quarantine 時帶） */
  threats?: ThreatMatch[];
}

/**
 * 檢查知識項目是否通過 write gate
 *
 * @param content   要寫入的知識文字
 * @param namespace 向量搜尋 namespace（用於 dedup 比對）
 * @param opts      選項
 */
export async function checkWriteGate(
  content: string,
  namespace: string,
  opts: WriteGateOpts = {}
): Promise<WriteGateResult> {
  const threshold = opts.dedupThreshold ?? 0.72;

  const threats = scanThreats(content);

  // ── Q2: bypass（使用者明確指示）：真實 token／私鑰照擋，其餘跳過 gate ──
  if (opts.bypass) {
    const secrets = threats.filter(t => t.category === "secret");
    if (secrets.length > 0) {
      log.warn("[write-gate] bypass 但內容含真實 token／私鑰 → reject");
      return { allowed: false, reason: "secret", threats: secrets };
    }
    log.debug("[write-gate] bypass — 跳過 gate");
    return { allowed: true, reason: "bypass" };
  }

  // ── Q4: Threat Pattern 分類偵測 ──
  if (threats.length > 0) {
    // 嚴重類別 → reject；有 prompt injection 回 injection，只有真實 token／私鑰回 secret（給使用者的訊息才不會說成注入）
    const reject = threats.filter(t => t.category === "prompt_injection" || t.category === "secret");
    if (reject.length > 0) {
      log.warn(`[write-gate] reject: ${[...new Set(reject.map(t => t.category))].join(", ")}`);
      const onlySecret = reject.every(t => t.category === "secret");
      return { allowed: false, reason: onlySecret ? "secret" : "injection", threats };
    }
    // 中等類別 → quarantine（caller 可選擇 writeQuarantine 落檔審核）
    const quarantine = threats.filter(t => t.category === "exfiltration" || t.category === "persistence");
    if (quarantine.length > 0) {
      log.warn(`[write-gate] quarantine: ${[...new Set(quarantine.map(t => t.category))].join(", ")}`);
      return { allowed: false, reason: "quarantine", threats };
    }
  }

  // ── Q1: 向量相似度 dedup ──
  try {
    const { getVectorService } = await import("../vector/lancedb.js");
    const vsvc = getVectorService();
    if (vsvc.isAvailable()) {
      const results = await vsvc.search(content, {
        namespace,
        topK: 1,
        minScore: threshold,
      });
      if (results.length > 0 && results[0].score >= threshold) {
        log.debug(`[write-gate] dedup — 相似度 ${results[0].score.toFixed(3)} ≥ ${threshold}，跳過`);
        return { allowed: false, reason: "duplicate", similarity: results[0].score };
      }
    }
  } catch (err) {
    // Vector service 不可用 → 放行（graceful）
    log.debug(`[write-gate] vector 不可用，放行：${err instanceof Error ? err.message : String(err)}`);
  }

  return { allowed: true, reason: "ok" };
}

// ── Quarantine 寫入 ──────────────────────────────────────────────────────────

export interface QuarantineCtx {
  /** workspace 根目錄（用於決定 _staging/quarantine/ 位置） */
  workspaceDir: string;
  /** 觸發的 agent ID（記錄用） */
  agentId?: string;
  /** 額外說明（記錄用） */
  reason?: string;
}

/**
 * 把疑似威脅內容寫入 _staging/quarantine/，標 requires_review 等待 /memory-review 審核。
 *
 * @returns 寫入的絕對路徑
 */
export async function writeQuarantine(
  content: string,
  threats: ThreatMatch[],
  ctx: QuarantineCtx,
): Promise<string> {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const cat = threats[0]?.category ?? "unknown";
  const dir = join(ctx.workspaceDir, "_staging", "quarantine");
  await mkdir(dir, { recursive: true });
  const filename = `${ts}-${cat}.md`;
  const path = join(dir, filename);
  const categories = [...new Set(threats.map(t => t.category))];
  const body = [
    `---`,
    `quarantined_at: ${new Date().toISOString()}`,
    `agent_id: ${ctx.agentId ?? "unknown"}`,
    `categories: [${categories.join(", ")}]`,
    `reason: ${ctx.reason ?? "auto-detected threat patterns"}`,
    `requires_review: true`,
    `---`,
    ``,
    `## Threats Detected`,
    ...threats.map(t => `- [${t.category}] pattern[${t.patternIndex}] snippet: \`${t.snippet}\``),
    ``,
    `## Original Content`,
    ``,
    content,
    ``,
  ].join("\n");
  await writeFile(path, body, "utf-8");
  log.info(`[write-gate] quarantined to ${path}`);
  return path;
}
