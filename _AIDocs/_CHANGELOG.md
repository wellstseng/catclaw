# _CHANGELOG.md

> 知識庫變更紀錄（最新在上，超過 8 筆觸發滾動淘汰）

| 日期 | 變更 | 影響文件 |
|------|------|---------|
| 2026-03-20 | **feat: signal file 重啟機制 + 重啟回報 + 錯誤分類**：PM2 監聽 signal/ 目錄，寫入 RESTART 觸發重啟。重啟後自動在觸發頻道回報。acp.ts 錯誤訊息區分 overloaded/502/rate limit/timeout 等。spawn 時傳 CATCLAW_CHANNEL_ID env var | ecosystem.config.cjs, acp.ts, session.ts, index.ts, cron.ts |
| 2026-03-20 | **feat: cron 排程模組**：croner 驅動，支援 cron/every/at 三種模式，config.json hot-reload 支援 | cron.ts, config.ts, config.example.json, package.json |
| 2026-03-19 | feat: acp log 雜訊控制（ACP_TRACE 環境變數）+ prompt 加 displayName 識別多人對話 | acp.ts, discord.ts |
| 2026-03-19 | feat: session 磁碟持久化 — 重啟後自動 resume、TTL 過期機制（預設 7 天）、resume 失敗自動重試、原子寫入 | session.ts, config.ts, index.ts, discord.ts, config.example.json, .gitignore |
| 2026-03-19 | fix: fileMode + MEDIA token 並存時 buffer 未重建，導致文字重複或遺漏；新增 /upload skill | reply.ts |
| 2026-03-19 | 檔案上傳下載：inbound 附件下載至 /tmp、outbound MEDIA token 解析上傳、fileUploadThreshold 長回覆自動轉 .md | discord.ts, reply.ts, config.ts, config.example.json |
| 2026-03-19 | 設定改為 config.json：移除 dotenv/.env、per-channel 設定（allow/requireMention）、showToolCalls 開關、logger.ts log level | config.ts, discord.ts, reply.ts, logger.ts, index.ts, package.json, .gitignore |
| 2026-03-19 | 文件原子化：拆分 6 個模組文件至 modules/、新增 CLI 參考與陷阱速查獨立文件 | modules/*.md, 08-CLAUDE-CLI.md, 09-PITFALLS.md, _INDEX.md |
| 2026-03-19 | 架構文件全面更新：acpx → claude CLI 重寫、串流 diff 機制、typing indicator、turn timeout、10 項陷阱速查 | 01-ARCHITECTURE.md, _INDEX.md |
| 2026-03-18 | 初始建立：專案架構設計完成，含整體資料流、6 模組說明、ACP CLI 指令參考 | _INDEX.md, 01-ARCHITECTURE.md |
