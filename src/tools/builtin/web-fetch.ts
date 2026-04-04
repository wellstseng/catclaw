/**
 * @file tools/builtin/web-fetch.ts
 * @description web_fetch — 抓取 URL 內容，HTML 轉純文字後回傳
 *
 * 對應 Claude Code WebFetch tool（簡化版：不做 LLM 後處理，由呼叫方 LLM 自行處理）
 * 設計：
 * - HTML → 脫標籤 + decode HTML entities → 純文字
 * - JSON → pretty print
 * - 其他 text/* → 原始文字
 * - 超過 MAX_BODY_BYTES → 截斷
 * - SSRF 保護：拒絕私有 IP / localhost
 */

import type { Tool } from "../types.js";
import { log } from "../../logger.js";

const MAX_BODY_BYTES  = 400_000;  // 400KB 上限
const FETCH_TIMEOUT_MS = 15_000;

// ── SSRF 保護：拒絕私有/保留 IP 位址 ─────────────────────────────────────────

const PRIVATE_HOST_RE =
  /^(localhost|127\.\d+\.\d+\.\d+|::1|0\.0\.0\.0|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|169\.254\.\d+\.\d+|fc[0-9a-f]{2}:|fd[0-9a-f]{2}:)/i;

function isSafeUrl(url: URL): boolean {
  return !PRIVATE_HOST_RE.test(url.hostname);
}

// ── HTML → 純文字 ─────────────────────────────────────────────────────────────

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\t/g, " ")
    .replace(/ {3,}/g, "  ")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

// ── Tool ──────────────────────────────────────────────────────────────────────

export const tool: Tool = {
  name: "web_fetch",
  description: `抓取 URL 的內容並以純文字回傳。
- HTML 自動轉純文字（去標籤 + decode entities）
- JSON 格式化後回傳
- 其他 content-type 回傳原始文字
- 超過 400KB 自動截斷`,
  tier: "elevated",
  resultTokenCap: 8000,
  timeoutMs: 20_000,
  concurrencySafe: true,
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "要抓取的 URL" },
    },
    required: ["url"],
  },

  async execute(params) {
    const rawUrl = String(params["url"] ?? "").trim();
    if (!rawUrl) return { error: "url 不能為空" };

    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return { error: `無效 URL：${rawUrl}` };
    }

    if (!["http:", "https:"].includes(parsed.protocol)) {
      return { error: `不支援的協定：${parsed.protocol}（僅允許 http/https）` };
    }

    if (!isSafeUrl(parsed)) {
      return { error: "拒絕存取私有 / 本機 IP（SSRF 保護）" };
    }

    const t0 = Date.now();
    let response: Response;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        response = await fetch(rawUrl, {
          signal: controller.signal,
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; CatClaw/1.0; +https://github.com/wellstseng/catclaw)",
            "Accept": "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.8",
            "Accept-Language": "zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7",
          },
          redirect: "follow",
        });
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: `fetch 失敗：${msg}` };
    }

    const contentType = response.headers.get("content-type") ?? "";
    log.debug(`[web-fetch] ${rawUrl} status=${response.status} contentType=${contentType}`);

    // 讀取 body（帶大小上限）
    let raw = "";
    let truncated = false;
    try {
      const reader = response.body?.getReader();
      if (!reader) {
        raw = await response.text();
      } else {
        const decoder = new TextDecoder("utf-8", { fatal: false });
        let totalBytes = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            totalBytes += value.length;
            raw += decoder.decode(value, { stream: true });
            if (totalBytes >= MAX_BODY_BYTES) {
              truncated = true;
              reader.cancel().catch(() => {});
              break;
            }
          }
        }
        raw += decoder.decode(); // flush
      }
    } catch (err) {
      return { error: `讀取 body 失敗：${err instanceof Error ? err.message : String(err)}` };
    }

    // 依 content-type 處理
    let content: string;
    if (contentType.includes("application/json") || contentType.includes("+json")) {
      try {
        content = JSON.stringify(JSON.parse(raw), null, 2);
      } catch {
        content = raw;
      }
    } else if (
      contentType.includes("text/html") ||
      contentType.includes("application/xhtml")
    ) {
      content = stripHtml(raw);
    } else {
      content = raw;
    }

    if (truncated) {
      content = content.slice(0, MAX_BODY_BYTES) + "\n\n[…截斷：已達 400KB 上限]";
    }

    return {
      result: {
        url: response.url,     // 可能因 redirect 而改變
        code: response.status,
        codeText: response.statusText,
        contentType,
        bytes: raw.length,
        durationMs: Date.now() - t0,
        content,
      },
    };
  },
};
