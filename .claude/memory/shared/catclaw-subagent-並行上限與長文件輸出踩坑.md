# CatClaw subagent 並行上限與長文件輸出踩坑

- Scope: shared
- Author: catclaw-ext-merge
- Confidence: [臨]
- Trigger: subagent 並行上限, spawn_subagent 長文件, 8192 token 限制, explore runtime 不能寫, subagent timeout, commit 質性分類 subagent
- Created-at: 2026-05-21

## 知識

- CatClaw 的 subagent 有並行執行上限，達上限時新的 subagent 會被擋住，要等既有的完成才能再開。
- 2026-05-21 的研究任務因並行上限與 timeout 限制，放棄再 spawn 新 subagent，改由 orchestrator 自己直接繼續研究。
- 長文件交給 spawn_subagent 撰寫：subagent 有獨立 context window，可避開主對話 8192 token 的限制。
- 證據蒐集可用 4 個 default subagent 並行以提升效率；`explore` runtime 不能寫檔，需要寫檔的工作不可用它。
- 資料量大且需領域知識判斷的逐筆工作適合交給專門 subagent，例如 2026-07-06 的 359 筆 commit 逐筆質性分類。

## 行動

- 需要 subagent 寫檔時用 default runtime，不要用 explore runtime
