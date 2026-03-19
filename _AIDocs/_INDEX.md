# claude_discord _AIDocs 知識庫索引

> 建立日期：2026-03-18 | 最近更新：2026-03-19 | 專案：discord-claude-bridge

## 專案簡介

輕量獨立的 Discord → Claude Code CLI bridge。
Discord 收訊 → claude -p stream-json → 串流回覆 Discord。
不依賴 OpenClaw，僅使用 discord.js + claude CLI。

## 文件清單

| 文件 | 主題 | 更新日期 |
|------|------|---------|
| [01-ARCHITECTURE.md](01-ARCHITECTURE.md) | 整體架構 + 資料流 + 專案結構 | 2026-03-19 |
| [08-CLAUDE-CLI.md](08-CLAUDE-CLI.md) | Claude CLI 指令格式 + stream-json event 規格 | 2026-03-19 |
| [09-PITFALLS.md](09-PITFALLS.md) | 10 項陷阱速查（實際除錯經驗） | 2026-03-19 |
| [PLAN.md](PLAN.md) | 初始實作計畫（已完成） | 2026-03-18 |
| [_CHANGELOG.md](_CHANGELOG.md) | 知識庫變更紀錄 | 2026-03-19 |

### modules/ — 模組詳細說明

| 文件 | 對應原始碼 | 主題 |
|------|-----------|------|
| [modules/config.md](modules/config.md) | `src/config.ts` | JSON 設定載入、per-channel helper |
| [modules/acp.md](modules/acp.md) | `src/acp.ts` | Claude CLI spawn、串流 diff、AcpEvent 型別 |
| [modules/session.md](modules/session.md) | `src/session.ts` | Session 快取、per-channel 串行佇列、timeout |
| [modules/reply.md](modules/reply.md) | `src/reply.ts` | Discord 回覆分段、code fence 平衡、typing |
| [modules/discord.md](modules/discord.md) | `src/discord.ts` | Discord Client、訊息過濾、debounce |
| [modules/logger.md](modules/logger.md) | `src/logger.ts` | Log level 控制、setLogLevel |
| [modules/index.md](modules/index.md) | `src/index.ts` | 進入點、啟動順序、優雅關閉 |

## 架構一句話摘要

Discord 訊息 → debounce → `claude -p --output-format stream-json --resume` → diff 串流 → 2000 字分段回覆 Discord
