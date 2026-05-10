# Reference: judy bridge 頻道專處理 CatClaw議題追蹤

- Scope: project
- Confidence: [固]
- Trigger: 議題追蹤, CatClaw議題追蹤, judy bridge, 階段議題, 議題頻道, 1498730217278148659
- Last-used: 2026-04-30
- Confirmations: 1

## 知識

- [固] CLI Bridge 頻道 `judy-1498730217278148659` 專門處理 `~/WellsDB/CatClaw議題追蹤/` 路徑下的議題項目
- [固] 議題檔命名：`YYYY-MM-DD_{type}_{title}.md`，type 含 `BUG / 優化 / 議題`
- [固] frontmatter 至少含：`type / priority / status / date / source / decision`
- [固] 處理完成 → `status: closed`、補 `closed-at` 與 `commit`，搬到 `已處理/` 子目錄

## Why

2026-04-29~30 在此頻道完成階段 1（90a00cf）與階段 2（6a16333），流程穩定：讀議題 → Plan Mode → 改 code → tsc → 視情況 /ultrareview → 上 GIT → 搬已處理 → 給下階段 prompt。Wells 2026-04-30 明確說「這個頻道專門處理 CatClaw議題追蹤的項目」。

## 行動

頻道 `judy-1498730217278148659` 收到「階段 N：議題追蹤」類 prompt：
1. 列 `~/WellsDB/CatClaw議題追蹤/` 下 open 議題
2. 讀每件「處理紀錄 / 修正方案」段確認 decision
3. Plan Mode → 改 code（tsc 過）→ 視風險決定 /ultrareview → 上 GIT
4. 議題改 status=closed + closed-at + commit hash，搬到 `已處理/`
5. 給下階段 prompt（繁中、code block 包起來）
