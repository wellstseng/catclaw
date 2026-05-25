# modules/health-monitor — 元件健康追蹤與通報

> 檔案：`src/core/health-monitor.ts`
> 引入日期：2026-04-27
> 更新日期：2026-05-26（新增 Log Error Monitor / Restart History 兩節）

## 解決的問題

CatClaw 大量子系統採 **graceful skip**（不掛主流程，繼續跑），但缺乏「失敗達閾值就要通報人類」的機制 → 變成**靜默失敗**：

- Ollama model name 寫錯（`qwen3:14b` 不存在）→ embedding 一直 `OllamaClient 尚未初始化` graceful skip → 12 天無人發現
- memory-extractor flush 22 次無一次成功萃取（model 拿不到）→ 無 ERROR、無紅燈、無通報
- log 看似正常運作，實際關鍵組件全部癱瘓

> 此模組是反「靜默失敗」設計：失敗就計數，連續達門檻就升級 ERROR 並通報。

## 核心 API

```ts
import { recordSuccess, recordFailure, getAllHealth, reportStartupSummary } from "./core/health-monitor.js";

// 在 graceful skip 點呼叫
try {
  await provider.embed(texts);
  recordSuccess("embedding:ollama");
} catch (err) {
  recordFailure("embedding:ollama", err.message);
}

// 啟動時對關鍵 component 跑 verify，集中印紅綠燈摘要
reportStartupSummary([
  { name: "ollama:primary:llm", ok: true,  detail: "model qwen3:1.7b @ http://localhost:11434" },
  { name: "ollama:primary:embedding", ok: false, detail: "model not found" },
]);

// REST API 取所有 component 狀態（dashboard 用）
const all = getAllHealth();
```

## 升級門檻（in-memory，重啟歸零）

| 連續失敗次數 | 狀態     | 動作 |
|-------------|----------|------|
| 1           | healthy → 仍 healthy | 只更新 lastError + 計數 |
| 2           | degraded             | `log.warn` + emit `health:degraded` |
| 5           | unhealthy            | `log.error` + emit `health:critical`（觸發通報） |
| 任何成功    | 從 degraded/unhealthy → healthy | `log.info` + emit `health:recovered` + 清通報節流 |

通報節流：同 component `health:critical` 1 小時內只 emit 一次（避免轟炸）。

## Event Bus 整合

`src/core/event-bus.ts` 新增 4 個事件：

| 事件 | Payload | 觸發時機 |
|------|---------|----------|
| `health:startup`   | `[results: Array<{ name, ok, detail }>]` | `reportStartupSummary()` 被呼叫時（一次） |
| `health:degraded`  | `[name, error]` | 連續失敗達 2 次（首次） |
| `health:critical`  | `[name, error]` | 連續失敗達 5 次 + 1 小時內未通報過 |
| `health:recovered` | `[name]`        | 從 degraded/unhealthy 恢復 healthy |

`src/index.ts` 訂閱這些事件 → Discord errorNotifyChannel：

- `health:startup`（有失敗才送）→ `🩺 Startup Health Summary — N 項失敗`
- `health:critical` → `🚨 Component CRITICAL: \`name\``
- `health:recovered` → `✅ Component 已恢復: \`name\``

## Startup Health Check 流程

`src/core/platform.ts` 在 `_ready = true` 之前呼叫 `runStartupHealthCheck(config)`：

1. **Ollama backend reachability + 各 model 存在性**
   `OllamaClient.verifyAllModels()` → 對每個 enabled backend 跑 `POST /api/show` 驗 llm 與 embedding model
2. **Embedding provider verify**
   `EmbeddingProvider.verify?()` — Ollama 實作會比對 model name 是否在某個 backend；非 Ollama provider 預設假設 ok
3. **Extraction provider verify**
   同上，比對 llm model name

集中印出：

```
[health] ━━━━━━━━━━━━━━━ Startup Health Summary ━━━━━━━━━━━━━━━
[health] ✓ ollama:primary:llm：model qwen3:1.7b @ http://localhost:11434
[health] ✗ ollama:primary:embedding：model "qwen3-embedding:8b" not found on primary
[health] ✓ extraction-provider:ollama：qwen3:1.7b（verify 通過）
[health] ✗ embedding-provider:ollama：無 backend 定義 embedding model "qwen3-embedding:8b"
[health] ━━━━━━━━━━━━━━━ 2 OK / 2 FAIL ━━━━━━━━━━━━━━━
```

**失敗不 throw**：保持 graceful，dashboard 仍可訪問；但 `log.error` + Discord 通報。

## Dashboard 整合

- **GET `/api/health`** → 回 `{ summary, components, startup }`
- **「日誌」tab → 🩺 Component Health 面板**
  - 紅綠燈總覽（healthy/degraded/unhealthy/unknown 計數）
  - 表格列出每個 component（狀態 / 名稱 / 成功 / 失敗 / 連續失敗 / 最後失敗時間 / 最後錯誤訊息）
  - 折疊區塊：啟動健康摘要

## 已接通的 graceful skip 點

| 位置 | Component name |
|------|---------------|
| `OllamaEmbeddingProvider.embed()` | `embedding:ollama` |
| `GoogleEmbeddingProvider.embed()` | `embedding:google` |
| `OllamaExtractionProvider.generate()` / `chat()` | `extraction:ollama`（含「回傳空字串視為 silent fail」判定） |

## 設計決策

- **Component 名稱用 `:` 分層**（`embedding:ollama`、`ollama:primary:llm`），方便 dashboard 排序與 filter
- **Startup 失敗者初始化為 unhealthy + consecutiveFailures = CRITICAL_THRESHOLD**：第一次失敗就視為 critical（避免要再撞 5 次才通報）
- **不寫磁碟**：所有狀態在 memory，重啟歸零（避免 stale 警告誤導）
- **不 throw**：保留 graceful skip 的初衷（不掛主流程），但用「通報」補回可見性

