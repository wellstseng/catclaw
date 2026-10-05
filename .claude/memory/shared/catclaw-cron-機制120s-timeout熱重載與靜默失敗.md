# CatClaw cron 機制：120s timeout、熱重載與靜默失敗

- Scope: shared
- Author: catclaw-ext-merge
- Confidence: [臨]
- Trigger: cron 120s timeout, SIGTERM cron, timeoutSec, cron-jobs.json, src/cron.ts, exec stdout 不回 Discord, claude-acp 逾時, CRON_JOB_IDS.md, fs.watch 熱重載, lastError lastResult
- Created-at: 2026-06-03
- Related: cron-claude-acp-timeout-no-discord-reply

## 知識

- CatClaw cron exec 預設 timeout 是 120 秒，定義在 src/cron.ts:436 的 `const timeout = (timeoutSec ?? 120) * 1000;`，超時的 job 會被 SIGTERM。
- 2026-06-03 原本 07:30 的排程因 run_pipeline.py 執行超過 cron 120s timeout 被 SIGTERM；當時改設 background 排程 `30 7 * * 1-5`（ID `/users/wellstseng/.catclaw/wor-847e6a`）避開 timeout。
- 長時間 job 的 timeout 解法：調高 timeoutSec，同時降低腳本的 --retries 與 --retry-delay，讓 job 能在新的 timeout 視窗內跑完。
- 排程的真實設定存在 /Users/wellstseng/.catclaw/workspace/data/cron-jobs.json，含 timeoutSec、schedule、channelId、lastError 等；`jobs` 欄位是 dict，2026-06-25 時共 20 個 job。
- cron job 狀態欄位有 lastResult、lastError、retryCount、lastRunAtMs；檢查某個 job 是否正常就是看 cron-jobs.json 裡該 key 的 lastRunAtMs、lastError、lastResult。
- cron.ts 用 fs.watch() 加 500ms debounce 熱重載 cron-jobs.json，改檔不需重啟，且會保留執行中 job 的狀態。
- 2026-06-24 建立 CRON_JOB_IDS.md，記錄 job 名稱與 cron-jobs.json 內真實 job ID 的對照。
- CatClaw 的 `exec` 預設不會把 stdout 推回 Discord。
- cron 與 background job 直接執行 shell 指令，不經 LLM 判斷，也不會檢查 skill 規則。
- 2026-06-08 claude-acp 的 cron job 有觸發但因 timeout 失敗，且完全沒送訊息到 Discord；為避免時效性排程靜默失敗，應改用帶 notify 的 agent 型排程，或讓 cron 把失敗通知送到目標頻道。

## 行動

- 設計排程機制時必須有失敗通知，不可讓時效性排程靜默失敗
- 排程跑長時間腳本前先比對腳本的 sleep／retry 累計時間與排程 timeout
