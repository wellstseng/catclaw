/**
 * @file tools/builtin/web-search.ts
 * @description web_search — 使用 DuckDuckGo 搜尋網頁，回傳標題 + URL + 摘要
 *
 * 對應 Claude Code WebSearch tool
 * 設計：
 * - 使用 DuckDuckGo HTML lite 端點（無需 API key）
 * - 解析 result__a + result__snippet 取出結構化結果
 * - 支援 allowed_domains / blocked_domains 過濾
 * - 最多回傳 10 筆
 */

import type { Tool } from "../types.js";
import { log } from "../../logger.js";

const MAX_RESULTS    = 10;
const SEARCH_TIMEOUT_MS = 12_000;

// ── DuckDuckGo HTML 解析 ──────────────────────────────────────────────────────

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

function parseDdgHtml(html: string): SearchResult[] {
  const results: SearchResult[] = [];

  // DDG HTML lite 格式（https://html.duckduckgo.com/html/）：
  //   結果 URL: <a class="result__a" href="//duckduckgo.com/l/?uddg=<encoded_url>&..."
  //   摘要: <a class="result__snippet" ...>摘要文字</a>
  //   (或 <td class="result__snippet">...)

  const blockRe = /<h2[^>]*class="result__title"[^>]*>[\s\S]*?<a[^>]+class="result__a"[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|td)>)?/gi;

  for (const match of html.matchAll(blockRe)) {
    const rawHref = match[1] ?? "";
    const rawTitle = match[2] ?? "";
    const rawSnippet = match[3] ?? "";

    // 解出真實 URL（DDG 用 redirect）
    let url = rawHref;
    const uddgMatch = rawHref.match(/[?&]uddg=([^&]+)/);
    if (uddgMatch?.[1]) {
      try { url = decodeURIComponent(uddgMatch[1]); } catch { /* keep raw */ }
    } else if (rawHref.startsWith("//")) {
      url = "https:" + rawHref;
    }

    const title   = rawTitle.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    const snippet = rawSnippet.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();

    if (!url || !title) continue;
    results.push({ title, url, snippet });
  }

  return results;
}

// ── Tool ──────────────────────────────────────────────────────────────────────

export const tool: Tool = {
  name: "web_search",
  description: `使用 DuckDuckGo 搜尋網頁，回傳標題、URL、摘要（最多 10 筆）。
支援 allowed_domains（只顯示指定網域）和 blocked_domains（排除指定網域）。`,
  tier: "elevated",
  resultTokenCap: 4000,
  timeoutMs: 15_000,
  concurrencySafe: true,
  deferred: true,
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "搜尋關鍵字",
      },
      allowed_domains: {
        type: "array",
        items: { type: "string" },
        description: "只顯示這些網域的結果（例：[\"github.com\",\"npmjs.com\"]）",
      },
      blocked_domains: {
        type: "array",
        items: { type: "string" },
        description: "排除這些網域的結果",
      },
    },
    required: ["query"],
  },

  async execute(params) {
    const query = String(params["query"] ?? "").trim();
    if (!query) return { error: "query 不能為空" };

    const allowedDomains = Array.isArray(params["allowed_domains"])
      ? (params["allowed_domains"] as unknown[]).map(String)
      : [];
    const blockedDomains = Array.isArray(params["blocked_domains"])
      ? (params["blocked_domains"] as unknown[]).map(String)
      : [];

    const t0 = Date.now();
    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=wt-wt`;

    let html: string;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
      try {
        const res = await fetch(searchUrl, {
          signal: controller.signal,
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; CatClaw/1.0)",
            "Accept": "text/html,*/*;q=0.9",
            "Accept-Language": "en-US,en;q=0.9",
          },
        });
        html = await res.text();
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      return { error: `搜尋失敗：${err instanceof Error ? err.message : String(err)}` };
    }

    log.debug(`[web-search] query="${query}" html=${html.length} chars`);

    let results = parseDdgHtml(html);

    // 套用 domain 過濾
    if (allowedDomains.length > 0 || blockedDomains.length > 0) {
      results = results.filter(r => {
        let host = "";
        try { host = new URL(r.url).hostname; } catch { host = r.url; }
        if (allowedDomains.length > 0 && !allowedDomains.some(d => host.includes(d))) return false;
        if (blockedDomains.length > 0 &&  blockedDomains.some(d => host.includes(d))) return false;
        return true;
      });
    }

    results = results.slice(0, MAX_RESULTS);

    return {
      result: {
        query,
        count: results.length,
        durationMs: Date.now() - t0,
        results,
      },
    };
  },
};
