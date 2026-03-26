/**
 * @file core/agent-registry.ts
 * @description Agent 設定解析 — 支援多 bot 啟動（--agent <id>）
 *
 * catclaw.json 可定義多個 agent，每個 agent 可覆寫頂層預設：
 *
 * {
 *   "providers": { "claude-api": { ... } },
 *   "agents": {
 *     "support-bot": {
 *       "discord": { "token": "${SUPPORT_BOT_TOKEN}" },
 *       "providers": { "claude-api": { "model": "claude-haiku-4-5-20251001" } }
 *     },
 *     "dev-bot": {
 *       "discord": { "token": "${DEV_BOT_TOKEN}" }
 *     }
 *   }
 * }
 *
 * 深合併規則：
 * - 純值 → agent 覆寫頂層
 * - Object → 遞迴合併（agent 優先）
 * - Array → agent 完全替換頂層（不 concat）
 * - Per-agent data 路徑：~/.catclaw/agents/{id}/
 */

import { log } from "../logger.js";
import type { BridgeConfig, AgentsConfig } from "./config.js";

// ── 深合併工具 ────────────────────────────────────────────────────────────────

export function deepMerge<T>(base: T, override: Partial<T>): T {
  if (typeof base !== "object" || base === null) return override as T ?? base;
  if (typeof override !== "object" || override === null) return override as T ?? base;

  const result = { ...base } as Record<string, unknown>;
  for (const [k, v] of Object.entries(override)) {
    const bv = (base as Record<string, unknown>)[k];
    if (Array.isArray(v)) {
      // Array → 替換（不 concat）
      result[k] = v;
    } else if (v !== null && typeof v === "object" && bv !== null && typeof bv === "object" && !Array.isArray(bv)) {
      // Object → 遞迴合併
      result[k] = deepMerge(bv as Record<string, unknown>, v as Record<string, unknown>);
    } else if (v !== undefined) {
      result[k] = v;
    }
  }
  return result as T;
}

// ── AgentRegistry ─────────────────────────────────────────────────────────────

export class AgentRegistry {
  constructor(private readonly agents: AgentsConfig) {}

  /**
   * 列出所有已設定的 agent ID
   */
  list(): string[] {
    return Object.keys(this.agents);
  }

  /**
   * 確認 agent ID 是否存在
   */
  has(agentId: string): boolean {
    return agentId in this.agents;
  }

  /**
   * 解析指定 agent 的完整設定（base + agent 覆寫深合併）
   */
  resolve(agentId: string, base: BridgeConfig): BridgeConfig {
    const overrides = this.agents[agentId];
    if (!overrides) {
      throw new Error(`[agent-registry] 找不到 agent：${agentId}`);
    }

    const merged = deepMerge(base, overrides as Partial<BridgeConfig>);
    log.info(`[agent-registry] 解析 agent=${agentId}`);
    return merged;
  }
}

// ── 全域單例 ──────────────────────────────────────────────────────────────────

let _registry: AgentRegistry | null = null;

export function initAgentRegistry(agents: AgentsConfig): AgentRegistry {
  _registry = new AgentRegistry(agents);
  log.info(`[agent-registry] 已初始化，agents=[${Object.keys(agents).join(",")}]`);
  return _registry;
}

export function getAgentRegistry(): AgentRegistry {
  if (!_registry) throw new Error("[agent-registry] 尚未初始化，請先呼叫 initAgentRegistry()");
  return _registry;
}

export function resetAgentRegistry(): void {
  _registry = null;
}
