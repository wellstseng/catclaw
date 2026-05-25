# modules/background-jobs — 本地 Shell 長期程式背景追蹤

> 檔案：`src/core/background-job-registry.ts`、`src/core/bg-job-discord-bridge.ts`
> 對應 tool：`src/tools/builtin/run-background-command.ts`、`src/tools/builtin/background-jobs.ts`
> 更新日期：2026-05-26

## 職責

讓 agent 把 ≥ 5 分鐘的本地 shell 程式（ML 訓練、批次翻譯、長 build、ffmpeg 影音轉檔等）丟到背景跑，
立即拿到 `jobId` 後繼續做別的事，完成時自動通知。核心職責：

- **註冊**：`run_background_command` 起 detached process → `registry.create()` 記一筆 `BackgroundJobRecord`
- **狀態追蹤**：每秒 tick 的 poller，按各 job `pollIntervalMs` throttle，檢查 process alive + `expectedOutputs` 齊全
- **完成事件驗證**：用 `OUTPUT_STABLE_MS` 穩定門檻防 `cmd > out.md` 開頭立即建空檔被誤判 completed
- **持久化 + 重啟復原**：寫 `data/jobs/registry.json`，重啟後 running 但 PID 已死標 `stale`
- **通報串接**：完成/失敗 → emit event → agent-loop 接住注入 LLM；parent stream 已退場 → wake 新 turn；wake 失敗 → Discord 文字通知 fallback
- **ACK 機制**：解 LLM silent end_turn 漏報——注入過但沒回報的 job 會被補 wake

> 與 `run_command` 的差別：`run_command` 是 blocking、佔 turn timer、stdout 直接回 result；
> `run_background_command` 非 blocking、立即回 jobId、process 真背景跑、stdout 寫檔、由 poller 監測。

## 主要型別與 class

### BackgroundJobRecord

```typescript
type JobStatus = "running" | "completed" | "failed" | "killed" | "timeout" | "stale";

interface BackgroundJobRecord {
  jobId: string;                 // randomUUID()
  parentSessionKey: string;      // 啟動者 session（事件 relay 比對用）
  label: string;                 // 短標籤，通知與 list 顯示
  command: string;
  cwd?: string;
  status: JobStatus;
  pid?: number;
  expectedOutputs?: string[];    // 預期產出檔絕對路徑；任一缺失 → 視為未完成
  stdoutPath?: string;           // stdout/stderr 持久化檔
  exitCode?: number | null;
  startedAt: number;
  endedAt?: number;
  lastPolledAt?: number;
  pollIntervalMs: number;        // 自我輪詢間隔
  maxDurationMs: number;         // startedAt + maxDurationMs = timeout deadline；0 = 不限時
  discordChannelId?: string;
  accountId?: string;            // wake-agent 重啟新 turn 用
  agentId?: string;              // 多 agent 場景識別
  acked?: boolean;               // ACK 旗標：解 silent end_turn 漏報；undefined = 舊紀錄（不掃）
}
```

### BackgroundJobRegistry 公開方法

| 方法 | 說明 |
|------|------|
| `setEventHandlers({ onComplete, onFail })` | 註冊完成/失敗 callback（platform 接 event-bus + 通報串接） |
| `create(opts)` | 建 record（status=running），回傳；自動 persist |
| `get(jobId)` | 取單筆 |
| `listByParent(parentSessionKey)` | 列某 session 的 job（tool list / ACK scan 用） |
| `listAll()` | 列全部（dashboard 跨 session 用） |
| `listRunning()` | 列 running |
| `deleteJob(jobId)` | 從紀錄移除（不刪 stdout 檔）；running 且 PID 還活著拒刪 |
| `kill(jobId)` | SIGTERM → 2s 後 SIGKILL，標 `killed` |
| `complete(jobId, exitCode)` | 標 `completed`，`acked=false`，觸發 `onComplete` |
| `fail(jobId, reason, exitCode)` | 標 `failed`，`acked=false`，觸發 `onFail` |
| `timeoutJob(jobId)` | SIGTERM + 標 `timeout`，觸發 `onFail("max duration exceeded")` |
| `markAcked(jobId)` | 標 `acked=true`（agent-loop 把結果注入 LLM 且有 reply 時呼叫） |
| `startPoller()` / `stopPoller()` | 啟停每秒 tick 的 setInterval |
| `loadFromDisk()` | 重建記憶；running 但 PID 死 → 標 `stale` |
| `runStartupRecovery(timeWindowMs=1h)` | 掃 1h 內結束的 `acked===false` record，重觸發 handler 補通知 |

