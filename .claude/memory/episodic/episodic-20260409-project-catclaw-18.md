# Session: 2026-04-09 project-catclaw

- Scope: project:-users-wellstseng-project-catclaw
- Confidence: [臨]
- Type: episodic
- Trigger: adapter, agent, agents, alive, asyncqueue, bridge, bridget的歷程, catclaw, child, cli, clibridge, cliprocess
- Last-used: 2026-04-09
- Created: 2026-04-09
- Confirmations: 0
- TTL: 24d
- Expires-at: 2026-05-03

## 摘要

General-focused session (13 prompts). <channel source="plugin:discord:discord" chat_id="1485277764205547630" message_id="1491675581094301918" user="wellstseng" user_id="480042204346449920" ts="2026-04-09T05:46:12.525Z">
繼續 CatClaw Plugin 

## 知識

- [臨] 工作區域: project-catclaw (24 files), tmp-cli-bridge-design.md (1 files), tmp-cli-bridge-design-v2.md (1 files), tmp-cli-bridge-design-v3.md (1 files)
- [臨] 修改 27 個檔案
- [臨] 引用 atoms: decisions
- [臨] CLI Bridge 使用 NDJSON 格式傳送 stdin 訊息，stdout 事件改用 EventEmitter 模式（非 AsyncGenerator）
- [臨] discord.ts 路由判定中，CLI Bridge 檢查優先於 Agent Loop 路徑，依據 catclaw.json 的 cliBridge.chan
- [臨] CliBridge 實作指數退避重啟機制，間隔為 [1s, 2s, 4s, 8s, 16s, 30s]，並每 60s 發送 keep_alive 以防超時
- [臨] CLI Bridge 是第三條訊息路徑，使用持久 process 並以 stream-json 格式傳輸，stdout 事件改用 EventEmitter 模式
- [臨] catclaw.json 設定包含 keepAliveIntervalMs=60000、restartBackoffMs=[1000,2000,...30000
- [臨] CliBridge 采用隊列機制確保單一對話序列化處理，並實作自動重啟（指數退避）與 keep-alive 機制
- [臨] CLI Bridge 作為第三條訊息路徑，優先於 Agent Loop 處理指定頻道的訊息，使用持久 process 並支援 session-id 延續對話
- [臨] CliProcess 用 NDJSON 格式透過 stdin 送訊息，stdout 事件改用 EventEmitter 模式替代 AsyncGenerator 
- [臨] CliBridge 實作自動重啟機制（指數退避 1s~30s）與 keep-alive（60s）確保 process 穩定性，並序列化處理請求避免同時處理多個 
- [臨] CLI Bridge 使用持久 child process（`claude -p --input-format stream-json`）替代 ACP 的 on
- [臨] `CliBridge` 透過 `AsyncQueue` 序列化處理 turn，確保 CLI session 同時只處理一個對話回合
- [臨] `discord.ts` 路由判斷中，CLI Bridge 檢查優先於 Agent Loop 路徑
- [臨] CLI Bridge 路徑：Discord → 路由判斷 → CliBridge.send() → 持久 claude -p --input-format st
- [臨] CliProcess stdin 訊息格式為 NDJSON，含 user message 與 keep_alive 事件
- [臨] stdout 事件解析沿用 acp.ts 邏輯，但改用 EventEmitter 模式處理持久 process
- [臨] CliProcess 類別封裝持久 child process，支援 send()、shutdown()、ping() 方法，stdin 用 NDJSON 格式
- [臨] CliBridge 類別管理生命週期，包含 start()、sendTurn()、restart()、shutdown() 方法，支援排隊機制與自動重啟
- [臨] catclaw.json 設定檔包含 cliBridge 配置，含 enabled、claudeBin、workingDir、channels、keepAliv
- [臨] catclaw.json 中 cliBridge 配置包含 keepAliveIntervalMs 60000 和 restartBackoffMs [1000
- [臨] CliBridge 生命週期包含自動重啟（指數退避 1s~30s）、keep_alive 每 60s、單一 turn 排隊
- [臨] discord.ts 路由判定依據 catclaw.json 設定，每個綁定 channel 對應一個 CliBridge 實例
- [臨] CLI Bridge 路徑在 Agent Loop 前判斷，條件為 `cliBridge` 存在且 `effectiveChannelId` 匹配配置
- [臨] `catclaw.json` 中 `cliBridge.channels` 每個 channel ID 對應獨立 CliBridge 實例，含 `label`/
- [臨] CliProcess 用 `--input-format stream-json` 持續接收 NDJSON 訊息，stdout 事件沿用 ACP 解析邏輯但改用
- [臨] CliProcess 用 NDJSON 格式傳送訊息，stdin 訊息包含 `"type":"user"` 和 `"type":"keep_alive"`
- [臨] CliBridge 有自動重啟機制（指數退避 1s/2s/4s/.../30s）和每 60s 發送 keep_alive 檢查
- [臨] catclaw.json 設定中 `keepAliveIntervalMs` 為 60000，`restartBackoffMs` 為 [1000, 2000,
- [臨] 閱讀 24 個檔案
- [臨] 閱讀區域: project-catclaw (23), tmp-cli-bridge-design-v2.md (1)
- [臨] 版控查詢 3 次
- [臨] 覆轍信號: same_file_3x:cli-bridge.md, same_file_3x:index.ts, same_file_3x:reply.ts, retry_escalation

## 關聯

- 意圖分布: general (8), debug (3), design (2)
- Referenced atoms: decisions

## 閱讀軌跡

- 讀 24 檔: src/core (9), _AIDocs/modules (5), catclaw/src (3), feat+cli-bridge/src (2), .claude/memory (1)
- 版控查詢 3 次

## 行動

- session 自動摘要，TTL 24d 後自動淘汰
- 若需長期保留特定知識，應遷移至專屬 atom

## 演化日誌

| 日期 | 變更 | 來源 |
|------|------|------|
| 2026-04-09 | 自動建立 episodic atom (v2.2) | session:7a6a96b8 |
