# catclaw-opt-observability-5

- Scope: shared
- Confidence: [固]
- Trigger: observability, agent evaluation, tracing, 可觀測性, 評估, benchmark, LLM-as-judge, red teaming
- Created-at: 2026-05-21
- Related: catclaw-opt-agent-loop-2, catclaw-opt-memory-arch-3

## 知識

### AI Agent 生產可觀測性與評估

### 傳統可觀測性 vs Agent 可觀測性
- 傳統：metrics + logs + traces
- Agent：metrics + traces + logs + **evaluations** + **governance（治理）**

### 5 大實踐（Microsoft Azure Agent Factory）

1. **建立 Trace 基礎設施**：追蹤每個 agent step 的輸入/輸出/延遲
2. **持續評估（LLM-as-judge）**：評估連貫性、事實性、安全性
3. **CI/CD 整合自動評估**：每次程式變動後自動跑評估，早發現迴歸
4. **AI 紅隊測試（Red Teaming）**：上線前模擬對抗性攻擊，發現安全漏洞
5. **生產環境持續監控**：指標 + trace + 告警 + 評估四合一

### Agent 評估多維度指標（業界建議）
- 任務完成率（Task Completion Rate）
- 推理鏈品質（Reasoning Chain Quality）—— 過程比結果更重要
- 工具選擇效率（Tool Selection Efficiency）
- 時間/資源效率（Cost Efficiency）
- 安全合規（Safety Compliance）
- 失敗適應性（Failure Recovery Rate）

### 評估框架比較
- AgentBench：多環境廣度好，不評估推理軌跡
- ToolBench：工具使用專項，但範圍窄
- WebArena：真實網頁環境，設置複雜
- τ-bench：pass^8 指標更嚴格（8 次嘗試成功率）

### CatClaw 現況與改進
CatClaw Dashboard 已有 Trace 功能。建議強化：
1. Trace 資料模型增加：任務進展分數、迴圈偵測標記、context 使用率
2. Cost 告警：session 費用超閾值時主動通知
3. 建立「標準任務集」（10-20 個代表性任務），每次重大改動後自動評估
4. 歷史評估曲線追蹤，可視化進步/退步

### 關鍵洞察
沒有可觀測性，無法診斷問題；沒有評估，無法衡量進步。
這是 CatClaw 從「能用」到「好用」的最關鍵投資之一。

## 行動

- （依知識內容判斷）
