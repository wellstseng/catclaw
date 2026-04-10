---
name: catclaw-principles
description: CatClaw 四大設計原則 — 開發時必須遵守的核心約束
type: feedback
---

CatClaw 四大設計原則：

1. **精準記憶** — 已有 atom 系統 + vector recall，不重複建設
2. **省 token** — prompt cache + context 壓縮強化，不浪費 token 在可省的地方
3. **高精密 coding** — extended thinking + 行為約束 + 精密模式
4. **作對的事** — 能用程式邏輯處理的事情不需要用語意來做

**Why:** 第 4 條是核心判斷準則。例如「當前模型是什麼」這類可查的事實，用 config_get 工具查即可，不應注入 system prompt 讓 LLM 用語意處理。system prompt 是行為約束用的，不是塞可查資料的地方。

**How to apply:** 每次修改 catclaw 時，問自己：「這件事能用程式邏輯（工具、API、config 查詢）完成嗎？」能 → 用程式做；不能 → 才用語意處理。任何想往 system prompt 塞「可查資料」的衝動都違反原則 4。
