# catclaw-opt-tool-design-4

- Scope: shared
- Confidence: [固]
- Trigger: tool design, tool use, MCP, deferred tools, 工具設計, tool description
- Created-at: 2026-05-21
- Related: catclaw-opt-agent-loop-2, catclaw-opt-context-management-1

## 知識

### AI Agent 工具設計最佳實踐

### 核心原則（Anthropic）
1. **工具數量上限：8-10 個**。超過後 LLM 效能遞減（工具選擇模糊）
2. 工具應「自成一體（self-contained）」、「對錯誤健壯（robust to error）」
3. 輸入參數要「描述性、無歧義」
4. 工具描述要讓人類工程師能明確判斷「什麼情況用哪個工具」
5. 工具輸出要 token 高效（避免回傳冗長 HTML/JSON）

### MCP（Model Context Protocol）效能數據
採用 MCP 標準化工具介面後：
- 任務完成速度提升 37%
- 任務成功率：93% vs 78%（無 MCP）
- Token 使用增加 42%（因 context caching）
- 延遲降低：p50 1.2s vs 1.8s

### 工具分組策略（CatClaw 相關）
CatClaw 已有 deferred tools 機制（按需載入 schema），這是正確方向。
建議強化：
- 核心工具集（每輪都帶）：≤8 個最常用工具
- 延伸工具集（deferred）：按任務類型按需載入
- 工具路由：讓 agent 能先查詢「有哪些工具可用」再決定是否載入

### 工具描述規範模板
每個工具應包含：
```
- 用途（what）：一句話說明工具做什麼
- 適用時機（when）：什麼情況下應該用
- 輸入格式（input）：參數說明
- 輸出格式（output）：回傳值說明
- 錯誤情況（errors）：常見錯誤及處理方式
- 注意事項（caveats）：限制和副作用
```

### 工具失敗模式
1. 工具集過大導致 LLM 選錯工具
2. 工具描述不清導致錯誤參數
3. 工具輸出過長消耗大量 context
4. 工具沒有冪等性（重複呼叫產生副作用）

## 行動

- （依知識內容判斷）
