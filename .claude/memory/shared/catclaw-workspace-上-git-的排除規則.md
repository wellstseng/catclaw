# CatClaw workspace 上 git 的排除規則

- Scope: shared
- Author: catclaw-ext-merge
- Confidence: [臨]
- Trigger: workspace/sqlite, catclaw.json 不上傳, workspace/.mcp.json, runtime/bridges, tool-outputs 排除, catclaw git staging
- Created-at: 2026-04-28
- Related: catclaw-git-sync-status

## 知識

- `workspace/sqlite/` 內是資料庫檔，不應 commit 進版控（2026-04-28）。
- 2026-06-02 上傳時刻意排除：`catclaw.json`、`workspace/.mcp.json`、`runtime/`、`workspace/data/`、logs 與 SQLite 檔。
- 2026-06-04 的做法：只 stage 特定目錄（碎片原文：`workspace/skills/memory/report`），排除 `runtime/bridges/**`、`workspace/data/tool-outputs/**` 等，避免上傳暫存或敏感資料。

## 行動

- （依知識內容判斷）
