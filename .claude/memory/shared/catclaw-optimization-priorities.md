# catclaw-optimization-priorities

- Scope: shared
- Confidence: [觀]
- Trigger: catclaw優化, 平台改進, agent架構, 優化方向
- Created-at: 2026-05-21

## 知識

### CatClaw 優化優先方向（2026-05 分析）

### P0 立即可做
1. **Post-task Knowledge Distillation**：複雜任務完成後，自主呼叫 atom_write 萃取關鍵知識
2. **Failure Memory**：工具失敗時記錄「失敗類型|發生條件|解法|避免方法」

### P1 近期規劃
3. **Dynamic Skill Loading**：依問題語意只注入相關 skill，減少 system prompt 膨脹
4. **Memory Link Graph**：atom 之間建立 related 連結，cluster 召回
5. **Subagent Result Compression**：subagent 回傳前自己生成執行摘要（500 tokens 以內）

### P2 中長期
6. **Agent Performance Tracking**：追蹤完成率、token 消耗、失敗率
7. **Multi-Agent Peer Review**：重要任務自動 spawn reviewer agent
8. **Proactive Memory Maintenance**：每週掃描過期/重複/高頻 atom，自動管理

### 現有優勢
- CE 壓縮（外部化 stub）已有
- atom memory（語意記憶）已有
- spawn_subagent（並行執行）已有

### 主要缺口
- 無 peer-to-peer agent 通訊
- 無正式 re-planner 機制
- CE 後細節不可恢復，需在 CE 前蒸餾

## 行動

- （依知識內容判斷）
