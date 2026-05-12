description: Use when running long shell scripts (≥5 min expected, e.g. manga_run.py, *_render.py, batch OCR/translate pipelines) — explains why to wrap them in spawn_subagent async, and how to correctly resume after turn timeout.

# 長腳本 spawn + 復原規範

## 何時觸發

當你準備跑會耗時 ≥ 5 分鐘的本地 shell 腳本時，例如：

- `python manga_run.py ...`（manga-translator-ui 主腳本）
- `python *_render.py ...`、`*_inpaint.py`、`detect_bubbles.py` 批次跑
- 長 OCR / 翻譯 / 嵌字 pipeline
- 任何已知會跑 5 分鐘以上的 `run_command`

## 規則 1：用 spawn_subagent async 包，不要直接 run_command

**❌ 錯誤**：直接 `run_command(command="python manga_run.py ...")` — 會佔用你的 turn timer（base 8 分鐘 / 自適應 12 分鐘上限），跑超過會被 abort，且本地腳本可能繼續在背景跑但 catclaw 不知道狀態。

**✅ 正確**：包成 spawn_subagent：
```
spawn_subagent(
  task="cd /path && python manga_run.py ...",
  label="manga-run-page01",
  async=true,
  runtime="default"
)
```
async=true → 你立即拿到 `runId`，腳本在背景跑。catclaw 的 BG wait 會自動在你 end_turn 前等結果回流，最多 6 輪 × 60s。

## 規則 2：使用者回覆「繼續」/ 「resume」時的標準檢查流程

當你看到使用者只回「繼續」、「接續」、「resume」、或在 turn timeout 之後的下一個訊息，**不要直接 end_turn 也不要假設任務還沒做**。先做這三步：

1. **檢查 catclaw subagent registry**：
   - 用 `subagents` 工具 `action=list`，看上個 turn 是否有 spawn 但未消費結果的 runId
2. **檢查檔案系統最新狀態**：
   - 找最近 1 小時內變動的 `runs/*` 目錄、`*_output.png`、`*_05_output.png`、`03_translation.json` 等產出檔
   - 例如：`ls -lt ~/projects/manga-translate/runs/ | head -5`、`find ~/projects/manga-translate -name "*_05_output.png" -mmin -60`
3. **比對 turn 進度**：
   - 如果 (1) 或 (2) 顯示「上次任務其實已完成」→ 直接回報結果，不要重跑
   - 如果只完成一半 → 從中斷點接續，不要從頭再來

## 反例（過去 wendy 踩過）

- ❌ `run_command(python manga_run.py)` 直接跑 8.5 分鐘，turn timeout 被 abort（trace 2c583ba2，2026-05-12 14:51）
- ❌ 使用者回「繼續」後（trace 95aec218），wendy 只 ls 了目錄就 end_turn，沒檢查 `runs/2026-05-12_14-25-29/` 之類最新 dir、沒找 `*_05_output.png`，等於放棄接續判斷

## 正例

- ✅ `spawn_subagent(task="python manga_run.py ch55", label="ch55-batch-run", async=true)` → BG wait 自動處理
- ✅ 使用者回「繼續」 → `subagents action=list` + `ls -lt runs/` + 找最新輸出檔 → 確認 page_01~03 已產出 `_05_output.png` → 回報「上次任務其實已完成，產出在 X」

## 範圍

此 skill 適用所有預期 ≥ 5 分鐘的本地腳本，不限漫畫流程。其他可能場景：大型 build、批次資料處理、ML 訓練、長 ffmpeg 轉檔。
