# catclaw-hook-block-邊界與成本估算歸零坑

- Scope: shared
- Author: wellstseng
- Confidence: [臨]
- Trigger: PreLlmCall, hook block, cost-brake, spend cap, estimatedCostUsd, MODEL_PRICING, hook-registry, observer, 花費上限, 成本估算
- Created-at: 2026-07-02

## 知識

- [臨] hook 可 block 事件僅 6 個：PreToolUse / UserMessageReceived / UserPromptSubmit / AgentResponseReady / PreAtomWrite / PreAtomDelete（src/hooks/hook-registry.ts:175-267 _runBlocking）；PreTurn/PostTurn/PreLlmCall/PostLlmCall/SessionStart 等皆 observer-only（_runObserver，回傳 void、錯誤只 log），規劃 block 型方案前先查此表
- [臨] PreLlmCall payload 無成本欄位（types.ts:117-123 僅 model/provider/promptTokens?/messageCount，agent-loop.ts:1997 實傳連 promptTokens 都沒有）→ cost-brake hook 繞道已實證不可行（Phase B2，見 workspace agents/project-agent/COST-BRAKE-FINDINGS.md）
- [臨] MODEL_PRICING（src/core/message-trace.ts:318-325）缺 claude-opus-4-8 → estimateCost 對未知 model 視為免費，trace 成本估算靜默歸零（2026-07-01 實測 94 calls 日累計 $0）；新模型上線必同步補 pricing 表，修復前任何讀 trace 的花費方案都不可信
- [臨] trace 日檔位置：~/.catclaw/workspace/data/traces/YYYY-MM-DD.jsonl，每筆含 estimatedCostUsd（message-trace.ts:812-820）；核心 backlog 追蹤於 workspace _planning/catclaw-core-backlog.md

## 行動

- 在 catclaw 規劃任何 hook 方案前，先確認目標事件在可 block 清單內
- 碰花費/成本相關需求 → 先查 MODEL_PRICING 是否含當前主力模型，再信任 trace 數字
- 證據基準 catclaw @ b9273fcc，核心改版後需複驗 file:line
