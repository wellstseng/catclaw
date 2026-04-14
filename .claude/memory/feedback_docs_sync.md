---
name: 文件同步規則
description: 腳本/功能異動時必須同步更新 README（中英）、WIKI、_AIDocs 知識庫
type: feedback
originSessionId: 68f985f8-a6e0-4269-b82b-59c67919b9df
---
腳本或功能異動時，相關文件必須同步增刪修補，不可只改程式碼不改文件。

**涵蓋範圍：**
- `README.md`（繁中預設）+ `README.en.md`（英文版）— 兩邊內容必須對等
- `_AIDocs/WIKI.md` — 系統手冊
- `_AIDocs/` 知識庫相關模組文件
- `_AIDocs/_CHANGELOG.md` — 變更紀錄

**Why:** 使用者明確要求：「以後有腳本異動，知識庫、wiki、readme 有相關內容都要準確增刪修補」。文件落差會導致其他團隊成員安裝或使用時踩坑。

**How to apply:** 每次修改涉及功能、工具數量、skill 數量、設定欄位、安裝流程、CLI 指令等內容時，在同一個 commit 中一併更新所有相關文件。README 雙語版本必須保持內容對等。
