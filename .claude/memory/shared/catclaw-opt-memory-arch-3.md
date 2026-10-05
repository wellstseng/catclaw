# catclaw-opt-memory-arch-3

- Scope: shared
- Confidence: [固]
- Trigger: memory architecture, episodic memory, semantic memory, working memory, 記憶系統, atom memory, LanceDB
- Created-at: 2026-05-21
- Related: catclaw-opt-context-management-1, catclaw-opt-observability-5

## 知識

### AI Agent 記憶系統架構

### 4 層記憶類型

| 類型 | 持久性 | 功能 | CatClaw 對應 |
|------|--------|------|------------|
| Short-term | Session 內 | 對話窗口（最近 N 輪） | message history |
| Working | 任務執行中 | 結構化 JSON scratchpad，追蹤推理狀態 | 目前缺乏 |
| Episodic | 跨 Session | 特定互動事件記錄（做了什麼、決策了什麼） | 目前缺乏 |
| Semantic / Procedural | 長期 | 使用者偏好、知識、行為規則 | atom memory |

### 長期記憶架構（生產級）
1. **向量層**：文字 embedding → HNSW 向量索引 → 語意相似搜尋（CatClaw 已有 LanceDB）
2. **Graph 層（進階）**：實體為節點，關係為邊，支援關係推理
3. **整合 Pipeline**：
   - 萃取（Extraction）：session 後 LLM 提取關鍵事實
   - 去重（Deduplication）：相似記憶更新不重複
   - 衝突解決：新觀察覆蓋舊矛盾記憶

### 記憶整合效能（Mem0 研究）
- 比 OpenAI built-in memory 準確率高 26%（LOCOMO benchmark）
- 回應速度快 91%
- Prompt token 節省達 90%

### Working Memory 重要性
Working memory = Agent 的推理暫存。複雜任務中應維護結構化 scratchpad：
```json
{
  "current_step": 2,
  "errors_detected": ["步驟 1 計算有誤"],
  "hypothesis": "嘗試路徑 B",
  "confidence": 0.7
}
```
關鍵：用 JSON 結構化而非自由文字，更穩定可靠。

### CatClaw 改進建議
1. 新增 Episodic 記憶層：session 結束後自動生成 100-200 字摘要，記錄做了什麼、關鍵決策、待辦
2. Episodic 與 Semantic atom 分開索引，避免檢索干擾
3. 考慮在複雜任務中實作 Working Memory scratchpad

## 行動

- （依知識內容判斷）
