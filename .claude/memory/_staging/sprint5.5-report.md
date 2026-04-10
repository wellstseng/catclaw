# Sprint 5.5 報告 — CatClaw vs Claude Code 差距補齊（第二階段）

**日期**：2026-04-05
**前次 Commits**：328044f, 1829499（Sprint 5）
**Branch**：main
**執行者**：朱蒂（Claude Opus 4.6）自主開發模式

---

## 目標

延續 Sprint 5，繼續補齊 CatClaw 與 Claude Code 之間的功能差距。

---

## 完成項目

### 1. MCP Tool Deferred Loading

**做了什麼**：
- `src/mcp/client.ts`：McpServerConfig 新增 `deferred?: boolean` 欄位
- `_registerTools()` 預設以 `deferred: true` 註冊 MCP tools
- 可透過 catclaw.json `mcpServers.{name}.deferred: false` 強制 eager 載入

**為什麼做**：
- MCP server 可能註冊大量 tools（10+），每個 tool 的完整 JSON Schema 會消耗 LLM context
- 設為 deferred 後，MCP tools 僅在 system prompt 列出名稱+描述（~1 行/tool）
- LLM 需要時透過 `tool_search` 取得完整 schema，按需載入
- 對標 Claude Code 的 ToolSearch deferred loading 機制

**如何做**：
- 在 `McpServerConfig` interface 新增 `deferred?: boolean`（預設 true）
- `_registerTools()` 讀取 `this.cfg.deferred !== false` 設定
- 將 `deferred` 標記注入到每個 MCP tool 的 registry 註冊

**潛在問題**：
- 已有的 MCP server（如 discord plugin）升級後變為 deferred，LLM 第一次呼叫需先經過 tool_search
- 若 LLM 不熟悉 tool_search 流程，可能直接嘗試呼叫未載入的 deferred tool → agent-loop 已有 fallback（工具不存在時回傳錯誤）
- 可透過 config `deferred: false` 回退到 eager 模式

**Config 範例**：
```json
{
  "mcpServers": {
    "discord": {
      "command": "node",
      "args": ["discord-mcp-server.js"],
      "deferred": false
    },
    "external-tools": {
      "command": "npx",
      "args": ["@some/mcp-server"]
    }
  }
}
```

### 2. Remote Trigger API（POST /api/trigger）

**做了什麼**：
- `src/core/dashboard.ts`：新增 `POST /api/trigger` 端點（~100 行）
- `src/core/dashboard.ts`：新增 `GET /api/trigger/:runId` 端點（~20 行）
- 完整的非同步/同步雙模式支援

**為什麼做**：
- Claude Code 支援外部 dispatch（channel / remote trigger）
- CatClaw 過去只能從 Discord 訊息觸發 agent
- 有了 trigger API，外部系統（CI/CD、webhook、cron service、其他 bot）可以直接觸發 CatClaw 任務
- 這是 CatClaw 從「Discord bot」邁向「通用 AI agent platform」的關鍵能力

**如何做**：
- 利用既有 dashboard HTTP server + auth 機制（token 驗證）
- 利用 SubagentRegistry 管理 trigger 任務的生命週期（reuse 已有基礎設施）
- 利用 agentLoop + agentType 系統（支援 runtime 參數：default/coding/explore/plan 等）
- 非同步模式（預設）：立即回傳 runId，背景執行
- 同步模式（async:false）：等待完成後回傳結果

**API 規格**：

```
POST /api/trigger
Authorization: Bearer <dashboard-token>

{
  "task": "搜尋專案中所有 TODO 並整理清單",     // 必填
  "channelId": "my-channel",                    // 可選，預設 "trigger-api"
  "accountId": "my-account",                    // 可選，預設 "api-trigger"
  "provider": "claude-sonnet",                  // 可選，預設使用 primary
  "runtime": "explore",                         // 可選，預設 "default"
  "maxTurns": 5,                                // 可選，預設 10
  "timeoutMs": 60000,                           // 可選，預設 120000
  "async": true,                                // 可選，預設 true
  "label": "TODO scan"                          // 可選，顯示用
}

Response (async):
{ "success": true, "runId": "xxx", "sessionKey": "xxx" }

Response (sync):
{ "success": true, "runId": "xxx", "result": "...", "turns": 3 }
```

