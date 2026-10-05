# catclaw-opt-planning-impl-7

- Scope: shared
- Confidence: [固]
- Trigger: CatClaw規劃層, planning layer, circuit breaker, catclaw優化, 規劃實作
- Created-at: 2026-05-21
- Related: catclaw-opt-planning-frameworks-6, catclaw-opt-agent-loop-2

## 知識

### CatClaw 規劃層改進方案（具體實作）

### 現況問題
CatClaw 是純 ReAct 模式，缺乏：顯式規劃層、Circuit Breaker、計畫可視性、工具呼叫驗證

### P1：輕量規劃步驟（0.5天）
執行前輸出 JSON 格式計畫：task_summary + steps 清單 + estimated_steps + risk_assessment
- risk=high 才詢問確認；estimated_steps 用於動態設定 Circuit Breaker 上限

### P1：Circuit Breaker（0.5天）
maxIterations=30；maxCostUSD=$0.50；sameToolRepeatLimit=3；
stuckDetection（5步內相似度>90% → 迴圈警告）
觸發後詢問使用者，不靜默失敗。

### P2：Plan-and-Execute 模式（2-3天）
長任務（>5步）顯示進度「[2/7] 正在...」；計畫持久化不佔 context；失敗只重規劃剩餘。

### P2：ToT Lite（1天）
高不確定性時觸發三路徑評估（方法A/B/C各打分+選擇理由）
觸發條件：risk=high、不可逆操作、工具錯誤>2次

### P3：工具呼叫驗證器（3-5天）
write_file 禁止系統目錄；run_command 危險指令需確認
體現 LLM-Modulo：LLM 不應自我驗證，需外部規則

### 核心原則
「Simple agents with good error recovery beat complex agents without it.」
先 P1 → P2 → P3，不要跳躍。

## 行動

- （依知識內容判斷）
