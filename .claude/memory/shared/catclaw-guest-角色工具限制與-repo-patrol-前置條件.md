# CatClaw guest 角色工具限制與 repo-patrol 前置條件

- Scope: shared
- Author: catclaw-ext-merge
- Confidence: [臨]
- Trigger: guest 角色 工具限制, project-onboard, repo-patrol, patrol-state.md, config_get projects, baseline rev
- Created-at: 2026-07-02

## 知識

- project-onboard 流程需要 `run_command`、`task_manage`、`config_get` 等工具，但 guest 角色被禁止使用這些工具（2026-07-02）。
- 專案記憶目錄的實際路徑要透過 `config_get projects` 確認，guest 角色同樣無法執行（2026-07-02）。
- repo-patrol 執行時從 patrol-state.md 讀取 baseline rev（2026-07-14）。
- /Users/wellstseng/project/CrawlerTool 的 repo-patrol 流程中，若 patrol-state.md 不存在，會回報「請先跑 project-onboard」並結束流程（2026-07-06）。

## 行動

- （依知識內容判斷）