```
GET /api/trigger/:runId
Authorization: Bearer <dashboard-token>

Response:
{
  "runId": "xxx",
  "status": "completed",
  "result": "...",
  "turns": 3,
  "createdAt": "...",
  "endedAt": "...",
  "label": "TODO scan"
}
```

**潛在問題**：
- trigger 任務共用 SubagentRegistry 的 maxConcurrent 限制（預設 3）
- 無 rate limiting（依賴 dashboard token 做存取控制）
- trigger 任務的 session 不會持久化（mode: "run"，完成即清除）
- 長時間任務可能佔用資源，建議設合理 timeoutMs

### 3. 已確認的既有功能（不需再開發）

| 功能 | 狀態 | 說明 |
|------|------|------|
| Worktree 隔離 | ✅ 已有 | `spawn-subagent.ts` 支援 `isolation: "worktree"` |
| Prompt Caching | ✅ 已有 | `claude-api.ts` 已設 `cacheRetention: "long"` |
| Deferred Tool Loading | ✅ 已有 | `tool-search.ts` + agent-loop deferred 機制完整 |
| Pattern-based Permission | ✅ 已有 | `guard.ts` 的 `parseShorthand()` |

---

## 測試方式

### 編譯測試
- `tsc --noEmit`：零錯誤 ✅
- `npm run build`：成功 ✅

### 功能測試（需手動驗證）

1. **MCP Deferred Loading**：
   - 確認 MCP tools 在 LLM system prompt 中顯示為 deferred listing
   - LLM 呼叫 tool_search 後可取得完整 schema 並使用
   - 設定 `deferred: false` 後回到 eager 模式

2. **Remote Trigger API**：
   ```bash
   # 非同步觸發
   curl -X POST http://localhost:8088/api/trigger \
     -H "Authorization: Bearer <token>" \
     -H "Content-Type: application/json" \
     -d '{"task":"hello world test","runtime":"default","maxTurns":1}'

   # 查詢狀態
   curl http://localhost:8088/api/trigger/<runId> \
     -H "Authorization: Bearer <token>"
   ```

---

## 統計

| 項目 | 數值 |
|------|------|
| 修改檔案 | 2 |
| 新增行數 | +125 |
| 刪除行數 | -2 |

---

## 完成度更新

Sprint 5 + 5.5 累計後，CatClaw 完成度估計從 **73-75%** 提升至約 **78-80%**。

### 功能對照表

| Claude Code 功能 | CatClaw 狀態 | 完成度 |
|------------------|-------------|--------|
| Hook System | ✅ | 100% |
| Pattern-based Permission | ✅ | 100% |
| /compact | ✅ | 100% |
| /context | ✅ | 100% |
| Deferred Tool Loading | ✅ | 100% |
| MCP Client（含 deferred） | ✅ | 100% |
| Worktree Isolation | ✅ | 100% |
| Prompt Caching | ✅ | 100% |
| Remote Trigger/Dispatch | ✅ | 90%（基礎功能完成，Discord 通知未整合） |
| Subagent System | ✅ | 95% |
| Context Engineering | ✅ | 90% |
| IDE Integration | ❌ | 0%（不適用，CatClaw 是 Discord bot） |
| Web UI | 🔶 | 70%（Dashboard 覆蓋監控，缺互動式 chat） |
| Thinking/Extended Thinking | ✅ | 100% |

### 剩餘差距（依優先序）
1. **Dashboard 互動式 Chat** — 在 Dashboard 直接與 agent 對話（不透過 Discord）
2. **Trigger Discord 通知整合** — trigger 完成後推送 Discord 通知
3. **Permission Pattern UI** — Dashboard 上管理 tool permission rules
