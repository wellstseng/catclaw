# catclaw-opt-planning-frameworks-6

- Scope: shared
- Confidence: [固]
- Trigger: 規劃框架, planning, ReAct, Tree of Thoughts, Plan-and-Execute, LLM-Modulo, agent planning
- Created-at: 2026-05-21
- Related: catclaw-opt-agent-loop-2, catclaw-opt-context-management-1

## 知識

### 四大 LLM Agent 規劃框架

### ReAct（arXiv:2210.03629, ICLR 2023）
- 核心：Thought→Action→Observation 交替迴圈
- 關鍵數據：HotpotQA 比 CoT 高 ~30%；ALFWorld 比 RL 高 34% 絕對成功率
- 優點：適應性強、只需 1-2 個 in-context 示例、可解釋性高
- 限制：無 Circuit Breaker、短視規劃（每步只看 1 步）、Context 累積

### Tree of Thoughts（arXiv:2305.10601, NeurIPS 2023）
- 核心：樹狀推理結構，每節點多候選 + LLM 評估 + BFS/DFS 搜尋
- 關鍵數據：Game of 24 任務 GPT-4+CoT=4%，GPT-4+ToT=74%（18.5倍）
- 優點：解決 CoT 無法回溯的缺陷，複雜推理品質大幅提升
- 限制：成本極高（CoT 的 10-100 倍）、延遲高、設計需要領域知識
- 輕量替代：「三位專家輪流思考」的單一 Prompt 技巧

### Plan-and-Execute（LangGraph 2024）
- 核心：大型 LLM 先做全局規劃，再用小型模型逐步執行
- 優點：成本低（執行階段用小模型）、速度快、全局品質好
- 限制：計畫可能過時、重新規劃成本高、動態環境適應差
- 最適場景：超過 10 步的長工作流

### LLM-Modulo（arXiv:2402.01817, ICML 2024）
- 核心論點：「Auto-regressive LLM 本質上無法可靠規劃或自我驗證」
- 解法：LLM 生成候選計畫 → 外部驗證器審查 → 失敗反饋給 LLM → 修正迭代
- 優點：可靠性最高，驗證器保證正確性
- 限制：需要設計領域驗證器（工程成本高），適用範圍有限

### 選擇原則
- 動態互動任務 → ReAct（+Circuit Breaker）
- 複雜推理謎題 → ToT 或 ToT-Lite（三專家 Prompt）
- 長多步驟工作流 → Plan-and-Execute
- 高風險/需合規 → LLM-Modulo（外部驗證器）
- 最佳混合：整體用 Plan-and-Execute，每步內部用輕量 ReAct

## 行動

- （依知識內容判斷）
