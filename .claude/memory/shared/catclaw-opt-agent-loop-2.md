# catclaw-opt-agent-loop-2

- Scope: shared
- Confidence: [固]
- Trigger: agent架構, ReAct, plan-and-execute, multi-agent, reflexion, circuit breaker, agent loop
- Created-at: 2026-05-21
- Related: catclaw-opt-context-management-1, catclaw-opt-tool-design-4

## 知識

### 主流 Agent 架構比較

### 四大核心架構

| 架構 | 核心邏輯 | 適用 | 主要風險 |
|------|---------|------|---------|
| ReAct | 思考→行動→觀察→迴圈 | 互動式、動態 | 無限迴圈、失控成本 |
| Plan-and-Execute | 先規劃後逐步執行 | 多步驟工作流 | 計畫過時、缺適應性 |
| Reflexion | 執行後自我反思評估 | 需要學習迭代 | 成本高（比 ReAct 貴 50%） |
| Multi-Agent | 多個專業 Agent 協作 | 複雜平行任務 | 協調開銷、錯誤傳播 |

### ReAct 生產必備
- **Circuit Breaker**：必設最大迭代次數（建議 20-30 次）
- **費用上限**：每 session 費用硬限制
- **相同工具連續呼叫偵測**：N 次後觸發中斷或人工確認
- **每步 context 持久化**：支援斷點續跑

### Multi-Agent 協調模式
- Hub-and-Spoke：中央 orchestrator 分派，易監控但有瓶頸
- Pipeline：依序傳遞，適合確定性流程
- Peer-to-Peer：高擴展但除錯困難
- Hierarchy：複雜大任務，協調複雜度高

### 研究數據
- ReAct 比 zero-shot 可靠性提升 30%（Princeton/Google）
- 簡單任務：帶重試的 ReAct ≈ Reflexion 效果，但成本低 50%
- Multi-Agent 複雜任務完成率提升 25-40%，執行時間節省 30-60%

### 業界最佳：混合策略
整體用 Plan-and-Execute（可視性好、人可審查），
每個步驟內部允許 ReAct 靈活適應。

### CatClaw 現況對比
CatClaw 是一軌制 Agent Loop = ReAct 模式。
缺乏：(1) Circuit Breaker、(2) 顯式計畫層、(3) Orchestrator-Worker 規範。
建議優先補齊 Circuit Breaker，再逐步引入 Plan-and-Execute 支援。

## 行動

- （依知識內容判斷）
