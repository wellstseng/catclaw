/**
 * @file tools/builtin/memory-search-fulltext.ts
 * @description memory_search_fulltext — LLM 跨 session 訊息全文搜尋（項目 9 Phase 2）
 *
 * 給 Agent Loop 中的 LLM 用：
 *   - 比 memory_recall（atom 級記憶）更深，能查具體訊息文字
 *   - 比 grep（檔案系統）更聚焦，只查 catclaw 訊息歷史
 *   - 用例：「使用者上次提到 X 是什麼？」「我們之前討論過這個 bug 嗎？」
 */

import type { Tool } from "../types.js";

export const tool: Tool = {
  name: "memory_search_fulltext",
  description:
    "跨 session 訊息全文搜尋。從訊息索引（NDJSON）查使用者 / 助手 / tool_result 歷史。" +
    "比 memory_recall 更深（搜原始訊息文字），比 grep 更聚焦（限 catclaw 訊息）。",
  tier: "standard",
  deferred: false,
  resultTokenCap: 4000,
  concurrencySafe: true,
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "搜尋關鍵字（lowercase substring 比對）",
      },
      days: {
        type: "number",
        description: "限定最近 N 天（預設 30）",
      },
      limit: {
        type: "number",
        description: "結果筆數上限（預設 20，最大 200）",
      },
      role: {
        type: "string",
        enum: ["user", "assistant", "tool_result"],
        description: "限定訊息角色",
      },
      sessionKey: {
        type: "string",
        description: "限定 session（如 discord:ch:xxx）",
      },
      channelId: {
        type: "string",
        description: "限定 channel ID",
      },
    },
    required: ["query"],
  },

  async execute(params) {
    const query = String(params["query"] ?? "").trim();
    if (!query) return { error: "query 不能為空" };

    const days = typeof params["days"] === "number" ? Math.max(1, params["days"] as number) : 30;
    const limit = typeof params["limit"] === "number"
      ? Math.min(200, Math.max(1, params["limit"] as number))
      : 20;
    const role = params["role"] as "user" | "assistant" | "tool_result" | undefined;
    const sessionKey = typeof params["sessionKey"] === "string" ? (params["sessionKey"] as string) : undefined;
    const channelId = typeof params["channelId"] === "string" ? (params["channelId"] as string) : undefined;

    const { searchMessages } = await import("../../memory/fts-query.js");
    const hits = searchMessages({ query, days, limit, role, sessionKey, channelId });

    return {
      result: {
        query,
        days,
        total: hits.length,
        hits: hits.map(h => ({
          ts: new Date(h.message.ts).toISOString(),
          role: h.message.role,
          sessionKey: h.message.sessionKey,
          channelId: h.message.channelId,
          turnIndex: h.message.turnIndex,
          preview: h.preview,
        })),
      },
    };
  },
};
