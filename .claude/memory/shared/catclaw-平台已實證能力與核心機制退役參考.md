# CatClaw 平台已實證能力與核心機制（退役參考）

- Scope: shared
- Author: catclaw-ext-merge
- Confidence: [臨]
- Trigger: CatClaw 已實證能力, PostTurn 反思 hook, 自動除錯循環 重試 3 次, 情節記憶日誌, 長任務評估 guardrail, project/catclaw repo, BRAVE_SEARCH_API_KEY .env, mcp_catclaw-discord_discord, agent-safety-alignment.md
- Created-at: 2026-04-26
- Related: catclaw-optimization-priorities

## 知識

- 2026-06-26 時 CatClaw 已存在，且已實證分層記憶、多 provider 路由、MCP 工具、Discord 前端、自我維護的 hook/skill 等功能。
- CatClaw repo 根目錄在 /Users/wellstseng/project/catclaw；2026-07-01 時 src 內有 205 個 .ts 檔與 16 個頂層模組，關鍵模組含 src/core/、src/memory/、src/skills/，實作 agent loop、skill 系統、subagent、hook、memory。
- CatClaw 的 .env 位於 /Users/wellstseng/project/catclaw/.env；2026-06-02 踩坑：CatClaw process 啟動時不會從這個 .env 載入 BRAVE_SEARCH_API_KEY。
- CatClaw 用 PostTurn 反思 hook：任務失敗後自動生成語言反思並存入原子記憶，作為日後改進依據。
- CatClaw 在程式碼執行失敗時啟動自動除錯循環：run_command 失敗 → 反思 → 重試，最多 3 次。
- CatClaw 有情節記憶日誌：Session 結束後萃取重要事件存成情節記憶原子，用於長期學習與改進。
- CatClaw 平台層會在 prompt 組裝階段自動插入長任務 guardrail / execution reminder（例如「🎯 [平台：長任務評估]」），屬平台自動加入的內部提醒。
- 在 CatClaw 上傳圖片到 Discord 要用 mcp_catclaw-discord_discord 的 send 加 `media: file://路徑`，避免觸發 extra usage。
- 2026-05-21 的 agent 安全研究筆記寫在 /Users/wellstseng/WellsDB/AI進修/catclaw優化/agent-safety-alignment.md，內容依攻擊類型分段，各含機制、範例、防禦。

## 行動

- （依知識內容判斷）
