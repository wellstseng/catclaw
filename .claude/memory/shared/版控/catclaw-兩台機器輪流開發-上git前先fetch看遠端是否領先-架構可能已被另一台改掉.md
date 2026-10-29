# catclaw-兩台機器輪流開發-上GIT前先fetch看遠端是否領先-架構可能已被另一台改掉

- Scope: shared
- Author: wellstseng
- Source: session 2026-10-29 catclaw DM bridge 上GIT，commit 63cced9 / 8ef8e66
- Confidence: [臨]
- Trigger: 上GIT, git push, non-fast-forward, rebase, 兩台機器, Windows 機, 遠端領先, fetch, 架構變更, control_request
- Created-at: 2026-10-29

## 知識

- [臨] 2026-10-29：catclaw 在 Mac（運行機）與 Windows（C:\\Projects\\catclaw）兩台輪流開發，Mac 從 10/16 起 19 筆沒 pull，其中含兩筆 cli-bridge 功能（審批改 stdio control_request、「開新對話」口令）。我在舊架構上做完 DM bridge 的審批轉送（MCP request_permission env），push 被擋才發現整個審批架構已被另一台換掉，重做一次。
- [臨] SessionStart 的 Guardian 只報「本地有 N 筆未 push」，不報「遠端領先」；起始 gitStatus 快照也不含 origin 狀態。要自己 `git fetch && git log HEAD..origin/main --oneline` 才看得到。
- [臨] rebase 時記憶檔（.claude/memory）兩機都收割過會衝突：atom 的 Related/Source 行取有 `Source:` 的那邊，_staging stub 取較新日期。

## 行動

- 動 catclaw 核心模組（尤其 cli-bridge）前先 `git fetch` 並看 HEAD..origin/main 有無功能 commit；有就先 rebase 再開工
- 上GIT 流程：fetch → 有遠端領先就 rebase origin/main（本地未 push 的 commit 可 rebase）→ tsc → push
- push 被 non-fast-forward 擋時先看遠端多了哪些檔，若與本次改動重疊要讀懂再合，不要盲解衝突
