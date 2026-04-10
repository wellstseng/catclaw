---
name: graceful-restart-choice
description: 重啟時可選「立即」或「等對話完成」— 需 agent-loop 活躍追蹤機制
type: project
---

重啟機制需支援兩種模式：立即重啟 vs 等 in-flight agent loop 完成再重啟。

**Why:** 使用者希望重啟不會中斷正在進行的對話，但也保留立即重啟的選項。

**How to apply:**
- 需要在 agent-loop 加活躍連線追蹤（active turn count / Map）
- restart skill 和 dashboard /api/restart 加 `mode` 參數（`immediate` | `graceful`）
- graceful 模式：停止接受新訊息，等所有 active turns 完成後再 SIGTERM
- 相關檔案：`src/index.ts`（shutdown）、`src/skills/builtin/restart.ts`、`src/core/dashboard.ts`（/api/restart）、`src/core/agent-loop.ts`（追蹤）
- 2026-04-07 提出，待 CLI provider 空回應問題解決後實作