## 附屬子系統：Log Error Monitor

> 檔案：`src/core/log-error-monitor.ts`

與 health-monitor 互補：health-monitor 從**程式內部 graceful skip 點**主動計數失敗；Log Error Monitor 從**外部 PM2 log 檔案**被動偵測 error/crash。前者管「組件靜默失敗」，後者管「任何漏到 log 的錯誤」。兩者共用同一條 Discord 通報路徑（errorNotifyChannel）。

偵測流程：用 `fs.watchFile`（polling，`WATCH_INTERVAL_MS=1000`）監看 log 檔大小，只讀新增 byte 區段逐行比對。log 路徑自動探測 `~/.pm2/logs/catclaw-out.log` → `catclaw-test-out.log`，皆不存在則安靜略過（dev 無 PM2）。

- **Pattern 兩層**：先過 `IGNORE_PATTERNS`（reply-handler streaming edit 失敗 / rate limit / DEBUG 等 false positive），再比對 `ERROR_PATTERNS`（`[error]`、`unhandledRejection`、`uncaughtException`、`FATAL`、`TypeError`/`ReferenceError` 等、`ECONNREFUSED`、stack frame 行）。
- **Context 收集**：`RING_BUFFER_SIZE=30` 行前文 + 命中後再收 `CONTEXT_AFTER_LINES=5` 行（stack trace 不計），log 靜止則 3 秒延遲 flush。
- **Dedup**：以錯誤訊息正規化後（去時間戳、數字歸一）md5 前 12 碼為 key，`DEDUP_WINDOW_MS=30 分鐘`內同 hash 丟棄（per-error dedup，非全域 throttle）。
- **Snapshot**：寫 `{workspace}/data/error-snapshots/{時間}_{hash}.log`。
- **Event**：flush 未被 dedup 的錯誤時 emit `log:error [{ timestamp, message, context, snapshotPath }]`（context 只送 ring buffer 末 15 行）；`index.ts` 訂閱 → errorNotifyChannel `🚨 Log Error 偵測`。
- 生命週期：`initLogErrorMonitor()`（platform.ts 動態 import 啟動）/ `stopLogErrorMonitor()`。所有狀態 in-memory，重啟歸零。

## 附屬子系統：Restart History

> 檔案：`src/core/restart-history.ts`

記錄主進程每次啟動/關閉，排查「不明原因重啟」。核心價值是 **unexpected_termination 偵測**：靠「上一筆有沒有走到 recordShutdown」推斷 OOM / `kill -9` / 系統重啟這類無 graceful shutdown 痕跡的死法。

- **持久化（與 health-monitor 相反：寫磁碟）**：`{resolveCatclawDir()}/logs/restart-history.json`，`MAX_ENTRIES=20` 只留最近 20 筆。價值正在跨重啟保留，才能比對上次 process 收尾狀態。
- **資料結構**：`RestartEntry { pid, startedAt, stoppedAt?, uptimeMs?, reason, signal?, clean, version?, note?, stack? }`，`reason` 含 `running`/`SIGTERM`/`SIGINT`/`uncaughtException`/`unexpected_termination`/`manual_restart`/`api_restart`。
- **Record 時機**（`index.ts`）：`recordStartup()`（啟動最早期，append `running`/`clean:false`）、`recordShutdown(reason, signal)`（SIGINT/SIGTERM handler，補 stoppedAt/uptimeMs/clean=true）、`recordUncaughtException(err)`（標 reason+截斷 3000 字 stack）。
- **unexpected_termination 偵測**：`recordStartup` 發現上一筆仍停在 `running`（無 stoppedAt）→ 補記為 unexpected_termination（uptimeMs 用本次啟動時間回填，為近似值）。pid 防呆：最後一筆 pid 不等於本進程則 append 新筆。
- **Pending Reason**：`setPendingReason("api_restart")` / `getPendingReason()` 讓 dashboard 觸發的重啟與單純信號關閉區分。
- **Dashboard**：`GET /api/restart-history?limit=N`，「日誌」tab 列 started/stopped/uptime/reason（非 clean 紅字、api/manual 橘字）。**不走 event-bus、不發 Discord**，純「寫檔 + dashboard 讀檔」。

| | health-monitor | Log Error Monitor | restart-history |
|---|---|---|---|
| 觀測對象 | 組件層（graceful skip 點） | log 層（PM2 log 錯誤行） | 主進程層（process 生死） |
| 持久化 | 不寫磁碟，重啟歸零 | snapshot 寫檔，dedup 狀態 in-memory | 寫 `restart-history.json` 跨重啟保留 |
| 通報 | emit health:* → Discord | emit log:error → Discord | 無通報，僅 dashboard + log |
| 偵測核心 | 連續失敗達門檻 | log 行 pattern 比對 | 上次沒走 graceful shutdown |

## 相關文件

- `modules/ollama-provider.md` — Ollama Client 的 `verifyModel` / `verifyAllModels` API
- `modules/dashboard.md` — `/api/health` endpoint + 健康面板
- `modules/event-bus.md` — health:* / log:error event 型別
- `modules/platform.md` — `runStartupHealthCheck()` 在啟動序的位置

## 已知限制（後續可改進）

- L1 fail-loud 只覆蓋 Ollama 路徑；非 Ollama provider（Anthropic/OpenAI/Google）尚未實作 verify（目前回 `ok: true`）
- 通報通道是 errorNotifyChannel（Discord channel），不是 owner DM。需要 DM 可改 `index.ts` 訂閱處 fetch user 而非 channel
- 沒有 component-level TTL：unhealthy 會持續到下次成功；不會自動降級為 degraded
