# cron-claude-acp-timeout-no-discord-reply

- Scope: shared
- Confidence: [觀]
- Trigger: cron, 排程, claude-acp, 回應逾時, Discord沒回覆, 一次性排程
- Created-at: 2026-06-08
- Related: ext-20260608-0918-排程-id-格式為-請在-discor

## 知識

人：Wells / Wendy。事：2026-06-08 09:15 的一次性 `/cron ... claude` 任務（ID `請在-discord-頻道-1494375171782349-91ac97`）有被 cron runner 嘗試執行，但 `claude-acp` 回應逾時，`lastResult=error`、`lastError=回應逾時，已取消`，因此沒有回覆到 Discord 頻道 1494375171782349042。物：`data/cron-jobs.json` 顯示 `action.type=claude-acp`、`deleteAfterRun=true`、`retryCount=2`；`execClaude` 只在完整回覆完成後送出，timeout 時不會送 partial 或錯誤訊息。規則：時間敏感且必須回頻道的排程，不宜直接依賴 `claude` action；應使用有明確 notify/fallback 的 `agent`/`exec` 或修補 cron 在 ACP timeout/error 時也向 target channel 發送失敗通知。

## 行動

- （依知識內容判斷）
