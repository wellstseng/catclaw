# CatClaw V2 — 訊息流 + Context Engineering 計劃

- Scope: project
- Confidence: [固]
- Trigger: V2, catclaw v2, context engineering, inbound history, CE, compaction, token追蹤, turn audit, session snapshot, rollback, /stop
- Last-used: 2026-03-26
- Confirmations: 2

## 知識

- [固] V2 計劃文件路徑：`~/.catclaw/workspace/_planning/catclaw-v2-message-context-plan.md`（v0.4）
- [固] V2 在 V1（platform-rebuild S1-S14）驗收後才開始實作
- [固] V2 聚焦三個根本缺口：Context Engineering / Tool History 不完整 / Channel 脈絡盲區

### V2 核心子系統

| 子系統 | 說明 |
|--------|------|
| ContextEngine | Strategy Pattern，可插拔策略（Compaction/BudgetGuard/SlidingWindow） |
| TurnAuditLog | 每 turn 完整快照：token 消耗 / CE 觸發 / inbound 注入量 / 時間分解 |
| ToolLogStore | tool results 外存 log 檔，session history 只存索引行 |
| InboundHistoryStore | 頻道訊息日誌（不進 agent loop 的訊息），時間衰退三 bucket |
| SessionSnapshot | 每 turn 前快照，/stop 強殺 + 自動回退，CE 壓縮快照保留 48h |

### CE 設計要點

- Strategy Pattern：`ContextEngine.register(strategy)` 插拔
- 全域 `contextEngineering.model`（建議 haiku），各 agent 可覆寫
- 每個 strategy 各自獨立開關，可 A/B 比較
- Token 追蹤整合進 TurnAuditLog，`/turn-audit` skill 查詢

### Inbound History 時間衰退

- Bucket A（< 24h）：全量帶入（程式）
- Bucket B（24~168h）：LLM 壓縮 → 超 600 token → Decay II 截斷重壓（程式）→ 上限 300 token
- Bucket C（> 168h）：直接清除（程式）
- 時間閾值透過設定檔設定（小時為單位）
- 消費後刪除 entries（不留 consumed 標記）

### /stop 與 /rollback

- `/stop`：強殺當前 turn（不等 tool call）+ 自動回退 session 至本 turn 開始前快照
- `/rollback`：turn 正常完成但 CE 壓縮語義損失，手動還原（快照保留 48h）
- `/queue`：查看 TurnQueue 狀態；`/queue clear`：清空排隊

### 平台前綴

- session key：`{platform}:ch:{channelId}`（取代 `ch:{channelId}`）
- 持久化檔名：`discord_ch_111.json` / `discord_ch_111.jsonl`

### Sprint 順序（建議）

S-V2-6（平台前綴）→ S-V2-2（TurnAuditLog）→ S-V2-1（ContextEngine）→ S-V2-3（ToolLogStore）→ S-V2-4+5（InboundHistory+Discord）→ S-V2-7（Snapshot+/stop）→ S-V2-8（Extract）→ S-V2-9（整合測試）
