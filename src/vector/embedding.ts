/**
 * @file vector/embedding.ts
 * @description Ollama embedding 服務 — 文字 → 向量，供 LanceDB 索引與搜尋使用
 *
 * - 使用 OllamaClient.embed()，支援 primary/fallback 自動切換
 * - Ollama offline 時 graceful fallback：回傳空陣列，讓上層決策
 * - 維護 embeddingDim 快取，避免每次重複查詢
 */

import { log } from "../logger.js";
import { getOllamaClient } from "../ollama/client.js";

// ── 型別 ─────────────────────────────────────────────────────────────────────

export interface EmbedResult {
  vectors: number[][];
  /** 向量維度（0 代表失敗） */
  dim: number;
}

// ── 維度快取 ──────────────────────────────────────────────────────────────────

let _cachedDim = 0;

export function getCachedDim(): number { return _cachedDim; }
export function setCachedDim(dim: number): void { _cachedDim = dim; }

// ── 公開 API ─────────────────────────────────────────────────────────────────

/**
 * 批次 embed 文字
 * @returns EmbedResult — vectors 為空陣列代表 Ollama 不可用（graceful fallback）
 */
export async function embedTexts(
  texts: string[],
  opts: { model?: string; timeout?: number } = {}
): Promise<EmbedResult> {
  if (!texts.length) return { vectors: [], dim: _cachedDim };

  try {
    const client = getOllamaClient();
    const vectors = await client.embed(texts, opts);

    if (!vectors.length) {
      log.debug("[embedding] embed 回傳空陣列（Ollama 不可用或無 embedding backend）");
      return { vectors: [], dim: _cachedDim };
    }

    const dim = vectors[0].length;
    if (dim !== _cachedDim) {
      log.debug(`[embedding] 維度更新 ${_cachedDim} → ${dim}`);
      _cachedDim = dim;
    }

    return { vectors, dim };
  } catch (err) {
    log.warn(`[embedding] embedTexts 失敗（graceful skip）：${err instanceof Error ? err.message : String(err)}`);
    return { vectors: [], dim: _cachedDim };
  }
}

/**
 * 單筆 embed（方便用）
 */
export async function embedOne(
  text: string,
  opts: { model?: string; timeout?: number } = {}
): Promise<number[]> {
  const result = await embedTexts([text], opts);
  return result.vectors[0] ?? [];
}

/**
 * 取得 embedding 維度（若尚未快取，發送一筆探測請求）
 * @returns 維度，失敗回傳 0
 */
export async function getEmbeddingDim(opts: { model?: string } = {}): Promise<number> {
  if (_cachedDim > 0) return _cachedDim;
  const result = await embedTexts(["test"], opts);
  return result.dim;
}
