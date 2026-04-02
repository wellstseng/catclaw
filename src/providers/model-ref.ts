/**
 * @file providers/model-ref.ts
 * @description Model Reference 解析 — "provider/model" 格式解析 + alias 對應
 *
 * 格式：
 *   "anthropic/claude-sonnet-4-6"  → { provider: "anthropic", model: "claude-sonnet-4-6" }
 *   "sonnet"                       → alias 查表 → { provider: "anthropic", model: "claude-sonnet-4-6" }
 *   "ollama/qwen3:8b"             → { provider: "ollama", model: "qwen3:8b" }
 */

// ── 型別 ─────────────────────────────────────────────────────────────────────

export interface ModelRef {
  provider: string;
  model: string;
}

/** catclaw.json agents.defaults.models 的 entry */
export interface ModelAliasEntry {
  alias?: string;
}

// ── Provider 正規化 ──────────────────────────────────────────────────────────

const PROVIDER_ALIASES: Record<string, string> = {
  "claude": "anthropic",
  "claude-api": "anthropic",
  "claude-oauth": "anthropic",
  "z.ai": "zai",
  "z-ai": "zai",
  "bedrock": "amazon-bedrock",
  "aws-bedrock": "amazon-bedrock",
  "google": "google-genai",
};

export function normalizeProviderId(raw: string): string {
  const normalized = raw.trim().toLowerCase();
  return PROVIDER_ALIASES[normalized] ?? normalized;
}

// ── 解析 ─────────────────────────────────────────────────────────────────────

/**
 * 解析 model reference 字串。
 *
 * @param raw - "provider/model" 或 alias 或純 model ID
 * @param aliases - alias → "provider/model" 的對照表（從 agents.defaults.models 建立）
 * @param defaultProvider - 無 provider 前綴時的預設 provider
 * @returns ModelRef 或 null（解析失敗）
 */
export function parseModelRef(
  raw: string,
  aliases?: Record<string, ModelAliasEntry>,
  defaultProvider?: string,
): ModelRef | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // 1. 先查 alias（反向查：找到 alias 值 === trimmed 的 entry）
  if (aliases) {
    // 正向：trimmed 是某個 entry 的 alias
    for (const [fullRef, entry] of Object.entries(aliases)) {
      if (entry.alias === trimmed) {
        return parseModelRefDirect(fullRef);
      }
    }
    // 也可能 trimmed 本身就是 key（"anthropic/claude-sonnet-4-6"）
    if (aliases[trimmed]) {
      return parseModelRefDirect(trimmed);
    }
  }

  // 2. 直接解析 "provider/model" 格式
  return parseModelRefDirect(trimmed, defaultProvider);
}

/**
 * 直接解析 "provider/model" 格式（不查 alias）。
 */
export function parseModelRefDirect(raw: string, defaultProvider?: string): ModelRef | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const slash = trimmed.indexOf("/");
  if (slash === -1) {
    // 無 slash：純 model ID，需要 defaultProvider
    if (!defaultProvider) return null;
    return { provider: normalizeProviderId(defaultProvider), model: trimmed };
  }

  const providerRaw = trimmed.slice(0, slash).trim();
  const model = trimmed.slice(slash + 1).trim();
  if (!providerRaw || !model) return null;

  return { provider: normalizeProviderId(providerRaw), model };
}

/**
 * 將 ModelRef 轉回字串格式。
 */
export function formatModelRef(ref: ModelRef): string {
  return `${ref.provider}/${ref.model}`;
}

/**
 * 從 agents.defaults.models 建立 alias → fullRef 的反向查詢表。
 */
export function buildAliasMap(models: Record<string, ModelAliasEntry>): Map<string, string> {
  const map = new Map<string, string>();
  for (const [fullRef, entry] of Object.entries(models)) {
    if (entry.alias) {
      map.set(entry.alias, fullRef);
    }
  }
  return map;
}
