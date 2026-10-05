# catclaw-opt-context-management-1

- Scope: shared
- Confidence: [固]
- Trigger: context management, context rot, sliding window, sticky notes, CE壓縮, token管理, context window
- Created-at: 2026-05-21
- Related: catclaw-opt-agent-loop-2, catclaw-opt-memory-arch-3

## 知識

### Agent Context Window 管理 4 大策略

### 核心問題：Context Rot
LLM 存在「context rot」現象：context 增長時，模型對中段資訊的回憶準確度下降。
transformer n² attention 特性導致：模型更聚焦開頭/結尾，中段資訊事實上「消失」。
真實症狀：第 40-50 輪後出現遺忘早期指令、重複解釋、陷入循環。

### 4 種策略

1. **Truncation（截斷）**：保留 system prompt，從最舊訊息開始刪除。最簡單、最便宜。
   - 適用：任務導向、舊 context 很快失去相關性
   - 缺點：丟失資訊永久消失

2. **Summarization（摘要）**：用快速模型壓縮最舊的半段訊息。
   - 適用：早期 context 重要但不需逐字保留
   - 缺點：額外 LLM 呼叫；損失細節

3. **Retrieval（向量檢索）**：舊訊息存向量 DB，按語意檢索。
   - 適用：100+ 輪長 session
   - 缺點：設置成本高

4. **Sliding Window + Sticky Notes（業界最佳生產方案）**：
   - 最近 N 輪完整保留 + 從整個 session 萃取的「黏性事實」
   - 黏性事實 = 使用者偏好 + 重要決策 + 專案固定事實
   - 注入 system prompt 末尾

### CatClaw 現況對比
CatClaw 有 CE（Context Engineering）壓縮機制，但主要是被動截斷，
缺乏 Sticky Notes 主動萃取。應在每隔 N 輪後用 haiku 萃取 sticky facts。

### Anthropic Context Engineering 核心原則
- 找最小高信號 token 集合：「tight and informative」
- System prompt 要有「正確高度」：不要 hardcode 過多邏輯，也不要太模糊
- 工具不超過 8-10 個，超過效能遞減
- Few-shot 用多元典型案例，不要窮舉邊緣情況

## 行動

- （依知識內容判斷）
