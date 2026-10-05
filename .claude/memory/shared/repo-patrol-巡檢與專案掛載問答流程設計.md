# repo-patrol 巡檢與專案掛載問答流程設計

- Scope: shared
- Author: catclaw-ext-merge
- Confidence: [臨]
- Trigger: repo-patrol, patrol-state.md, patrol_diff.py, baseline rev, S0-S3 分級, 專案掛載, recall 回讀原檔 file:line
- Tags: legacy-catclaw-path
- Created-at: 2026-07-02

## 知識

- repo-patrol 對目標專案（如 `/Users/wellstseng/project/CrawlerTool`）完全唯讀，不改專案內任何檔案，只更新 patrol-state.md。
- 巡檢的 baseline revision 記在專案記憶目錄的 patrol-state.md；2026-07-02 時 CrawlerTool 的專案記憶目錄為 `~/.catclaw/workspace/agents/wendy/memory/projects/CrawlerTool/`。
- `patrol_diff.py` 分析 repo 的變更，依 diff 產出 S0–S3 分級的巡檢報告。
- 專案掛載生效後，該專案頻道的問答遵循 recall → 回讀原檔 → 附 file:line 的流程（CrawlerTool 於 2026-07-02 掛載生效）。

## 行動

- （依知識內容判斷）