模組單例：`initBackgroundJobRegistry()`（loadFromDisk + startPoller）、`getBackgroundJobRegistry()`。

## Job 生命週期與狀態

```
run_background_command tool
  → spawn("bash", ["-c", command], { detached, stdio: stdout 寫檔 })
  → child.unref()                  ← 解 parent 引用，catclaw 重啟 child 仍續跑
  → registry.create()              ← status=running，persist
  → 立即回 { status: "spawned", jobId, pid, stdoutPath }

poller tick（每 1s，按 job.pollIntervalMs throttle）
  ├ maxDurationMs 觸頂           → timeoutJob() → status=timeout（SIGTERM）
  ├ process 死 + outputs 齊/無約定 → complete(null) → status=completed
  ├ process 死 + outputs 不齊      → fail("outputs missing") → status=failed
  └ process 活 + outputs 穩定       → complete(null) → status=completed
                                      （穩定 = 非空 + mtime ≥ 5s 沒變）

complete/fail/timeout → acked=false → onComplete/onFail callback
  → eventBus.emit("background-job:completed|failed")
  → 通報串接（見下）

重啟：loadFromDisk()
  └ running 但 PID 已死 → status=stale（無法判斷成敗）
```

| 狀態 | 觸發 | 含意 |
|------|------|------|
| `running` | create 後 | 程式執行中 |
| `completed` | process 死且 outputs OK／process 活但 outputs 穩定／無 expectedOutputs 約定且 process 死 | 完成（exitCode 不可知時標 null） |
| `failed` | process 死但 expectedOutputs 不齊 | 失敗 |
| `timeout` | 超過 `maxDurationMs` | 逾時被 SIGTERM |
| `killed` | `kill()` 手動終止 | 人為終止 |
| `stale` | 重啟後 running 但 PID 已死 | 無法判定成敗（catclaw 在事件前 crash） |

## 完成判定的穩定性門檻（關鍵）

poller 有兩個 output 檢查：
- `allExpectedOutputsExist`：純存在檢查（process 已死分支用）
- `allExpectedOutputsStable`：存在 + size > 0 + mtime ≥ `OUTPUT_STABLE_MS`（5s）沒變（process 還活著分支用）

第二個門檻是為了修 false-positive：`cmd > out.md` 一啟動 shell 就立刻建 0-byte `out.md`，
純存在檢查會在 poll 第一輪就誤判 completed。兩種檢查都只認絕對路徑，遇到含 `*` / `?` 的 glob 直接回 false。

## 通報串接（與 agent-loop / wake-agent / Discord 的關係）

`platform.ts` 在 `setEventHandlers` 把 callback 接到三層通報，由 `bg-job-discord-bridge.ts` 收底：

```
onComplete / onFail
  ├ 1) eventBus.emit("background-job:completed|failed")
  │     → agent-loop listener（parent turn 還活著）接住 → 注入 LLM messages
  │
  └ 2) setTimeout(300ms)：若 parent stream 已退場（!isParentStreamActive）
        ├ 即時 ping Discord（附 traceId 短碼，避免 wake turn 30-60s 沒訊號）
        ├ wakeAgentForCompletion()（source="background-job"）喚醒新 turn 讓 agent 自報
        └ wake 失敗 → sendBgJobNotification()（bg-job-discord-bridge）走純文字 fallback
```

### agent-loop 注入（parent turn 活著時）

`agent-loop.ts` 監聽 `background-job:completed|failed`，比對 `parentSessionKey === sessionKey`
後 push 進 `pendingJobResults`，下次 LLM 呼叫前注入為 user message，並附**強制驗證 checklist**：
檢查 exitCode、read stdout 尾段找 traceback、確認 expectedOutputs 在磁碟、再依結果分流回報。
注入的 jobId 進 `_injectedJobIds`，turn 結束 finally 判斷：

- `fullResponse` 有內容（有 reply）→ `markAcked()` 全部注入的 job
- `fullResponse` 為空（silent end_turn）→ 不 mark → 掃 `listByParent` 中 `acked===false` 的 final record → 即時 ping + 補 wake；wake 失敗再走 `sendBgJobNotification` fallback

### sendBgJobNotification（bg-job-discord-bridge.ts）

最底層 fallback：直接拿 `getDiscordClient()` 對 `record.discordChannelId` send。

- completed：`✅ 背景 Job 完成：{label}（exitCode）（Ns）` + stdout 路徑 + 預期輸出（最多 3 個）
- failed：`❌ 背景 Job 失敗：…` + reason + stdout 路徑 + **stdout 尾 10 行**（`tailLog`，最多 8KB / 1500 字）

### 重啟復原

