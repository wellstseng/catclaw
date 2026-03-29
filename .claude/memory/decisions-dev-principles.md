---
name: catclaw-dev-principles
description: CatClaw 開發原則 — 程式碼優先、精準度優先、token 節省
type: project
---

## 原則 1：程式碼驅動優先

CatClaw 開發時，流程與邏輯應優先使用程式碼控制，而非依賴提示詞、模型訓練等不穩定的方式。

**Why:** AI 記憶/提示詞有遺漏風險（2026-03-22 重啟流程連續犯錯的教訓），程式碼是唯一可靠的執行保證。

**How to apply:** 能用程式碼做的就不靠 prompt/記憶。例如：重啟接續用 active-turn file 追蹤而非靠 AI 記得寫 pending-tasks。

## 原則 2：精準度優先、token 節省次之

實作以邏輯準確為方向，行為盡可能由程式碼達成。若有需要可考慮由 AI 觸發工具（skill 等）執行。目標是讓行為符合預期，並最大程度節省 token。若無法省 token 則以精準度為優先。

**Why:** CatClaw 作為 Discord bot，每次 Claude CLI spawn 都消耗 token。但精準度（正確完成使用者需求）比省 token 更重要。

**How to apply:**
- 能程式碼處理的邏輯不丟給 Claude CLI 判斷
- 需要 AI 判斷時，可用 skill/tool 精確觸發，而非靠自然語言 prompt 引導
- 精準度 > token 節省 > 其他

## 原則 3：Git 提交節奏

平台重構分支上，每完成一個 Sprint（驗證通過）才 commit 一次，不以模組為單位提交。

**Why:** 每個 Sprint 是一個完整可驗證的里程碑，按 Sprint commit 保持 git 歷史乾淨、可回溯。

**How to apply:** Sprint 內的模組陸續完成時先不 commit；全部驗證通過後一次性 `git add + commit`，commit message 標明 Sprint 編號。
