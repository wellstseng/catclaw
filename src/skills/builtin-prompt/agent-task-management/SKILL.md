description: Use when receiving a complex task (multi-step / multi-target / long-running) — explains how to decompose, fan-out via parallel spawn_subagent, dispatch long scripts via run_background_command, and MUST verify each result before reporting done.

# 複雜任務管理規範

收到任何看起來「步驟多」、「目標多」、「會跑久」的任務時，先停下來判斷三件事：能不能拆？能不能並行？要不要丟背景？

## Step 1：拆解（Decomposition）

收到複雜任務不要直接從第一步開始做，先快速判斷拆解：

- 任務有 **N 個目標** 嗎？（如「翻譯 5 個 chapter」、「分析 8 個 module」）→ 拆成 N 個子任務
- 子任務之間 **是否有依賴**？
  - **獨立**（如「並行分析 5 個 module」）→ 走 Step 2 並行
  - **有依賴**（如「先翻譯再嵌字」）→ sequential，但每步仍可在內部找並行機會

如果任務模糊（「整理一下這專案」），先用 1-2 個唯讀工具偵測（ls/find/read）拆出具體子任務，再執行。

## Step 2：並行 fan-out（Parallel Spawn）

對 ≥ 2 個**獨立**子任務，**同一次 LLM 回應內**輸出多個 `spawn_subagent` tool_use block。catclaw 會自動 `Promise.all` 並行執行（`agent-loop.ts:1907`）。

**反例**：
```
[iter 1] spawn_subagent(task="分析 module-a")
... 等完成 ...
[iter 2] spawn_subagent(task="分析 module-b")
... 等完成 ...
```
這是 sequential，每個 task 跑 30 秒就要 N × 30 秒。

**正例**：
```
[iter 1] 同時輸出：
  - spawn_subagent(task="分析 module-a", async=true, label="analyze-a")
  - spawn_subagent(task="分析 module-b", async=true, label="analyze-b")
  - spawn_subagent(task="分析 module-c", async=true, label="analyze-c")
```
parallel，總時間 ≈ 單一最慢的 task。

## Step 3：長腳本走 background（≥ 5 分鐘）

shell 長期程式（manga_translator、ML 訓練、批次處理、ffmpeg、大型 build）絕不用 `run_command`（會佔 turn timer，超 8/12 分鐘就被 abort）。

用 `run_background_command`：
```
run_background_command(
  command="cd /path && python manga_run.py ...",
  label="manga-ch56",
  expectedOutputs=["/abs/path/ch56-translated/page_43_*.png"],
  pollIntervalMs=30000,
  maxDurationMs=3600000
)
```
立即拿到 `jobId`，process 真背景跑。完成（process exit 或 expectedOutputs 齊全）會自動注入下次 turn + Discord 通知。

## Step 4：驗證每個結果（**強制**，不可跳過）

收到 subagent 結果 / background job 完成事件 / 任何長 tool 回傳，**先驗證再回報**：

| 結果類型 | 驗證項 |
|---------|--------|
| `spawn_subagent` 完成 | 讀回傳 result 內容、檢查是否錯誤訊息、檢查 expectedOutputs 在磁碟存在 |
| `run_background_command` 完成 | 檢查 `exitCode`、`read_file` 讀 stdoutPath 尾段確認沒 traceback、確認 expectedOutputs 全部存在 |
| 一般 `run_command` | exitCode == 0？output 有沒有 error/exception/traceback 字眼？產出檔存在？ |

**驗證後分流：**
- ✅ 全綠 → 回報成果（檔案路徑 / 數量 / 摘要）
- ⚠️ 部分成功 → 列「完成 X / 失敗 Y」，附失敗原因，問使用者要不要重試
- ❌ 全失敗 → 給根因分析（讀 stdout / log）+ 建議下一步，**不要假裝完成**

## 反例（過去 wendy 踩過）

- ❌ trace `2c583ba2`：直接 `run_command` 跑 8.5 分鐘 manga_run.py，turn timeout 中止
- ❌ trace `95aec218`：回「繼續」後只 `ls` 一下就 end_turn，沒驗證 prior progress
- ❌ trace `42da7b71`：3 張漫畫頁丟一個 subagent 跑（sequential 失機會），應該 fan-out 3 個並行

## 正例

- ✅ 「分析 5 個 module」→ 一次 emit 5 個 spawn_subagent async，~30s 全部完成
- ✅ 「跑 manga ch56 全本翻譯」→ `run_background_command` + expectedOutputs=[最後一頁 path]，wendy 繼續做別的
- ✅ background job 完成事件到 → read stdoutPath tail 30 行 → 確認沒 traceback → 列已產出檔案 → 回報「✅ 完成 43 頁，已產出 X，可進下一個 chapter」