`discord.ts` 在 Discord clientReady 後呼叫 `runStartupRecovery()`（1h 時窗）：
catclaw 在 `onComplete` 觸發前 crash → 重啟後 record 已是終態、poller 不再觸發 callback、wake 永不跑。
此方法掃 `acked===false`（明確 false，舊紀錄 undefined 不掃）且 `endedAt` 在 1h 內的終態 record，
重觸發 `onComplete`/`onFail` 補通知（避免對遠古 record 大量補通知打擾使用者）。

## 兩個對應 Tool

### run_background_command（tier: elevated, resultTokenCap: 500）

起 detached `bash -c` process 並背景追蹤，立即回 jobId。

| 參數 | 型別 | 必填 | 說明 |
|------|------|------|------|
| `command` | string | ✅ | shell 指令（bash -c，可含 pipe/heredoc/cd） |
| `label` | string | ✅ | 短標籤，通知與 list 顯示 |
| `cwd` | string | | 工作目錄（省略 = catclaw 預設 cwd） |
| `expectedOutputs` | string[] | | 預期完成必出現的絕對路徑檔案，任一缺失視為未完成 |
| `pollIntervalMs` | number | | poller 檢查間隔，預設 30000 |
| `maxDurationMs` | number | | 最長執行毫秒，超過自動 SIGTERM，預設 0（不限） |

stdout 寫到 `~/.catclaw/workspace/data/jobs/stdout/{時間36進位}-{label}.log`，`child.unref()` 解引用。
回傳 `{ status: "spawned", jobId, pid, stdoutPath, note }`。

### background_jobs（tier: standard, resultTokenCap: 1500）

中段查狀態 / 終止 / 等待。`action`：`list | status | kill | wait`。

| action | 行為 |
|--------|------|
| `list` | 列**本 session**（`listByParent(ctx.sessionId)`）的 job，最多 20 筆 |
| `status` | 印 record + command + pid + expectedOutputs（✓/✗）+ stdout 尾 N 行（`stdoutLines`，預設 50） |
| `kill` | `registry.kill()`，回 `✅ killed` / `❌ 已結束` |
| `wait` | 每 1s poll 至 `status !== running` 或 `timeoutMs`（預設 60000）逾時 |

`jobId` 支援前綴短碼（≥ 4 字元）：先試精確 `get`，再用 `startsWith` 匹配；撞多筆回錯要求補字元。

## 關鍵常數

| 常數 | 值 | 說明 |
|------|----|------|
| `PERSIST_PATH` | `~/.catclaw/workspace/data/jobs/registry.json` | 持久化路徑 |
| `MAX_RETAINED_JOBS` | 200 | persist 時依 startedAt 倒序只留前 200 筆 |
| `DEFAULT_POLL_INTERVAL_MS` | 30_000 | 預設輪詢間隔 |
| `OUTPUT_STABLE_MS` | 5_000 | 「process 活 + output 已到」分支的穩定門檻（防空檔誤判） |
| poller tick | 1_000 | setInterval 每秒跑一次，再按各 job pollIntervalMs throttle |
| wake fallback 延遲 | 300 | onComplete/onFail 後等 300ms 才判 parent stream 是否退場 |
| `runStartupRecovery` 時窗 | 60 × 60_000（1h） | 只補 1h 內結束的 unacked record |

## 與其他模組的關係

- **agent-loop.ts**：監聽 `background-job:completed|failed` → 注入 LLM + 驗證 checklist；turn 結束 finally 做 ACK scan 補 wake
- **platform.ts**：`initBackgroundJobRegistry()` + `setEventHandlers()` 接通三層通報（emit / wake / Discord fallback）
- **event-bus.ts**：`background-job:completed [parentSessionKey, jobId, label, exitCode, stdoutPath?]`、`background-job:failed [parentSessionKey, jobId, label, reason]`
- **wake-agent.ts**：`wakeAgentForCompletion({ source: "background-job" })` 在 parent stream 退場時喚醒新 turn 讓 agent 自報
- **subagent-discord-bridge.ts**：共用 `getDiscordClient()` / `isParentStreamActive()`
- **discord.ts**：clientReady 後呼叫 `runStartupRecovery()`
- **dashboard.ts**：`listAll()` 跨 session 列 job

## 相關文件

- `modules/subagent-system.md` — subagent 編排，與 bg-job 同一套「completed/failed → relay/wake/fallback」pattern
- `modules/event-bus.md` — `background-job:*` event 型別
- `modules/agent-loop.md` — pendingJobResults 注入 + ACK scan + Wake Agent
- `modules/tool-registry.md` — `run_background_command` / `background_jobs` 兩個 builtin tool
