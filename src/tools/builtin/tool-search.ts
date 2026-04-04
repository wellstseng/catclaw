/**
 * @file tools/builtin/tool-search.ts
 * @description tool_search — 查詢 deferred tool 的完整 schema
 *
 * Deferred tools 不在 LLM 的 tools 參數中注入完整 schema，
 * 僅在 system prompt 列出名稱+描述。LLM 呼叫此 tool 取得完整 schema 後，
 * agent-loop 會在下一輪 LLM 呼叫中注入該 tool 的完整定義。
 */

import { log } from "../../logger.js";
import { getToolRegistry } from "../registry.js";
import { toDefinition } from "../types.js";
import type { Tool, ToolContext, ToolResult } from "../types.js";

export const tool: Tool = {
  name: "tool_search",
  description: "查詢可用 tool 的完整 schema。傳入精確名稱（逗號分隔）或關鍵字搜尋。用於取得 deferred tool 的參數定義。",
  tier: "public",
  concurrencySafe: true,
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "精確名稱（如 \"web_search,spawn_subagent\"）或關鍵字搜尋",
      },
    },
    required: ["query"],
  },

  async execute(params: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const query = String(params["query"] ?? "").trim();
    if (!query) return { error: "query 不能為空" };

    const registry = getToolRegistry();
    const allTools = registry.all();

    // 嘗試精確名稱匹配（逗號分隔）
    const names = query.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
    const exactMatches = allTools.filter(t => names.includes(t.name.toLowerCase()));

    let matched: typeof allTools;
    if (exactMatches.length > 0) {
      matched = exactMatches;
    } else {
      // 關鍵字模糊搜尋（name + description）
      const keywords = query.toLowerCase().split(/\s+/);
      matched = allTools.filter(t => {
        const haystack = `${t.name} ${t.description}`.toLowerCase();
        return keywords.every(k => haystack.includes(k));
      });
    }

    if (matched.length === 0) {
      return { result: { message: "沒有符合的 tool", query } };
    }

    const definitions = matched.map(t => {
      const def = toDefinition(t);
      return {
        name: def.name,
        description: def.description,
        input_schema: def.input_schema,
      };
    });

    log.debug(`[tool-search] query="${query}" → ${definitions.length} matches: ${definitions.map(d => d.name).join(", ")}`);

    return { result: definitions };
  },
};
